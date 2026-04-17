#!/usr/bin/env node
// processRules.js — Signal-gene learning pipeline
//
// Signal → Gene → LLM Execute → Validate → Solidify
//
// Signal: What happened in this session? (corrections, observations, quiet)
// Gene: What action to take? (repair / innovate / optimize / cleanup / skillify)
//   - repair:   corrections detected → extract new rules from feedback
//   - innovate: patterns/anti-patterns detected → extract rules from observations
//   - optimize: LLM evaluates all active rules, scores them, demotes bad ones
//   - cleanup:  too many rules → LLM merges and simplifies
//   - skillify: 3+ related high-score rules → re-classify complexity, promote to skill files
// Execute: LLM performs the gene's action
// Validate: LLM checks the resulting rule set for conflicts and consistency
// Solidify: Write to CLAUDE.md + session memory

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const PROCESS_LOG = path.join(DATA_DIR, 'process.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(PROCESS_LOG, line, 'utf8'); } catch {}
}

// =====================================================================
// TRIAGE FALLBACK (if LLM triage fails, use simple heuristics)
// =====================================================================

function fallbackTriage(newMemories, observations, activeRuleCount, sessionCount, highScoreGroups) {
  let gene = 'observe';
  if ((newMemories || []).length > 0) gene = 'repair';
  else if ((observations || []).length >= 3 && activeRuleCount === 0) gene = 'repair';
  else if ((observations || []).length >= 5) gene = 'innovate';
  else if ((highScoreGroups || 0) > 0) gene = 'skillify';
  else if (activeRuleCount >= 8) gene = 'cleanup';
  else if (sessionCount > 0 && sessionCount % 3 === 0) gene = 'optimize';
  return { gene, complexity: 'routine', reason: 'fallback heuristic' };
}

// =====================================================================
// GENE EXECUTION (LLM calls)
// =====================================================================

async function main() {
  const pendingFile = process.argv[2] || PENDING_PATH;
  log('processRules started');

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (err) {
    log('No pending data: ' + (err.message || err));
    return;
  }
  if (!pending || !pending.project) { log('Invalid pending'); return; }

  const { project, newMemories, observations, handWrittenContent } = pending;
  log(`Project: ${path.basename(project)}, memories: ${(newMemories || []).length}, obs: ${(observations || []).length}`);

  const ruleEngine = require('./ruleEngine');
  const claudeMdWriter = require('./claudeMdWriter');
  const llmBrain = require('./llmBrain');

  const sessionCount = ruleEngine.incrementSession(project);
  const activeRules = ruleEngine.getActiveRules(project);
  const stats = ruleEngine.getPopulationStats(project);
  log(`Session #${sessionCount} | active=${stats.active} dormant=${stats.dormant} dead=${stats.dead}`);

  // --- Count high-score rules for skillify (group by project type, not keyword) ---
  const highScoreRules = activeRules.filter(r => (r.score || 0) > 7 && (r.relevance_count || 0) >= 5);
  const highScoreGroups = highScoreRules.length >= 3 ? 1 : 0;

  // --- Triage: LLM decides gene + complexity ---
  let gene = 'observe';
  let complexity = 'routine';
  try {
    const triageResult = llmBrain.triage(observations, newMemories, stats.active, sessionCount, highScoreGroups);
    if (triageResult && triageResult.gene) {
      gene = triageResult.gene;
      complexity = triageResult.complexity || 'routine';
      log(`Triage (LLM): gene=${gene} complexity=${complexity} — ${triageResult.reason || ''}`);
    } else {
      const fb = fallbackTriage(newMemories, observations, stats.active, sessionCount, highScoreGroups);
      gene = fb.gene; complexity = fb.complexity;
      log(`Triage (fallback): gene=${gene}`);
    }
  } catch (err) {
    const fb = fallbackTriage(newMemories, observations, stats.active, sessionCount, highScoreGroups);
    gene = fb.gene; complexity = fb.complexity;
    log(`Triage error, using fallback: gene=${gene} — ${err.message || err}`);
  }

  // Model tier for gene execution: routine → haiku, complex → sonnet
  const tier = complexity === 'complex' ? 'smart' : 'fast';
  log(`Model tier: ${tier} (${complexity})`);

  let rulesAdded = 0;
  let conflictsFound = 0;
  const sessionRuleIds = new Set(); // Track rule IDs born/modified this session

  // --- Execute gene ---
  if (gene === 'repair') {
    // Extract rules from corrections
    for (const mem of (newMemories || [])) {
      try {
        const extracted = llmBrain.extractRule(mem);
        if (!extracted || !extracted.rule) continue;

        const ruleContent = extracted.rule;
        const keywords = extracted.keywords || [];
        log(`  Extracted: "${ruleContent.slice(0, 80)}"`);

        if (ruleEngine.isDuplicate(project, keywords)) { log('  Skip (dup)'); continue; }

        // Conflict check
        const conflict = llmBrain.checkConflict(ruleContent, handWrittenContent || '');
        if (conflict && conflict.decision === 'duplicate') { log('  Skip (dup of hand-written)'); continue; }
        if (conflict && conflict.decision === 'conflict') {
          ruleEngine.addConflict(project, ruleContent, conflict.conflicts_with || '', 1.0);
          conflictsFound++;
          log('  Conflict saved');
          continue;
        }

        const added = ruleEngine.addRule(project, ruleContent, 'correction', keywords, 'active');
        sessionRuleIds.add(added.id);
        rulesAdded++;
        log(`  Added [correction]: "${ruleContent.slice(0, 60)}"`);
      } catch (err) { log(`  Error: ${err.message}`); }
    }

    // Also extract from observations during repair if population is small
    if (stats.active < 3 && observations && observations.length >= 3) {
      try {
        const obsResult = llmBrain.analyzeObservations(observations, ruleEngine.getActiveRules(project), handWrittenContent);
        if (obsResult) {
          for (const p of [...(obsResult.patterns || []), ...(obsResult.anti_patterns || [])]) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const src = (obsResult.anti_patterns || []).includes(p) ? 'anti_pattern' : 'observation';
            const added = ruleEngine.addRule(project, p.rule, src, p.keywords, 'active');
            sessionRuleIds.add(added.id);
            rulesAdded++;
            log(`  Added [${src}]: "${p.rule.slice(0, 60)}"`);
          }
        }
      } catch (err) { log(`  Observation error: ${err.message}`); }
    }
  }

  if (gene === 'innovate') {
    // Extract patterns and anti-patterns from observations
    if (observations && observations.length >= 3) {
      try {
        log('Analyzing observations for patterns...');
        const obsResult = llmBrain.analyzeObservations(observations, activeRules, handWrittenContent);
        if (obsResult) {
          for (const p of (obsResult.patterns || [])) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const status = stats.active < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate';
            const added = ruleEngine.addRule(project, p.rule, 'observation', p.keywords, status);
            sessionRuleIds.add(added.id);
            rulesAdded++;
            log(`  Added [observation] as ${status}: "${p.rule.slice(0, 60)}"`);
          }
          for (const p of (obsResult.anti_patterns || [])) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const status = stats.active < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate';
            const added = ruleEngine.addRule(project, p.rule, 'anti_pattern', p.keywords, status);
            sessionRuleIds.add(added.id);
            rulesAdded++;
            log(`  Added [anti_pattern] as ${status}: "${p.rule.slice(0, 60)}"`);
          }
        }
      } catch (err) { log(`  Innovation error: ${err.message}`); }
    }
  }

  if (gene === 'optimize') {
    // LLM evaluates all active rules: score 0-10, suggest changes
    const currentActive = ruleEngine.getActiveRules(project);
    if (currentActive.length > 0) {
      try {
        log(`Optimizing ${currentActive.length} active rules...`);
        const evalResult = llmBrain.evaluateRuleSet(currentActive, observations, newMemories);

        if (evalResult && Array.isArray(evalResult.evaluations)) {
          const changes = ruleEngine.applyScores(project, evalResult.evaluations);
          for (const c of changes) {
            log(`  ${c.rule_id.slice(0, 12)}: ${c.old_score} → ${c.new_score} (LLM: ${c.llm_score}) ${c.reason}`);
          }

          // Re-evaluate complexity for rules whose score just crossed the >7 threshold
          for (const change of changes) {
            if (change.new_score > 7 && change.old_score <= 7) {
              const rule = currentActive.find(r => r.id === change.rule_id);
              if (rule && (rule.relevance_count || 0) >= 5) {
                const related = ruleEngine.getRelatedRules(project, rule, 0.2)
                  .filter(r => (r.score || 0) > 7);
                if (related.length >= 2) {
                  try {
                    const group = [rule, ...related];
                    const newComplexity = llmBrain.classifyComplexity(
                      { content: group.map(r => r.content).join('\n'), keywords: [...new Set(group.flatMap(r => r.keywords || []))] },
                      currentActive,
                      pending.projectType || ''
                    );
                    const levels = ['simple', 'compound', 'workflow', 'methodology'];
                    const currentLevel = levels.indexOf(rule.complexity || 'simple');
                    const newLevel = levels.indexOf(newComplexity);
                    if (newLevel > currentLevel) {
                      ruleEngine.updateComplexity(project, rule.id, newComplexity);
                      sessionRuleIds.add(rule.id);
                      log(`  Optimize-promote ${rule.id.slice(0,12)}: ${rule.complexity || 'simple'} → ${newComplexity}`);
                    }
                  } catch (err) {
                    log(`  Optimize-promote error: ${err.message}`);
                  }
                }
              }
            }
          }
        }

        // Apply lifecycle: demote low, promote candidates, kill old dormant
        const lifecycle = ruleEngine.applyLifecycle(project, sessionCount);
        if (lifecycle.demoted.length) log(`  Demoted: ${lifecycle.demoted.length}`);
        if (lifecycle.promoted.length) log(`  Promoted: ${lifecycle.promoted.length}`);
        if (lifecycle.killed.length) log(`  Killed: ${lifecycle.killed.length}`);

        // Revive dormant rules if LLM suggests
        if (evalResult && Array.isArray(evalResult.revive)) {
          const data = ruleEngine.loadPopulation();
          for (const id of evalResult.revive) {
            const r = data.population.find(x => x.id === id && x.status === 'dormant');
            if (r) {
              r.status = 'active';
              r.score = 5; // Reset to neutral
              ruleEngine.logChange({ action: 'revived', rule_id: id, project });
              log(`  Revived: ${r.content.slice(0, 40)}`);
            }
          }
          ruleEngine.savePopulation(data);
        }
      } catch (err) { log(`  Optimize error: ${err.message}`); }
    }
  }

  if (gene === 'cleanup') {
    // LLM merges and simplifies the rule set
    const currentActive = ruleEngine.getActiveRules(project);
    if (currentActive.length >= 5) {
      try {
        log(`Cleaning up ${currentActive.length} rules...`);
        const cleanResult = llmBrain.cleanupRules(currentActive);

        if (cleanResult && Array.isArray(cleanResult.actions)) {
          const data = ruleEngine.loadPopulation();
          for (const action of cleanResult.actions) {
            if (action.type === 'merge' && action.merged_rule && action.source_ids) {
              // Demote sources, add merged
              for (const id of action.source_ids) {
                const r = data.population.find(x => x.id === id);
                if (r) r.status = 'dormant';
              }
              ruleEngine.savePopulation(data);
              const added = ruleEngine.addRule(project, action.merged_rule, 'cleanup', action.keywords, 'active');
              sessionRuleIds.add(added.id);
              log(`  Merged ${action.source_ids.length} → "${action.merged_rule.slice(0, 60)}"`);
            }
            if (action.type === 'rewrite' && action.rule_id && action.new_content) {
              const r = data.population.find(x => x.id === action.rule_id);
              if (r) {
                r.content = action.new_content;
                r.keywords = ruleEngine.extractKeywords(action.new_content);
                sessionRuleIds.add(r.id); // Rewritten counts as modified
                log(`  Rewritten: "${action.new_content.slice(0, 60)}"`);
              }
            }
            if (action.type === 'remove' && action.rule_id) {
              const r = data.population.find(x => x.id === action.rule_id);
              if (r) { r.status = 'dormant'; log(`  Removed: "${r.content.slice(0, 40)}"`); }
            }
          }
          ruleEngine.savePopulation(data);
        }
      } catch (err) { log(`  Cleanup error: ${err.message}`); }
    }
  }

  if (gene === 'skillify') {
    // P1: Group ALL high-score rules in this project as one methodology group.
    // No keyword similarity needed — same project type = same methodology.
    const currentActive = ruleEngine.getActiveRules(project);
    const matureRules = currentActive.filter(r =>
      (r.score || 0) > 7 && (r.relevance_count || 0) >= 5
    );

    if (matureRules.length >= 3) {
      log(`  Skillify: ${matureRules.length} mature rules in project → methodology`);
      const data = ruleEngine.loadPopulation();

      for (const r of matureRules) {
        const currentLevel = ['simple', 'compound', 'workflow', 'methodology'].indexOf(r.complexity || 'simple');
        if (currentLevel < 3) { // not yet methodology
          const popRule = data.population.find(x => x.id === r.id);
          if (popRule) {
            popRule.complexity = 'methodology';
            sessionRuleIds.add(r.id);
            log(`  Promoted ${r.id.slice(0,12)}: ${r.complexity || 'simple'} → methodology`);
          }
        }
      }
      ruleEngine.savePopulation(data);
    } else {
      log(`  Skillify: only ${matureRules.length} mature rules (need 3+), skipping`);
    }
  }

  // gene === 'observe' → no LLM calls, just record

  // --- Validate (only if we changed something) ---
  if (rulesAdded > 0 || gene === 'optimize' || gene === 'cleanup' || gene === 'skillify') {
    // Quick validation: check the final active set isn't self-contradictory
    const finalActive = ruleEngine.getActiveRules(project);
    if (finalActive.length > 0 && handWrittenContent) {
      for (const rule of finalActive) {
        const conflict = ruleEngine.detectConflict(rule.content, handWrittenContent);
        if (conflict.hasConflict) {
          log(`  Validate: conflict detected for ${rule.id}, demoting`);
          const data = ruleEngine.loadPopulation();
          const r = data.population.find(x => x.id === rule.id);
          if (r) {
            r.status = 'dormant';
            ruleEngine.addConflict(project, rule.content, conflict.conflictsWith, conflict.similarity);
          }
          ruleEngine.savePopulation(data);
        }
      }
    }
  }

  // --- P2: Lightweight scoring every session (not just during optimize) ---
  // Quick evaluation: let LLM score all active rules against this session's observations.
  // This ensures rules accumulate scores naturally without waiting for triage to pick optimize.
  if (gene !== 'optimize' && observations && observations.length >= 3) {
    const scorableRules = ruleEngine.getActiveRules(project);
    if (scorableRules.length > 0) {
      try {
        log(`Quick-score: evaluating ${scorableRules.length} rules against session...`);
        const evalResult = llmBrain.evaluateRuleSet(scorableRules, observations, newMemories);
        if (evalResult && Array.isArray(evalResult.evaluations)) {
          const changes = ruleEngine.applyScores(project, evalResult.evaluations);
          const meaningful = changes.filter(c => Math.abs(c.new_score - c.old_score) > 0.3);
          if (meaningful.length > 0) {
            for (const c of meaningful) {
              log(`  Quick-score ${c.rule_id.slice(0, 12)}: ${c.old_score} → ${c.new_score}`);
            }
          }
        }
      } catch (err) { log(`Quick-score error: ${err.message}`); }
    }
  }

  // --- Solidify: classify complexity + route output ---
  const finalActive = ruleEngine.getActiveRules(project);

  // Classify complexity for rules born/modified this session only
  if (sessionRuleIds.size > 0) {
    const data = ruleEngine.loadPopulation();
    let classified = 0;
    for (const rule of data.population) {
      if (!sessionRuleIds.has(rule.id)) continue;
      // Skip rules that already have a complexity field
      if (rule.complexity) continue;
      try {
        rule.complexity = llmBrain.classifyComplexity(rule, finalActive, pending.projectType || '');
        classified++;
        log(`  Classified ${rule.id.slice(0, 12)}: ${rule.complexity}`);
      } catch (err) {
        rule.complexity = 'simple'; // safe fallback
        log(`  Classify error for ${rule.id.slice(0, 12)}: ${err.message}, defaulting to simple`);
      }
    }
    if (classified > 0) ruleEngine.savePopulation(data);
  }

  // Partition rules: methodology → skillWriter, others → claudeMdWriter
  let skillWriter;
  try { skillWriter = require('./skillWriter'); } catch { skillWriter = null; }

  const methodologyRules = finalActive.filter(r => r.complexity === 'methodology');
  const otherRules = finalActive.filter(r => r.complexity !== 'methodology');

  // P4: Auto-learn — regenerate skill when rules change (new rules born, scores shift)
  // A skill should always reflect the LATEST state of the methodology.
  const shouldRegenSkill = skillWriter && methodologyRules.length > 0 && (
    rulesAdded > 0 ||                    // New rules were born this session
    gene === 'skillify' ||               // Skillify just promoted rules
    gene === 'cleanup' ||                // Cleanup merged/rewrote rules
    sessionRuleIds.size > 0              // Any rules were modified
  );

  if (skillWriter && methodologyRules.length > 0) {
    try {
      let allMemories = [];
      let sessionNarratives = [];
      try {
        const memoryReader = require('./memoryReader');
        allMemories = memoryReader.getAllMemories(project);
      } catch {}
      try {
        const narrativePath = path.join(DATA_DIR, 'narrative.jsonl');
        if (fs.existsSync(narrativePath)) {
          sessionNarratives = fs.readFileSync(narrativePath, 'utf8').trim().split('\n')
            .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
      } catch {}

      if (shouldRegenSkill) {
        // Regenerate: rules changed, skill needs to reflect latest state
        log(`  Skill auto-update: regenerating (trigger: ${rulesAdded > 0 ? 'new rules' : gene === 'skillify' ? 'promotion' : 'rule changes'})`);
        const primary = methodologyRules[0];
        const related = methodologyRules.slice(1);
        const result = skillWriter.writeSkill(project, primary, related, pending.projectType || '', allMemories, sessionNarratives);
        if (result && result.written) log(`  Skill file: ${result.path}`);
        else if (result) log(`  Skill skipped: ${result.reason || 'unknown'}`);
      } else {
        log(`  Skill unchanged (no rule changes this session)`);
      }
      log(`Solidified: ${methodologyRules.length} methodology rules → skill`);
    } catch (err) {
      log(`skillWriter error: ${err.message}, falling back to claudeMdWriter`);
      otherRules.push(...methodologyRules);
    }
    const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, otherRules);
    log(`Solidified: ${otherRules.length} rules → ${writtenPath || 'CLAUDE.md'}`);
  } else {
    const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, finalActive);
    log(`Solidified: ${finalActive.length} rules → ${writtenPath || 'CLAUDE.md'}`);
  }

  // --- Skill hints + cross-project store (extracted to modules) ---
  const skillHints = require('./skillHints');
  const crossProjectStore = require('./crossProjectStore');
  skillHints.updateHints(methodologyRules, log);
  crossProjectStore.savePatterns(project, finalActive, (pending && pending.projectType) || 'general', log);

  // --- Session memory ---
  try {
    const sessionMemory = require('./sessionMemory');
    const sessionId = sessionMemory.generateSessionId();

    if (observations && observations.length >= 3) {
      const compressResult = llmBrain.compressSession(observations, newMemories, []);
      if (compressResult && compressResult.summary) {
        sessionMemory.writeSession(sessionId, compressResult, observations, {
          project, toolCalls: observations.length, strategy: gene, rulesAdded, rulesPruned: 0,
        });
        sessionMemory.appendIndex(sessionId,
          compressResult.index_line || compressResult.summary.split('\n')[0].slice(0, 100),
          observations.length, path.basename(project));
        log(`Memory: ${sessionId}`);
      }
    }
  } catch (err) { log(`Memory error: ${err.message}`); }

  // --- Log ---
  const finalStats = ruleEngine.getPopulationStats(project);
  ruleEngine.logChange({
    action: 'session_complete', project, gene, complexity,
    session: sessionCount,
    rules_born: rulesAdded, conflicts: conflictsFound,
    population: finalStats,
  });

  try { fs.unlinkSync(pendingFile); } catch {}

  log(`Done [${gene}]: session=${sessionCount} born=${rulesAdded} active=${finalStats.active} dormant=${finalStats.dormant}`);
}

main().catch(err => { log(`FATAL: ${err.stack || err.message || err}`); });
