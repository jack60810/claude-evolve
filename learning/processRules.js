#!/usr/bin/env node
// processRules.js — Background processor for LLM-powered rule learning
// Spawned by session-end.js as a detached process.
//
// Full pipeline:
//   1. Strategy selection (repair/reinforce/explore/distill)
//   2. Correction-based rule creation
//   3. Fitness evaluation
//   4a. Observation-based pattern analysis (from full tool call records)
//   4b. Legacy behavior pattern analysis (fallback)
//   5. Pruning
//   6. Distillation
//   7. Reflection (every 5 sessions)
//   8. Compress observations → session memory .md + narrative
//   9. Write CLAUDE.md + changelog

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const PROCESS_LOG = path.join(DATA_DIR, 'process.log');
const NARRATIVE_LOG = path.join(DATA_DIR, 'narrative.jsonl');
const SESSION_COUNTER = path.join(DATA_DIR, 'session_counter.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(PROCESS_LOG, line, 'utf8'); } catch {}
}

function getSessionCount(project) {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_COUNTER, 'utf8'));
    return data[project] || 0;
  } catch { return 0; }
}

function incrementSessionCount(project) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(SESSION_COUNTER, 'utf8')); } catch {}
  data[project] = (data[project] || 0) + 1;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_COUNTER, JSON.stringify(data, null, 2), 'utf8');
  return data[project];
}

function readRecentChangelog(maxEntries) {
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, 'changelog.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    return lines.slice(-(maxEntries || 10)).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function readRecentNarratives(maxEntries) {
  try {
    const lines = fs.readFileSync(NARRATIVE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(maxEntries || 10)).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

async function main() {
  // Accept pending file path as CLI argument (supports concurrent sessions)
  const pendingFile = process.argv[2] || PENDING_PATH;
  log('processRules started (pending: ' + path.basename(pendingFile) + ')');

  // Read pending data
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (err) {
    log('No pending data or parse error: ' + (err.message || err));
    return;
  }

  if (!pending || !pending.project) {
    log('Invalid pending data, skipping');
    return;
  }

  const { project, newMemories, observations, sessionBehavior, recentSessions, existingActiveRules, handWrittenContent } = pending;
  log(`Project: ${project}, memories: ${(newMemories || []).length}, observations: ${(observations || []).length}, existing rules: ${(existingActiveRules || []).length}`);

  const ruleEngine = require('./ruleEngine');
  const claudeMdWriter = require('./claudeMdWriter');
  const llmBrain = require('./llmBrain');

  const sessionNum = incrementSessionCount(project);
  log(`Session #${sessionNum} for this project`);

  // =====================================================================
  // STEP 1: Strategy Selection
  // =====================================================================
  let strategy = 'reinforce'; // default
  try {
    const stratResult = llmBrain.selectStrategy(
      sessionBehavior, newMemories, recentSessions, existingActiveRules
    );
    if (stratResult && stratResult.strategy) {
      strategy = stratResult.strategy;
      log(`Strategy: ${strategy} — ${stratResult.reason || ''}`);
    }
  } catch (stratErr) {
    log(`Strategy selection failed, defaulting to reinforce: ${stratErr.message || stratErr}`);
  }

  const newRuleIds = new Set();
  let rulesAdded = 0;
  let behaviorRulesAdded = 0;
  let conflictsFound = 0;
  const correctionTexts = [];

  // =====================================================================
  // STEP 2: Correction-based rule creation (all strategies except 'explore')
  // =====================================================================
  if (strategy !== 'explore') {
    for (const mem of (newMemories || [])) {
      try {
        log(`Extracting rule from: ${mem.name}`);
        const extracted = llmBrain.extractRule(mem);

        if (!extracted || !extracted.rule) {
          log(`  Extraction failed for: ${mem.name}. Got: ${JSON.stringify(extracted)}`);
          continue;
        }

        const ruleContent = extracted.rule;
        const keywords = extracted.keywords || [];
        correctionTexts.push(ruleContent + ' ' + (mem.content || ''));
        log(`  Extracted: "${ruleContent.slice(0, 80)}"`);

        // Conflict check
        log(`  Checking conflict...`);
        const conflictCheck = llmBrain.checkConflict(ruleContent, handWrittenContent || '');

        if (!conflictCheck) {
          log(`  Conflict check failed, skipping`);
          continue;
        }

        log(`  Decision: ${conflictCheck.decision} — ${conflictCheck.reason || ''}`);

        if (conflictCheck.decision === 'duplicate') {
          log(`  Skipped (duplicate)`);
          ruleEngine.logChange({
            action: 'skip_duplicate', project,
            content: ruleContent.slice(0, 300), reason: conflictCheck.reason,
          });
          continue;
        }

        if (conflictCheck.decision === 'conflict') {
          ruleEngine.addConflict(project, ruleContent, conflictCheck.conflicts_with || '', 1.0);
          conflictsFound++;
          log(`  Saved as conflict`);
          continue;
        }

        // Check duplicate against existing auto-learned rules
        if (ruleEngine.isDuplicate(project, keywords)) {
          log(`  Skipped (duplicate of auto-learned)`);
          continue;
        }

        const rule = ruleEngine.addRule(project, ruleContent, 'correction', keywords);
        newRuleIds.add(rule.id);
        rulesAdded++;
        log(`  Added rule: ${rule.id}`);
      } catch (memErr) {
        log(`  Error processing "${mem.name}": ${memErr.message || memErr}`);
      }
    }
  } else {
    log('Strategy=explore: skipping rule creation, observing only');
  }

  // =====================================================================
  // STEP 3: Fitness evaluation
  // =====================================================================
  const currentRules = ruleEngine.getActiveRules(project).filter(r => !newRuleIds.has(r.id));

  if (currentRules.length > 0 && correctionTexts.length > 0) {
    log(`Evaluating fitness: ${currentRules.length} rules vs ${correctionTexts.length} corrections`);
    try {
      const matchResult = llmBrain.matchCorrections(correctionTexts, currentRules);
      if (matchResult && Array.isArray(matchResult.matches)) {
        const data = ruleEngine.loadRules();
        const matchedIds = new Set();

        for (const match of matchResult.matches) {
          const rule = data.rules.find(r => r.id === match.rule_id);
          if (!rule || rule.status !== 'active') continue;
          matchedIds.add(rule.id);

          if (match.confidence === 'high' || match.confidence === 'medium') {
            const penalty = match.confidence === 'high' ? -2 : -1;
            rule.fitness += penalty;
            rule.last_evaluated = new Date().toISOString().slice(0, 10);
            rule.sessions_evaluated += 1;
            log(`  ${rule.id}: fitness ${penalty} (${match.confidence}) → ${rule.fitness}`);
          } else {
            rule.fitness += 1;
            rule.last_evaluated = new Date().toISOString().slice(0, 10);
            rule.sessions_evaluated += 1;
          }
        }

        // Unmentioned rules get +1
        for (const rule of data.rules) {
          if (rule.project === project && rule.status === 'active'
              && !newRuleIds.has(rule.id) && !matchedIds.has(rule.id)) {
            rule.fitness += 1;
            rule.last_evaluated = new Date().toISOString().slice(0, 10);
            rule.sessions_evaluated += 1;
          }
        }
        ruleEngine.saveRules(data);
      }
    } catch (fitErr) {
      log(`Fitness error: ${fitErr.message || fitErr}`);
      ruleEngine.evaluateFitness(project, [], new Set());
    }
  } else if (currentRules.length > 0) {
    log('No corrections, all rules get +1');
    ruleEngine.evaluateFitness(project, [], new Set());
  }

  // =====================================================================
  // STEP 4a: Observation-based pattern analysis (from full tool call records)
  // =====================================================================
  let observationAnalysis = null;
  let hasUsablePatterns = false;
  if (strategy !== 'explore' && (observations || []).length >= 3) {
    log(`Analyzing ${observations.length} observations for patterns...`);
    try {
      const currentActive = ruleEngine.getActiveRules(project);
      observationAnalysis = llmBrain.analyzeObservations(observations, currentActive, handWrittenContent || '');

      // Check if analysis returned usable results (not just { raw: "..." } from JSON fail)
      hasUsablePatterns = observationAnalysis
        && (Array.isArray(observationAnalysis.patterns) || Array.isArray(observationAnalysis.anti_patterns));

      if (hasUsablePatterns) {
        // Collect all candidate rules (patterns + anti-patterns) for batch conflict check
        const candidates = [];
        for (const pattern of (observationAnalysis.patterns || [])) {
          if (!pattern.rule || pattern.confidence === 'low') continue;
          const keywords = pattern.keywords || [];
          if (ruleEngine.isDuplicate(project, keywords)) {
            log(`  Obs pattern skip (dup): "${pattern.rule.slice(0, 60)}"`);
            continue;
          }
          candidates.push({ rule: pattern.rule, keywords, source: 'observation', confidence: pattern.confidence });
        }
        for (const ap of (observationAnalysis.anti_patterns || [])) {
          if (!ap.rule || ap.confidence === 'low') continue;
          const keywords = ap.keywords || [];
          if (ruleEngine.isDuplicate(project, keywords)) {
            log(`  Anti-pattern skip (dup): "${ap.rule.slice(0, 60)}"`);
            continue;
          }
          candidates.push({ rule: ap.rule, keywords, source: 'anti_pattern', confidence: ap.confidence });
        }

        // Batch conflict check (1 LLM call instead of N)
        if (candidates.length > 0) {
          const batchResult = llmBrain.checkConflictBatch(
            candidates.map(c => c.rule),
            handWrittenContent || ''
          );
          const results = (batchResult && batchResult.results) || [];

          for (let i = 0; i < candidates.length; i++) {
            const cand = candidates[i];
            const check = results.find(r => r.index === i) || { decision: 'new' };

            if (check.decision === 'duplicate') {
              log(`  ${cand.source} skip (dup of handwritten): "${cand.rule.slice(0, 60)}"`);
              continue;
            }
            if (check.decision === 'conflict') {
              ruleEngine.addConflict(project, cand.rule, check.conflicts_with || '', 1.0);
              conflictsFound++;
              log(`  ${cand.source} conflict: "${cand.rule.slice(0, 60)}"`);
              continue;
            }

            const rule = ruleEngine.addRule(project, cand.rule, cand.source, cand.keywords);
            log(`  ${cand.source} rule: ${rule.id} (${cand.confidence}) "${cand.rule.slice(0, 60)}"`);
            behaviorRulesAdded++;
          }
        }
      }
    } catch (obsErr) {
      log(`Observation analysis error: ${obsErr.message || obsErr}`);
    }
  }

  // =====================================================================
  // STEP 4b: Behavior pattern analysis — legacy (from aggregated stats)
  // Only runs if observation analysis didn't already cover it
  // =====================================================================
  if (!hasUsablePatterns && (strategy === 'reinforce' || strategy === 'repair') && sessionBehavior && sessionBehavior.toolCalls >= 5) {
    log(`Analyzing behavior (legacy): ${sessionBehavior.toolCalls} calls, phases=[${(sessionBehavior.workflowPhases || []).join(',')}]`);
    try {
      const currentActive = ruleEngine.getActiveRules(project);
      const patternResult = llmBrain.analyzeSessionPatterns(sessionBehavior, recentSessions, currentActive);

      if (patternResult && Array.isArray(patternResult.patterns)) {
        for (const pattern of patternResult.patterns) {
          if (!pattern.rule || pattern.confidence === 'low') continue;

          const keywords = pattern.keywords || [];
          if (ruleEngine.isDuplicate(project, keywords)) {
            log(`  Pattern skip (dup): "${pattern.rule.slice(0, 60)}"`);
            continue;
          }

          const conflict = ruleEngine.detectConflict(pattern.rule, handWrittenContent || '');
          if (conflict.hasConflict) {
            ruleEngine.addConflict(project, pattern.rule, conflict.conflictsWith, conflict.similarity);
            conflictsFound++;
            continue;
          }

          const rule = ruleEngine.addRule(project, pattern.rule, 'behavior', keywords);
          log(`  Behavior rule: ${rule.id} (${pattern.confidence}) "${pattern.rule.slice(0, 60)}"`);
          behaviorRulesAdded++;
        }
      }
    } catch (patErr) {
      log(`Behavior analysis error: ${patErr.message || patErr}`);
    }
  }

  // =====================================================================
  // STEP 5: Pruning
  // =====================================================================
  const pruned = ruleEngine.pruneRules(project);
  if (pruned.length > 0) log(`Pruned ${pruned.length} rules`);

  // =====================================================================
  // STEP 6: Distillation (distill strategy or 8+ active rules)
  // =====================================================================
  const preDistillActive = ruleEngine.getActiveRules(project);
  if (strategy === 'distill' || preDistillActive.length >= 8) {
    log(`Distilling ${preDistillActive.length} rules (strategy=${strategy})`);
    try {
      const distillResult = llmBrain.tryDistill(preDistillActive);
      if (distillResult && distillResult.should_distill && Array.isArray(distillResult.groups)) {
        const data = ruleEngine.loadRules();
        for (const group of distillResult.groups) {
          if (!group.source_ids || group.source_ids.length < 2 || !group.merged_rule) continue;

          for (const srcId of group.source_ids) {
            const src = data.rules.find(r => r.id === srcId);
            if (src) src.status = 'distilled';
          }

          const maxFitness = Math.max(...group.source_ids.map(id => {
            const r = data.rules.find(x => x.id === id);
            return r ? r.fitness : 0;
          }));

          data.rules.push({
            id: ruleEngine.generateId(), project,
            type: 'rule', content: group.merged_rule, source: 'distillation',
            keywords: group.merged_keywords || [],
            fitness: maxFitness,
            created: new Date().toISOString().slice(0, 10),
            last_evaluated: new Date().toISOString().slice(0, 10),
            sessions_evaluated: 0, status: 'active',
            distilled_from: group.source_ids,
          });

          log(`  Distilled ${group.source_ids.length} → "${group.merged_rule.slice(0, 80)}"`);
          ruleEngine.logChange({
            action: 'distill_rules', project,
            distilled_from: group.source_ids, content: group.merged_rule.slice(0, 300),
          });
        }
        ruleEngine.saveRules(data);
      }
    } catch (distErr) {
      log(`Distillation error: ${distErr.message || distErr}`);
    }
  }

  // =====================================================================
  // STEP 7: Reflection (every 5 sessions)
  // =====================================================================
  if (sessionNum % 5 === 0) {
    log(`Reflection triggered (session #${sessionNum})`);
    try {
      const allActive = ruleEngine.getActiveRules(project);
      if (allActive.length > 0) {
        const narratives = readRecentNarratives(5);
        const changelog = readRecentChangelog(10);
        const reflectResult = llmBrain.reflectOnRules(allActive, narratives, changelog);

        if (reflectResult && Array.isArray(reflectResult.insights)) {
          const data = ruleEngine.loadRules();
          for (const insight of reflectResult.insights) {
            log(`  Reflection [${insight.action}] ${insight.rule_ids.join(',')} — ${insight.reason}`);

            if (insight.action === 'remove') {
              for (const id of insight.rule_ids) {
                const r = data.rules.find(x => x.id === id && x.status === 'active');
                if (r) {
                  r.status = 'reflected_out';
                  ruleEngine.logChange({
                    action: 'reflection_remove', rule_id: id, project,
                    reason: insight.reason, content: r.content.slice(0, 200),
                  });
                }
              }
            }

            if (insight.action === 'revise' && insight.revised_content) {
              for (const id of insight.rule_ids) {
                const r = data.rules.find(x => x.id === id && x.status === 'active');
                if (r) {
                  const oldContent = r.content;
                  r.content = insight.revised_content;
                  r.keywords = ruleEngine.extractKeywords(insight.revised_content);
                  ruleEngine.logChange({
                    action: 'reflection_revise', rule_id: id, project,
                    reason: insight.reason,
                    old_content: oldContent.slice(0, 200),
                    new_content: insight.revised_content.slice(0, 200),
                  });
                }
              }
            }

            if (insight.action === 'merge' && insight.rule_ids.length >= 2 && insight.revised_content) {
              for (const id of insight.rule_ids) {
                const r = data.rules.find(x => x.id === id && x.status === 'active');
                if (r) r.status = 'reflected_merged';
              }
              const maxFit = Math.max(...insight.rule_ids.map(id => {
                const r = data.rules.find(x => x.id === id);
                return r ? r.fitness : 0;
              }));
              data.rules.push({
                id: ruleEngine.generateId(), project,
                type: 'rule', content: insight.revised_content, source: 'reflection',
                keywords: ruleEngine.extractKeywords(insight.revised_content),
                fitness: maxFit,
                created: new Date().toISOString().slice(0, 10),
                last_evaluated: new Date().toISOString().slice(0, 10),
                sessions_evaluated: 0, status: 'active',
                merged_from: insight.rule_ids,
              });
              ruleEngine.logChange({
                action: 'reflection_merge', project,
                merged_from: insight.rule_ids, content: insight.revised_content.slice(0, 200),
              });
            }
          }
          ruleEngine.saveRules(data);
        }
      }
    } catch (refErr) {
      log(`Reflection error: ${refErr.message || refErr}`);
    }
  }

  // =====================================================================
  // STEP 8: Compress observations → session memory .md
  // (replaces old narrateSession — compressSession generates both summary and narrative)
  // =====================================================================
  let sessionId = null;
  if ((observations || []).length >= 3) {
    log('Compressing session to memory...');
    try {
      const sessionMemory = require('./sessionMemory');
      sessionId = sessionMemory.generateSessionId();

      // Collect rule changes for context
      const rulesChanged = [];
      if (rulesAdded > 0) rulesChanged.push({ action: 'added', content: `${rulesAdded} correction rules` });
      if (behaviorRulesAdded > 0) rulesChanged.push({ action: 'added', content: `${behaviorRulesAdded} observation rules` });
      if (pruned.length > 0) rulesChanged.push({ action: 'pruned', content: `${pruned.length} rules` });

      const compressed = llmBrain.compressSession(observations, newMemories, rulesChanged);
      const projectName = path.basename(project);

      if (compressed && compressed.summary) {
        // Write narrative to narrative.jsonl (backward compat with reflection step)
        try {
          const narrativeEntry = {
            timestamp: new Date().toISOString(),
            project,
            strategy,
            narrative: compressed.index_line || compressed.summary.split('\n')[0] || '',
          };
          fs.appendFileSync(NARRATIVE_LOG, JSON.stringify(narrativeEntry) + '\n', 'utf8');
        } catch {}

        // Write session .md (Tier 2 + Tier 3)
        const sessionPath = sessionMemory.writeSession(sessionId, compressed, observations, {
          project: projectName,
          toolCalls: (observations || []).length,
          strategy,
          rulesAdded: rulesAdded + behaviorRulesAdded,
          rulesPruned: pruned.length,
        });
        log(`  Session memory: ${sessionPath}`);

        // Append to index.md (Tier 1)
        const indexLine = compressed.index_line || `${(observations || []).length} tool calls, ${strategy} strategy`;
        sessionMemory.appendIndex(sessionId, indexLine, (observations || []).length, projectName);
        log(`  Index updated: ${indexLine}`);
      } else {
        log('  Compression returned empty summary, skipping memory write');
      }
    } catch (memErr) {
      log(`Session memory error: ${memErr.message || memErr}`);
    }
  }

  // =====================================================================
  // STEP 9: Write CLAUDE.md + summary
  // =====================================================================
  const finalActive = ruleEngine.getActiveRules(project);
  const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, finalActive);
  log(`Wrote ${finalActive.length} rules to ${writtenPath || 'none'}`);

  ruleEngine.logChange({
    action: 'session_end_summary', project, strategy,
    session_number: sessionNum,
    memories_found: (newMemories || []).length,
    observations_count: (observations || []).length,
    rules_added: rulesAdded,
    behavior_rules_added: behaviorRulesAdded,
    conflicts_found: conflictsFound,
    rules_pruned: pruned.length,
    active_rules: finalActive.length,
    claude_md_updated: !!writtenPath,
    session_memory_id: sessionId,
  });

  // Remove pending file (session-specific or default)
  try { fs.unlinkSync(pendingFile); } catch {}

  log(`Done [${strategy}]: +${rulesAdded} corrections, +${behaviorRulesAdded} behavior(obs), ${conflictsFound} conflicts, ${pruned.length} pruned, ${finalActive.length} active, memory=${sessionId || 'none'}`);
}

main().catch(err => {
  log(`FATAL: ${err.stack || err.message || err}`);
});
