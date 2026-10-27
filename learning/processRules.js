#!/usr/bin/env node
// processRules.js — Signal-gene learning pipeline (one detached run per session)
//
// Signal → Gene → LLM Execute → Check → Apply → Solidify
//
// Signal: What happened in this session? (corrections, observations, quiet)
// Gene: What action to take? (repair / innovate / optimize / cleanup / skillify)
//   - repair:   corrections detected → extract new rules from feedback
//   - innovate: patterns/anti-patterns detected → extract rules from observations
//   - optimize: LLM evaluates all active rules, scores them, may revive dormant ones
//   - cleanup:  too many rules → LLM merges and simplifies
//   - skillify: 3+ mature rules → promote to methodology, written as a skill
// Execute: LLM performs the gene's action against a snapshot of the store (no lock held)
// Check: every new, merged, rewritten or revived rule is checked against all instruction
//   layers and the user's memories; those always win (conflict → rule goes dormant)
// Apply: one locked mutation re-reads the store and applies everything, then scores,
//   dedupes and runs the lifecycle (decay, promotion, TTL pruning)
// Solidify: skill files, the project's rules file, session memory, run log
//
// Usage: node processRules.js <pending_file>. Pending files older than a day (an earlier
// processor died) are swept and processed first.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR, resolveProjectRoot, realpathOr } = require('./paths');
const { appendBounded, writeJsonAtomic, readJson } = require('./fsutil');

const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const PROCESS_LOG = path.join(DATA_DIR, 'process.log');
const RUNS_LOG = path.join(DATA_DIR, 'runs.jsonl');
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;       // older than this: its processor died, retry it
const STALE_PENDING_MS = 7 * 24 * 60 * 60 * 1000; // older than this: too old to apply, delete it
const MAX_ATTEMPTS = 3;

function log(msg) {
  try { appendBounded(PROCESS_LOG, `[${new Date().toISOString()}] ${msg}`, 2 * 1024 * 1024); } catch {}
}

// =====================================================================
// TRIAGE FALLBACK (if LLM triage fails, use simple heuristics)
// =====================================================================

function fallbackTriage(newMemories, observations, activeRuleCount, sessionCount, highScoreGroups) {
  let gene = 'observe';
  if ((newMemories || []).length > 0) gene = 'repair';
  else if ((observations || []).length >= 3) gene = 'innovate';
  else if ((highScoreGroups || 0) > 0) gene = 'skillify';
  else if (activeRuleCount >= 8) gene = 'cleanup';
  else if (sessionCount > 0 && sessionCount % 3 === 0) gene = 'optimize';
  return { gene, complexity: 'routine', reason: 'fallback heuristic' };
}

// =====================================================================
// PENDING FILES
// =====================================================================

/**
 * Normalize a pending record. Old format (no cwd): project was the launch cwd.
 * Returns null when the session has no project root (nothing may be written).
 */
function normalizePending(pending) {
  if (!pending || !pending.project) return null;
  if (!pending.cwd) {
    pending.cwd = pending.project;
    pending.project = resolveProjectRoot(pending.project).root;
  }
  return pending.project ? pending : null;
}

/**
 * Pending files left behind by processors that died: 1 to 7 days old → claim and retry;
 * older than 7 days → delete without processing (an old session must not rewrite rules now).
 */
function sweepPending(currentFile) {
  let names = [];
  try { names = fs.readdirSync(DATA_DIR); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    // pending_<id>.json, or a claim (<name>.<pid>.processing) whose processor died
    const m = name.match(/^(pending_.+\.json)(\.\d+\.processing)?$/);
    if (!m) continue;
    const file = path.join(DATA_DIR, name);
    const original = path.join(DATA_DIR, m[1]);
    if (path.resolve(file) === path.resolve(currentFile || '')) continue;
    try {
      const age = now - fs.statSync(file).mtimeMs;
      if (age < SWEEP_AGE_MS) continue;
      if (age > STALE_PENDING_MS) {
        fs.unlinkSync(file);
        log(`Sweep: ${name} is ${Math.floor(age / 86400000)} days old; deleted without processing`);
        continue;
      }
      const claimed = `${original}.${process.pid}.processing`;
      fs.renameSync(file, claimed);  // whoever renames first owns it
      fs.utimesSync(claimed, new Date(), new Date());  // a fresh claim is not stale to others
      log(`Sweep: ${name}`);
      processFile(claimed, original);
    } catch (err) {
      if (err.code !== 'ENOENT') log(`Sweep error for ${name}: ${err.message}`);
    }
  }
}

/**
 * Process one pending file. On success (or invalid input) the file is deleted. On failure it
 * is put back with attempts+1 for a later sweep; after MAX_ATTEMPTS it is deleted.
 */
function processFile(file, restorePath) {
  let pending;
  try {
    pending = normalizePending(readJson(file, null));
  } catch (err) {
    log(`Invalid pending ${path.basename(file)}: ${err.message}`);
  }
  if (!pending) {
    log(`Pending ${path.basename(restorePath || file)} has no project root; deleted`);
    try { fs.unlinkSync(file); } catch {}
    return;
  }

  try {
    processPending(pending, file);
    try { fs.unlinkSync(file); } catch {}
  } catch (err) {
    const attempts = (pending.attempts || 0) + 1;
    log(`FATAL (attempt ${attempts}/${MAX_ATTEMPTS}): ${err.stack || err.message || err}`);
    try {
      if (attempts >= MAX_ATTEMPTS) {
        fs.unlinkSync(file);
      } else {
        writeJsonAtomic(restorePath || file, { ...pending, attempts });
        if (restorePath && restorePath !== file) fs.unlinkSync(file);
      }
    } catch {}
  }
}

// =====================================================================
// INSTRUCTION LAYERS (what Claude Code loads for this project)
// =====================================================================

function readHandWritten(file, claudeMdWriter) {
  try { return claudeMdWriter.getHandWrittenContent(fs.readFileSync(file, 'utf8')); } catch { return ''; }
}

/**
 * Hand-written instruction files for the root, any between the launch cwd and the root,
 * every CLAUDE.md / CLAUDE.local.md from the root's parent upward, ~/.claude/CLAUDE.md,
 * and the user's memories for the launch cwd.
 */
function collectInstructionLayers(root, cwd, excludeMemoryFiles) {
  const claudeMdWriter = require('./claudeMdWriter');
  const layers = [];
  const addDir = (dir, where) => {
    for (const name of claudeMdWriter.INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      const text = readHandWritten(file, claudeMdWriter);
      if (text) layers.push({ label: `${file} (${where})`, text });
    }
  };

  addDir(root, 'project root');
  // Subdirectories between the launch cwd and the root
  let dir = cwd ? realpathOr(cwd) : root;
  const inside = [];
  while (dir.startsWith(root + path.sep)) { inside.push(dir); dir = path.dirname(dir); }
  for (const d of inside.reverse()) addDir(d, 'project subdirectory');
  // Parents of the root, up to /
  for (let d = path.dirname(root); ; d = path.dirname(d)) {
    addDir(d, 'parent directory');
    if (path.dirname(d) === d) break;
  }

  const userMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const userText = readHandWritten(userMd, claudeMdWriter);
  if (userText) layers.push({ label: '~/.claude/CLAUDE.md (user global)', text: userText });

  let memories = [];
  try { memories = require('./memoryReader').getAllMemories(cwd || root) || []; } catch {}
  // The session's own correction memories are the source of repair rules, not a check against them
  const skip = new Set(['MEMORY.md', ...(excludeMemoryFiles || [])]);
  const memText = memories
    .filter(m => !skip.has(m.file))
    .map(m => `- [${m.type || 'memory'}] ${m.name || m.file}: ${m.description || ''} ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)}`.trim())
    .join('\n');
  if (memText) layers.push({ label: 'user memories', text: memText });

  return { layers, memories };
}

// =====================================================================
// MAIN PIPELINE
// =====================================================================

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Run one session through the pipeline. `file` is the pending file being processed: once the
 * learning has been applied to the store it is marked `applied`, so a retry after a later
 * failure only redoes the writes (the session is never counted or scored twice).
 */
function processPending(pending, file) {
  const started = Date.now();
  const { project, cwd, newMemories = [], observations = [] } = pending;
  const ruleEngine = require('./ruleEngine');
  const claudeMdWriter = require('./claudeMdWriter');
  const llmBrain = require('./llmBrain');
  llmBrain.resetStats();
  log(`processRules started: ${path.basename(project)}, memories: ${newMemories.length}, obs: ${observations.length}`);

  // A deleted worktree or workspace stays deleted: nothing is learned or written for it
  if (!isDir(project)) {
    log(`Skip: project ${project} no longer exists; nothing written`);
    return { skipped: 'project missing' };
  }

  const migrated = ruleEngine.migrateStore();
  if (migrated) log(`Store migrated to v${ruleEngine.SCHEMA_VERSION}: ${JSON.stringify(migrated)}`);

  let learned;
  let memories;
  const isRetry = !!pending.applied;
  if (isRetry) {
    learned = pending.applied;
    memories = collectInstructionLayers(project, cwd, newMemories.map(m => m.file).filter(Boolean)).memories;
    log(`Retry: learning was applied at ${learned.at}; redoing the writes only`);
  } else {
    ({ learned, memories } = learnAndApply(pending, ruleEngine, llmBrain));
    pending.applied = learned;
    if (file) writeJsonAtomic(file, pending);
  }
  const { gene, complexity, sessionCount, rulesBorn, conflicts, prunedCount } = learned;
  const changed = new Set(learned.changedIds || []);

  solidify(pending, learned, memories, ruleEngine, claudeMdWriter, llmBrain, changed);

  // --- Run record ---
  const finalStats = ruleEngine.getPopulationStats(project);
  const llm = llmBrain.getStats();
  ruleEngine.logChange({
    action: 'session_complete', project, gene, complexity, session: sessionCount,
    rules_born: rulesBorn, conflicts, population: finalStats, retry: isRetry,
  });
  try {
    appendBounded(RUNS_LOG, JSON.stringify({
      time: new Date().toISOString(), project, sessionId: pending.sessionId || null, gene,
      llmCalls: llm.calls, llmFailures: llm.failures, llmFailureKinds: llm.kinds,
      rulesBorn, durationMs: Date.now() - started,
    }), 1024 * 1024);
  } catch {}

  const summary = `session=${sessionCount} born=${rulesBorn} active=${finalStats.active} dormant=${finalStats.dormant}`;
  if (llm.failures === 0) {
    log(`Done [${gene}]: ${summary}`);
  } else {
    const kinds = Object.entries(llm.kinds).map(([k, n]) => `${k}×${n}`).join(', ');
    log(`Done with ${llm.failures} LLM failures (${kinds}) [${gene}]: ${summary}`);
  }
  return { gene, rulesBorn, llm, prunedCount };
}

/**
 * Triage, execute the gene (LLM, no lock), check, and apply everything to the store in one
 * locked mutation. Returns { learned, memories }; `learned` is what the writes need and what
 * the pending file keeps as its `applied` marker.
 */
function learnAndApply(pending, ruleEngine, llmBrain) {
  const { project, cwd, newMemories = [], observations = [] } = pending;
  const sessionCount = ruleEngine.incrementSession();
  const snapshot = ruleEngine.getActiveRules(project);
  const stats = ruleEngine.getPopulationStats(project);
  log(`Session #${sessionCount} | active=${stats.active} candidate=${stats.candidate} dormant=${stats.dormant}`);

  const { layers, memories } = collectInstructionLayers(project, cwd, newMemories.map(m => m.file).filter(Boolean));
  const layerTexts = layers.map(l => l.text).join('\n');
  const handContext = llmBrain.budgetLayers(layers, 4000);

  // --- Count high-score rules for skillify ---
  const isMature = r => (r.score || 0) > 7 && (r.relevance_count || 0) >= 5;
  const highScoreGroups = snapshot.filter(isMature).length >= 3 ? 1 : 0;

  // --- Triage: LLM decides gene + complexity ---
  let gene = 'observe';
  let complexity = 'routine';
  const triageResult = llmBrain.triage(observations, newMemories, stats.active, sessionCount, highScoreGroups);
  if (triageResult && triageResult.gene) {
    gene = triageResult.gene;
    complexity = triageResult.complexity === 'complex' ? 'complex' : 'routine';
    log(`Triage (LLM): gene=${gene} complexity=${complexity} — ${triageResult.reason || ''}`);
  } else {
    const fb = fallbackTriage(newMemories, observations, stats.active, sessionCount, highScoreGroups);
    gene = fb.gene; complexity = fb.complexity;
    log(`Triage (fallback): gene=${gene}`);
  }

  // Model tier for gene execution: routine → haiku, complex → sonnet
  const tier = complexity === 'complex' ? 'smart' : 'fast';
  log(`Model tier: ${tier} (${complexity})`);

  // ================= Execute (LLM, no lock) =================
  const proposals = [];  // { content, keywords, source }
  const proposeFromObservations = (result, label) => {
    if (!result) return;
    for (const [list, source] of [[result.patterns, 'observation'], [result.anti_patterns, 'anti_pattern']]) {
      for (const p of list || []) {
        if (!p || !p.rule || p.confidence === 'low') continue;
        proposals.push({ content: String(p.rule), keywords: Array.isArray(p.keywords) ? p.keywords : [], source });
      }
    }
    log(`  ${label}: ${proposals.length} proposal(s)`);
  };

  let evaluations = null;
  let reviveIds = [];
  let cleanupActions = [];
  const promotions = [];  // { id, complexity }

  if (gene === 'repair') {
    for (const mem of newMemories) {
      const extracted = llmBrain.extractRule(mem, tier);
      if (extracted && extracted.rule) {
        proposals.push({ content: String(extracted.rule), keywords: Array.isArray(extracted.keywords) ? extracted.keywords : [], source: 'correction' });
        log(`  Extracted: "${String(extracted.rule).slice(0, 80)}"`);
      }
    }
    // Also learn from observations while the population is small
    if (stats.active < 3 && observations.length >= 3) {
      proposeFromObservations(llmBrain.analyzeObservations(observations, snapshot, handContext, tier), 'Observations');
    }
  }

  if (gene === 'innovate' && observations.length >= 3) {
    log('Analyzing observations for patterns...');
    proposeFromObservations(llmBrain.analyzeObservations(observations, snapshot, handContext, tier), 'Innovate');
  }

  if (gene === 'optimize' && snapshot.length > 0) {
    log(`Optimizing ${snapshot.length} active rules...`);
    const evalResult = llmBrain.evaluateRuleSet(snapshot, observations, newMemories, tier);
    if (evalResult && Array.isArray(evalResult.evaluations)) {
      evaluations = evalResult.evaluations;
      // Rules whose score is about to cross 7 may graduate to a higher complexity level
      for (const ev of evaluations) {
        const rule = snapshot.find(r => r.id === ev.rule_id);
        if (!rule || typeof ev.score !== 'number') continue;
        const next = parseFloat((rule.score * 0.7 + ev.score * 0.3).toFixed(1));
        if (!(next > 7 && rule.score <= 7 && (rule.relevance_count || 0) >= 5)) continue;
        const related = ruleEngine.getRelatedRules(project, rule, 0.2).filter(r => r.status === 'active' && (r.score || 0) > 7);
        if (related.length < 2) continue;
        const group = [rule, ...related];
        const newComplexity = llmBrain.classifyComplexity(
          { content: group.map(r => r.content).join('\n'), keywords: [...new Set(group.flatMap(r => r.keywords || []))] },
          snapshot, pending.projectType || '');
        const levels = ['simple', 'compound', 'workflow', 'methodology'];
        if (levels.indexOf(newComplexity) > levels.indexOf(rule.complexity || 'simple')) {
          promotions.push({ id: rule.id, complexity: newComplexity });
        }
      }
    }
    if (evalResult && Array.isArray(evalResult.revive)) reviveIds = evalResult.revive;
  }

  if (gene === 'cleanup' && snapshot.length >= 5) {
    log(`Cleaning up ${snapshot.length} rules...`);
    const cleanResult = llmBrain.cleanupRules(snapshot, tier);
    if (cleanResult && Array.isArray(cleanResult.actions)) cleanupActions = cleanResult.actions;
  }

  // ================= Check (dedupe, then one LLM contradiction check) =================
  const dormantById = new Map(ruleEngine.getDormant(project).map(r => [r.id, r]));
  const items = [];  // { kind: 'new'|'merge'|'rewrite'|'revive', content, keywords, ... }
  for (const p of proposals) {
    if (ruleEngine.isDuplicate(project, p.keywords.length ? p.keywords : ruleEngine.extractKeywords(p.content))) { log(`  Skip (dup of rule): "${p.content.slice(0, 50)}"`); continue; }
    if (items.some(i => ruleEngine.jaccardSimilarity(ruleEngine.extractKeywords(i.content), ruleEngine.extractKeywords(p.content)) > 0.5)) continue;
    const similar = ruleEngine.findSimilarChunk(p.content, layerTexts);
    if (similar.duplicate) { log(`  Skip (already in instructions, sim=${similar.similarity}): "${p.content.slice(0, 50)}"`); continue; }
    items.push({ kind: 'new', ...p });
  }
  for (const a of cleanupActions) {
    if (a.type === 'merge' && a.merged_rule && Array.isArray(a.source_ids)) {
      items.push({ kind: 'merge', content: String(a.merged_rule), keywords: Array.isArray(a.keywords) ? a.keywords : [], source: 'cleanup', sourceIds: a.source_ids });
    } else if (a.type === 'rewrite' && a.rule_id && a.new_content) {
      items.push({ kind: 'rewrite', content: String(a.new_content), ruleId: a.rule_id });
    }
  }
  for (const id of reviveIds) {
    const r = dormantById.get(id);
    if (r) items.push({ kind: 'revive', content: r.content, ruleId: id });
  }

  let checked = [];
  if (items.length > 0) {
    const verdicts = llmBrain.checkContradictions(items.map(i => i.content), layers, tier);
    const byIndex = new Map(((verdicts && verdicts.results) || []).map(v => [Number(v.index), v]));
    for (let i = 0; i < items.length; i++) {
      const v = byIndex.get(i);
      if (!v || !['new', 'duplicate', 'conflict'].includes(v.decision)) {
        log(`  Skip (contradiction check failed): "${items[i].content.slice(0, 50)}"`);
        continue;
      }
      checked.push({ ...items[i], verdict: v });
      log(`  Check [${v.decision}] ${items[i].kind}: "${items[i].content.slice(0, 50)}"${v.decision === 'new' ? '' : ` — ${String(v.reason || '').slice(0, 100)}`}`);
    }
  }

  // Complexity for rules that will be born active (and existing unclassified ones)
  const unclassified = snapshot.filter(r => r.classified === false);
  for (const item of checked) {
    if ((item.kind === 'new' || item.kind === 'merge') && item.verdict.decision === 'new') {
      item.complexity = llmBrain.classifyComplexity({ content: item.content, keywords: item.keywords }, snapshot, pending.projectType || '');
    }
  }
  const classifications = unclassified.map(r => ({ id: r.id, complexity: llmBrain.classifyComplexity(r, snapshot, pending.projectType || '') }));

  // ================= Apply (one locked mutation on a fresh store) =================
  const observationText = observations.map(o => `${o.input || ''} ${o.output || ''}`).join(' ');
  const changed = new Set();
  const applied = ruleEngine.mutatePopulation(data => {
    const res = { born: [], conflicts: 0, scored: 0, deduped: 0 };
    const live = id => data.population.find(r => r.id === id && r.project === project);
    const isLiveDup = kw => data.population.some(r => r.project === project &&
      (r.status === 'active' || r.status === 'candidate') && ruleEngine.jaccardSimilarity(r.keywords || [], kw) > 0.5);

    for (const item of checked) {
      const { decision, reason = '', conflicts_with: withText = '', layer = '' } = item.verdict;
      if (decision === 'duplicate') { log(`  Skip (duplicate per LLM): "${item.content.slice(0, 50)}" — ${reason}`); continue; }
      if (decision === 'conflict') {
        res.conflicts++;
        const why = `conflicts with ${layer || 'instructions'}: ${String(withText || reason).slice(0, 160)}`;
        ruleEngine.logChange({ action: 'conflict_auto_resolved', project, kind: item.kind, resolution: 'kept_existing', reason: why, content: item.content.slice(0, 200) });
        if (item.kind === 'new') res.born.push(ruleEngine.insertRule(data, project, item.content, item.source, item.keywords, 'dormant', null, why));
        if (item.kind === 'rewrite' || item.kind === 'revive') {
          const r = live(item.ruleId);
          if (r && item.kind === 'revive') r.status_reason = why;
        }
        log(`  Conflict auto-resolved (instructions win): "${item.content.slice(0, 50)}"`);
        continue;
      }

      if (item.kind === 'new') {
        const kw = item.keywords.length ? item.keywords : ruleEngine.extractKeywords(item.content);
        if (isLiveDup(kw)) continue;  // a concurrent processor learned it meanwhile
        const rule = ruleEngine.insertRule(data, project, item.content, item.source, kw, 'active', item.complexity);
        res.born.push(rule);
        changed.add(rule.id);
        log(`  Added [${item.source}] as ${rule.status}: "${item.content.slice(0, 60)}"`);
      } else if (item.kind === 'merge') {
        const sources = item.sourceIds.map(live).filter(r => r && r.status === 'active');
        if (sources.length < 2) continue;
        // Sources leave first so the merged rule gets a slot; all in this one saved population
        for (const r of sources) ruleEngine.setStatus(r, 'dormant', 'merged by cleanup');
        const merged = ruleEngine.insertRule(data, project, item.content, 'cleanup', item.keywords, 'active', item.complexity);
        for (const r of sources) r.status_reason = `merged into ${merged.id}`;
        res.born.push(merged);
        changed.add(merged.id);
        log(`  Merged ${sources.length} → "${item.content.slice(0, 60)}"`);
      } else if (item.kind === 'rewrite') {
        const r = live(item.ruleId);
        if (!r || r.status !== 'active') continue;
        r.content = item.content;
        r.keywords = ruleEngine.extractKeywords(item.content);
        r.content_hash = require('crypto').createHash('sha256').update(item.content).digest('hex');
        changed.add(r.id);
        log(`  Rewritten: "${item.content.slice(0, 60)}"`);
      } else if (item.kind === 'revive') {
        const r = live(item.ruleId);
        if (!r || r.status !== 'dormant') continue;
        const activeCount = data.population.filter(x => x.project === project && x.status === 'active').length;
        ruleEngine.setStatus(r, activeCount < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate', 'revived by optimize');
        r.score = 5;
        changed.add(r.id);
        ruleEngine.logChange({ action: 'revived', rule_id: r.id, project });
        log(`  Revived: ${r.content.slice(0, 40)}`);
      }
    }

    for (const a of cleanupActions) {
      if (a.type !== 'remove' || !a.rule_id) continue;
      const r = live(a.rule_id);
      if (r && r.status === 'active') { ruleEngine.setStatus(r, 'dormant', `removed by cleanup: ${a.reason || ''}`.trim()); log(`  Removed: "${r.content.slice(0, 40)}"`); }
    }

    if (evaluations) {
      for (const c of ruleEngine.applyScoresTo(data, project, evaluations)) {
        log(`  ${c.rule_id.slice(0, 12)}: ${c.old_score} → ${c.new_score} (LLM: ${c.llm_score}) ${c.reason}`);
      }
    }
    for (const p of [...promotions, ...classifications]) {
      const r = live(p.id);
      if (!r) continue;
      if (r.complexity !== p.complexity) changed.add(r.id);
      r.complexity = p.complexity;
      r.classified = true;
    }

    if (gene === 'skillify') {
      const mature = data.population.filter(r => r.project === project && r.status === 'active' && isMature(r));
      if (mature.length >= 3) {
        for (const r of mature) {
          if (r.complexity !== 'methodology') { r.complexity = 'methodology'; r.classified = true; changed.add(r.id); }
        }
        log(`  Skillify: ${mature.length} mature rules → methodology`);
      } else {
        log(`  Skillify: only ${mature.length} mature rules (need 3+), skipping`);
      }
    }

    // Keyword dedupe among active rules: the lower-scored duplicate goes dormant
    const active = data.population.filter(r => r.project === project && r.status === 'active');
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const [a, b] = [active[i], active[j]];
        if (a.status !== 'active' || b.status !== 'active') continue;
        const sim = ruleEngine.jaccardSimilarity(a.keywords || [], b.keywords || []);
        if (sim <= 0.5) continue;
        const loser = (a.score || 0) >= (b.score || 0) ? b : a;
        const winner = loser === a ? b : a;
        ruleEngine.setStatus(loser, 'dormant', `duplicate of ${winner.id}`);
        res.deduped++;
        log(`  Auto-dedup: demoted "${loser.content.slice(0, 40)}" (sim=${sim.toFixed(2)})`);
      }
    }

    // Heuristic scoring every session (no LLM): used rules rise, unused rules decay
    if (observations.length >= 3) res.scored = ruleEngine.scoreFromObservations(data, project, observationText);

    Object.assign(res, ruleEngine.lifecycleIn(data, project));
    return res;
  });

  for (const r of applied.promoted) changed.add(r.id);
  if (applied.scored) log(`Heuristic-score: ${applied.scored} rules updated`);
  if (applied.demoted.length) log(`  Demoted: ${applied.demoted.length}`);
  if (applied.promoted.length) log(`  Promoted: ${applied.promoted.length}`);
  if (applied.pruned.length) log(`  Pruned (archived): ${applied.pruned.length}`);
  const rulesBorn = applied.born.filter(r => r.status === 'active' || r.status === 'candidate').length;

  return {
    memories,
    learned: {
      at: new Date().toISOString(), gene, complexity, sessionCount, rulesBorn,
      conflicts: applied.conflicts, prunedCount: applied.pruned.length, changedIds: [...changed],
      skillDemoted: applied.demoted.some(r => r.old_skill_path),
    },
  };
}

/** Skill files, the rules file, hints, cross-project store and session memory. */
function solidify(pending, learned, memories, ruleEngine, claudeMdWriter, llmBrain, changed) {
  const { project, newMemories = [], observations = [] } = pending;
  const { gene, rulesBorn, prunedCount } = learned;
  const finalActive = ruleEngine.getActiveRules(project);
  const methodologyRules = finalActive.filter(r => r.complexity === 'methodology');
  let skillFailed = false;
  const skillWriter = require('./skillWriter');

  const keepSkills = [];
  try {
    skillWriter.migrateFlatSkills(project);
    if (methodologyRules.length > 0) {
      const existing = methodologyRules.map(r => r.skill_path).find(p => p && fs.existsSync(p));
      const groupChanged = methodologyRules.some(r => changed.has(r.id)) || learned.skillDemoted;
      if (existing && !groupChanged) {
        keepSkills.push(existing);
        log('  Skill unchanged (no rule changes this session)');
      } else {
        let sessionNarratives = [];
        try {
          const narrativePath = path.join(DATA_DIR, 'narrative.jsonl');
          sessionNarratives = fs.readFileSync(narrativePath, 'utf8').trim().split('\n')
            .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch {}
        const result = skillWriter.writeSkill(project, methodologyRules[0], methodologyRules.slice(1), pending.projectType || '', memories, sessionNarratives);
        if (result && result.path) keepSkills.push(result.path);
        log(result && result.written ? `  Skill file: ${result.path}${result.reason ? ` (${result.reason})` : ''}` : `  Skill skipped: ${(result && result.reason) || 'unknown'}`);
        if (result && result.written) {
          const ids = new Set(methodologyRules.map(r => r.id));
          ruleEngine.mutatePopulation(data => {
            for (const r of data.population) if (ids.has(r.id)) r.skill_path = result.path;
          });
        }
      }
    }
    for (const f of skillWriter.reconcileSkills(project, keepSkills)) log(`  Skill removed: ${f}`);
  } catch (err) {
    log(`skillWriter error: ${err.message}, rules stay in the rules file`);
    skillFailed = true;
  }

  // Re-read right before writing: a concurrent processor may have changed the set meanwhile.
  // Methodology rules whose skill exists are routed; the rest are written as rules.
  const activeNow = ruleEngine.getActiveRules(project);
  const otherRules = skillFailed ? activeNow
    : activeNow.filter(r => r.complexity !== 'methodology' || !(r.skill_path && fs.existsSync(r.skill_path)));
  const routes = skillWriter.listSkillRoutes(project);
  const written = claudeMdWriter.writeRules(project, otherRules, routes);
  if (written.error) log(`Rules file not written: ${written.error}`);
  log(`Solidified: ${otherRules.length} rules + ${routes.length} skill routes → ${written.path} (${written.changed ? 'updated' : 'unchanged'})`);

  // --- Skill hints + cross-project store ---
  require('./skillHints').updateHints(methodologyRules, log);
  require('./crossProjectStore').savePatterns(project, finalActive, pending.projectType || 'general', log);

  // --- Session memory ---
  try {
    if (observations.length >= 3) {
      const sessionMemory = require('./sessionMemory');
      const compressResult = llmBrain.compressSession(observations, newMemories, []);
      if (compressResult && compressResult.summary) {
        const sessionId = sessionMemory.generateSessionId(pending.sessionId);
        sessionMemory.writeSession(sessionId, compressResult, observations, {
          project, toolCalls: observations.length, strategy: gene, rulesAdded: rulesBorn, rulesPruned: prunedCount,
        });
        sessionMemory.appendIndex(sessionId,
          compressResult.index_line || String(compressResult.summary).split('\n')[0].slice(0, 100),
          observations.length, project);
        log(`Memory: ${sessionId}`);
      }
    }
  } catch (err) { log(`Memory error: ${err.message}`); }
}

function main() {
  const pendingFile = process.argv[2] || PENDING_PATH;
  if (fs.existsSync(pendingFile)) processFile(pendingFile);
  else log(`No pending data: ${pendingFile}`);
  try { sweepPending(pendingFile); } catch (err) { log(`Sweep failed: ${err.message}`); }
}

if (require.main === module) main();

module.exports = { processPending, processFile, normalizePending, sweepPending, collectInstructionLayers, fallbackTriage };
