#!/usr/bin/env node
// processRules.js — Genetic Algorithm pipeline for rule evolution
//
// Per-session:
//   1. Birth new rules from corrections + observations (as candidates)
//   2. Relevance-aware fitness scoring (LLM evaluates each active rule)
//   3. Session memory compression
//
// Per-generation (every GENERATION_SIZE sessions):
//   4. Tournament selection (bottom rules demoted)
//   5. Crossover (combine high-fitness rules)
//   6. Mutation (create rule variants)
//   7. Immigration (revive dormant rules)
//   8. Promote candidates to active
//   9. Reflection (every 2 generations)
//   10. Write active rules to CLAUDE.md

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const PROCESS_LOG = path.join(DATA_DIR, 'process.log');
const NARRATIVE_LOG = path.join(DATA_DIR, 'narrative.jsonl');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(PROCESS_LOG, line, 'utf8'); } catch {}
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
  const pendingFile = process.argv[2] || PENDING_PATH;
  log('processRules started (pending: ' + path.basename(pendingFile) + ')');

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (err) {
    log('No pending data: ' + (err.message || err));
    return;
  }

  if (!pending || !pending.project) {
    log('Invalid pending data');
    return;
  }

  const { project, newMemories, observations, sessionBehavior, recentSessions, handWrittenContent } = pending;
  log(`Project: ${project}, memories: ${(newMemories || []).length}, observations: ${(observations || []).length}`);

  const ruleEngine = require('./ruleEngine');
  const claudeMdWriter = require('./claudeMdWriter');
  const llmBrain = require('./llmBrain');

  let rulesAdded = 0;
  let conflictsFound = 0;

  const stats = ruleEngine.getPopulationStats(project);
  log(`Population: gen=${stats.generation} active=${stats.active} candidate=${stats.candidate} dormant=${stats.dormant} dead=${stats.dead}`);

  // =====================================================================
  // STEP 1: Birth new rules from corrections (as CANDIDATES, not active)
  // =====================================================================
  for (const mem of (newMemories || [])) {
    try {
      const extracted = llmBrain.extractRule(mem);
      if (!extracted || !extracted.rule) continue;

      const ruleContent = extracted.rule;
      const keywords = extracted.keywords || [];
      log(`  Extracted: "${ruleContent.slice(0, 80)}"`);

      // Conflict check against hand-written rules
      const conflictCheck = llmBrain.checkConflict(ruleContent, handWrittenContent || '');
      if (conflictCheck && conflictCheck.decision === 'duplicate') {
        log(`  Skip (duplicate): ${conflictCheck.reason || ''}`);
        continue;
      }
      if (conflictCheck && conflictCheck.decision === 'conflict') {
        ruleEngine.addConflict(project, ruleContent, conflictCheck.conflicts_with || '', 1.0);
        conflictsFound++;
        log(`  Conflict saved`);
        continue;
      }

      if (ruleEngine.isDuplicate(project, keywords)) {
        log(`  Skip (dup in population)`);
        continue;
      }

      // Born as CANDIDATE — must earn its way to active via tournament
      // Exception: if population has < 3 active rules, go directly to active (bootstrap)
      const activeCount = ruleEngine.getActiveRules(project).length;
      const initialStatus = activeCount < 3 ? 'active' : 'candidate';
      ruleEngine.addRule(project, ruleContent, 'correction', keywords, initialStatus);
      rulesAdded++;
      log(`  Born as ${initialStatus}: "${ruleContent.slice(0, 60)}"`);
    } catch (err) {
      log(`  Error: ${err.message || err}`);
    }
  }

  // =====================================================================
  // STEP 2: Birth rules from observation analysis (as CANDIDATES)
  // =====================================================================
  if (observations && observations.length >= 3) {
    try {
      log(`Analyzing ${observations.length} observations...`);
      const activeRules = ruleEngine.getActiveRules(project);
      const obsResult = llmBrain.analyzeObservations(observations, activeRules, handWrittenContent);

      if (obsResult) {
        for (const pattern of (obsResult.patterns || [])) {
          if (!pattern.rule || pattern.confidence === 'low') continue;
          const kw = pattern.keywords || [];
          if (ruleEngine.isDuplicate(project, kw)) continue;
          ruleEngine.addRule(project, pattern.rule, 'observation', kw, 'candidate');
          rulesAdded++;
          log(`  Observation candidate: "${pattern.rule.slice(0, 60)}"`);
        }
        for (const ap of (obsResult.anti_patterns || [])) {
          if (!ap.rule || ap.confidence === 'low') continue;
          const kw = ap.keywords || [];
          if (ruleEngine.isDuplicate(project, kw)) continue;
          ruleEngine.addRule(project, ap.rule, 'anti_pattern', kw, 'candidate');
          rulesAdded++;
          log(`  Anti-pattern candidate: "${ap.rule.slice(0, 60)}"`);
        }
      }
    } catch (err) {
      log(`Observation analysis error: ${err.message || err}`);
    }
  }

  // =====================================================================
  // STEP 3: Relevance-aware fitness scoring
  // =====================================================================
  const activeRules = ruleEngine.getActiveRules(project);
  if (activeRules.length > 0) {
    try {
      log(`Evaluating relevance for ${activeRules.length} active rules...`);
      const relevanceResult = llmBrain.evaluateRelevance(activeRules, observations, newMemories);

      if (relevanceResult && Array.isArray(relevanceResult.evaluations)) {
        const changes = ruleEngine.scoreFitness(project, relevanceResult.evaluations);
        const relevant = changes.filter(c => c.reason !== 'not_relevant');
        const notRelevant = changes.filter(c => c.reason === 'not_relevant');
        log(`  Fitness: ${relevant.length} relevant (${changes.filter(c => c.delta > 0).length} followed, ${changes.filter(c => c.delta < 0).length} failed), ${notRelevant.length} not relevant`);
      }
    } catch (err) {
      log(`Relevance evaluation error: ${err.message || err}`);
      // Fallback: old-style +1 for all
      ruleEngine.evaluateFitness(project, [], new Set());
    }
  }

  // =====================================================================
  // STEP 4: Check if generation is complete
  // =====================================================================
  const isNewGeneration = ruleEngine.tickSession(project);

  if (isNewGeneration) {
    const gen = ruleEngine.advanceGeneration(project);
    log(`\n=== GENERATION ${gen} ===`);

    // ----- Tournament selection -----
    log('Running tournament selection...');
    const { promoted, demoted } = ruleEngine.tournamentSelection(project);
    log(`  Demoted: ${demoted.length}, Promoted: ${promoted.length}`);

    // ----- Crossover -----
    const postTournamentActive = ruleEngine.getActiveRules(project);
    if (postTournamentActive.length >= 2) {
      log('Running crossover...');
      // Pick two highest-confidence parents
      const sorted = postTournamentActive.sort((a, b) => ruleEngine.confidence(b) - ruleEngine.confidence(a));
      for (let i = 0; i < ruleEngine.CROSSOVER_COUNT && i < Math.floor(sorted.length / 2); i++) {
        try {
          const parentA = sorted[i * 2];
          const parentB = sorted[i * 2 + 1];
          const result = llmBrain.crossover(parentA, parentB);
          if (result && result.offspring && result.offspring.length > 5) {
            if (!ruleEngine.isDuplicate(project, result.keywords || [])) {
              ruleEngine.addRule(project, result.offspring, 'crossover', result.keywords, 'candidate');
              log(`  Offspring: "${result.offspring.slice(0, 60)}" (from ${parentA.id.slice(0,8)} x ${parentB.id.slice(0,8)})`);
            }
          }
        } catch (err) {
          log(`  Crossover error: ${err.message || err}`);
        }
      }
    }

    // ----- Mutation -----
    log('Running mutation...');
    const toMutate = postTournamentActive.filter(() => Math.random() < ruleEngine.MUTATION_RATE);
    for (const rule of toMutate) {
      try {
        const result = llmBrain.mutate(rule);
        if (result && result.mutant && result.mutant.length > 5) {
          if (!ruleEngine.isDuplicate(project, result.keywords || [])) {
            ruleEngine.addRule(project, result.mutant, 'mutation', result.keywords, 'candidate');
            log(`  Mutant (${result.mutation_type || '?'}): "${result.mutant.slice(0, 60)}"`);
          }
        }
      } catch (err) {
        log(`  Mutation error: ${err.message || err}`);
      }
    }

    // ----- Immigration -----
    log('Running immigration...');
    const revived = ruleEngine.immigration(project);
    if (revived.length > 0) log(`  Revived ${revived.length} from dormant`);

    // ----- Reflection (every 2 generations) -----
    const popData = ruleEngine.loadPopulation();
    if (popData.generation % 2 === 0) {
      log('Running reflection...');
      try {
        const allActive = ruleEngine.getActiveRules(project);
        const narratives = readRecentNarratives(5).map(n => n.narrative || '');
        const reflectResult = llmBrain.reflectOnRules(allActive, narratives, []);

        if (reflectResult && Array.isArray(reflectResult.insights)) {
          const data = ruleEngine.loadPopulation();
          for (const insight of reflectResult.insights) {
            log(`  Reflection [${insight.action}] ${(insight.rule_ids || []).join(',')} — ${insight.reason || ''}`);

            if (insight.action === 'remove') {
              for (const id of (insight.rule_ids || [])) {
                const r = data.population.find(x => x.id === id);
                if (r && r.status === 'active') {
                  r.status = 'dormant'; // Reflection demotes, doesn't kill
                  ruleEngine.logChange({ action: 'reflection_demote', rule_id: id, project, reason: insight.reason });
                }
              }
            }
            if (insight.action === 'revise' && insight.revised_content) {
              for (const id of (insight.rule_ids || [])) {
                const r = data.population.find(x => x.id === id);
                if (r) {
                  ruleEngine.logChange({
                    action: 'reflection_revise', rule_id: id, project,
                    old: r.content.slice(0, 200), new: insight.revised_content.slice(0, 200),
                  });
                  r.content = insight.revised_content;
                  r.keywords = ruleEngine.extractKeywords(insight.revised_content);
                }
              }
            }
          }
          ruleEngine.savePopulation(data);
        }
      } catch (err) {
        log(`Reflection error: ${err.message || err}`);
      }
    }

    // Log generation summary
    const genStats = ruleEngine.getPopulationStats(project);
    log(`Generation ${gen} complete: active=${genStats.active} candidate=${genStats.candidate} dormant=${genStats.dormant} dead=${genStats.dead} avg_confidence=${genStats.avg_confidence}`);
  }

  // =====================================================================
  // STEP 5: Session memory compression
  // =====================================================================
  let sessionId = null;
  try {
    const sessionMemory = require('./sessionMemory');
    sessionId = sessionMemory.generateSessionId();

    const compressResult = llmBrain.compressSession(observations, newMemories, []);
    if (compressResult && compressResult.summary) {
      const popStats = ruleEngine.getPopulationStats(project);
      sessionMemory.writeSession(sessionId, compressResult, observations || [], {
        project, toolCalls: (observations || []).length,
        strategy: isNewGeneration ? 'generation' : 'session',
        rulesAdded, rulesPruned: 0,
      });
      sessionMemory.appendIndex(
        sessionId,
        compressResult.index_line || compressResult.summary.split('\n')[0].slice(0, 100),
        (observations || []).length,
        path.basename(project)
      );
      log(`Session memory: ${sessionId}`);
    }
  } catch (err) {
    log(`Session memory error: ${err.message || err}`);
  }

  // =====================================================================
  // STEP 6: Write active rules to CLAUDE.md
  // =====================================================================
  const finalActive = ruleEngine.getActiveRules(project);
  const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, finalActive);
  log(`Wrote ${finalActive.length} active rules to ${writtenPath || 'CLAUDE.md'}`);

  // Summary
  const finalStats = ruleEngine.getPopulationStats(project);
  ruleEngine.logChange({
    action: 'session_complete', project,
    generation: finalStats.generation,
    is_new_generation: isNewGeneration,
    rules_born: rulesAdded,
    conflicts: conflictsFound,
    population: finalStats,
  });

  // Remove pending file
  try { fs.unlinkSync(pendingFile); } catch {}

  log(`Done: gen=${finalStats.generation} born=${rulesAdded} active=${finalStats.active} candidate=${finalStats.candidate} dormant=${finalStats.dormant} ${isNewGeneration ? '(GENERATION CYCLE RAN)' : ''}`);
}

main().catch(err => {
  log(`FATAL: ${err.stack || err.message || err}`);
});
