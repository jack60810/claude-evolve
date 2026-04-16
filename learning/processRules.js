#!/usr/bin/env node
// processRules.js — Evolver-style learning pipeline
//
// Signal → Gene → LLM Execute → Validate → Solidify
//
// Signal: What happened in this session? (corrections, observations, quiet)
// Gene: What action to take? (repair / innovate / optimize / cleanup)
//   - repair:   corrections detected → extract new rules from feedback
//   - innovate: patterns/anti-patterns detected → extract rules from observations
//   - optimize: LLM evaluates all active rules, scores them, demotes bad ones
//   - cleanup:  too many rules → LLM merges and simplifies
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
// SIGNAL EXTRACTION (no LLM — simple heuristics)
// =====================================================================

function extractSignals(newMemories, observations, activeRuleCount) {
  const signals = [];

  if ((newMemories || []).length > 0) signals.push('correction');
  if ((observations || []).length >= 5) signals.push('significant_session');
  if ((observations || []).length >= 3) signals.push('has_observations');
  if (activeRuleCount >= 8) signals.push('many_rules');
  if (activeRuleCount === 0) signals.push('empty');

  return signals;
}

// =====================================================================
// GENE SELECTION (no LLM — signal matching)
// =====================================================================

function selectGene(signals, sessionCount) {
  // Priority order: repair > innovate > optimize > cleanup
  if (signals.includes('correction')) return 'repair';
  if (signals.includes('has_observations') && signals.includes('empty')) return 'repair'; // Bootstrap: treat observations as repairs when empty
  if (signals.includes('has_observations')) return 'innovate';
  if (signals.includes('many_rules')) return 'cleanup';

  // Periodic optimize: every 3 sessions without corrections
  if (sessionCount > 0 && sessionCount % 3 === 0) return 'optimize';

  return 'observe'; // Just record, don't act
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

  // --- Signal ---
  const signals = extractSignals(newMemories, observations, stats.active);
  const gene = selectGene(signals, sessionCount);
  log(`Signals: [${signals.join(', ')}] → Gene: ${gene}`);

  let rulesAdded = 0;
  let conflictsFound = 0;

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

        ruleEngine.addRule(project, ruleContent, 'correction', keywords, 'active');
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
            ruleEngine.addRule(project, p.rule, src, p.keywords, 'active');
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
            ruleEngine.addRule(project, p.rule, 'observation', p.keywords, status);
            rulesAdded++;
            log(`  Added [observation] as ${status}: "${p.rule.slice(0, 60)}"`);
          }
          for (const p of (obsResult.anti_patterns || [])) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const status = stats.active < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate';
            ruleEngine.addRule(project, p.rule, 'anti_pattern', p.keywords, status);
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
              ruleEngine.addRule(project, action.merged_rule, 'cleanup', action.keywords, 'active');
              log(`  Merged ${action.source_ids.length} → "${action.merged_rule.slice(0, 60)}"`);
            }
            if (action.type === 'rewrite' && action.rule_id && action.new_content) {
              const r = data.population.find(x => x.id === action.rule_id);
              if (r) {
                r.content = action.new_content;
                r.keywords = ruleEngine.extractKeywords(action.new_content);
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

  // gene === 'observe' → no LLM calls, just record

  // --- Validate (only if we changed something) ---
  if (rulesAdded > 0 || gene === 'optimize' || gene === 'cleanup') {
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

  // --- Solidify: write CLAUDE.md ---
  const finalActive = ruleEngine.getActiveRules(project);
  const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, finalActive);
  log(`Solidified: ${finalActive.length} rules → ${writtenPath || 'CLAUDE.md'}`);

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
    action: 'session_complete', project, gene,
    session: sessionCount, signals,
    rules_born: rulesAdded, conflicts: conflictsFound,
    population: finalStats,
  });

  try { fs.unlinkSync(pendingFile); } catch {}

  log(`Done [${gene}]: session=${sessionCount} born=${rulesAdded} active=${finalStats.active} dormant=${finalStats.dormant}`);
}

main().catch(err => { log(`FATAL: ${err.stack || err.message || err}`); });
