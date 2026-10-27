#!/usr/bin/env node
// ruleEngine.js — Rule population engine (signal-gene pipeline)
//
// Population (rules.json, schema v3):
//   active    — written to the project's rules file, at most MAX_ACTIVE per project
//   candidate — waiting for an active slot; pruned after CANDIDATE_TTL_DAYS
//   dormant   — demoted, duplicate or contradicted; revivable; pruned after DORMANT_TTL_DAYS
// Pruned rules are appended to rules_archive.jsonl.
//
// Scoring:
//   Heuristic score every session (keyword hits in the session's observations): used rules
//   climb toward 6-8, unused rules decay toward 2, so they can fall below the demotion line.
//   The optimize gene adds LLM scores on top (EMA).
//
// Concurrency: every read-modify-write goes through mutatePopulation(), which holds a
// cross-process lock, re-reads the store, applies the change and saves atomically.
// A corrupt rules.json throws instead of loading as empty, so it is never overwritten.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, resolveProjectRoot } = require('./paths');
const { writeFileAtomic, writeJsonAtomic, readJson, withLock, appendBounded } = require('./fsutil');

const RULES_PATH = path.join(DATA_DIR, 'rules.json');
const RULES_BAK = RULES_PATH + '.bak';
const ARCHIVE_PATH = path.join(DATA_DIR, 'rules_archive.jsonl');
const CONFLICTS_PATH = path.join(DATA_DIR, 'conflicts.json');
const CONFLICTS_ARCHIVE = path.join(DATA_DIR, 'conflicts_archive.jsonl');
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.jsonl');

const SCHEMA_VERSION = 3;
const MAX_ACTIVE = 10;             // Max rules in a project's rules file
const CANDIDATE_TTL_DAYS = 30;     // Candidates that never got a slot are pruned
const DORMANT_TTL_DAYS = 60;       // Dormant rules nobody revived are pruned
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ['active', 'candidate', 'dormant'];

// ===================== Keywords =====================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'that', 'this', 'these', 'those', 'it', 'its',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'what', 'which', 'who', 'whom',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '個', '上', '也', '很', '到', '說', '要', '去', '你', '會', '著', '沒有',
  '看', '好', '自己', '這', '他', '她', '們', '吧', '被', '把', '讓', '用',
  '那', '什麼', '怎麼', '如果', '可以', '因為', '所以', '但是', '還是',
  '或者', '而且', '嗎', '呢', '啊', '喔', '欸', '對',
]);

function extractKeywords(text) {
  if (!text) return [];
  const normalized = text.toLowerCase()
    .replace(/[`*#\[\](){}|><!,;:.?!，。；：？！、「」『』（）【】]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = [];
  for (const part of normalized.split(/\s+/)) {
    if (/[一-鿿]/.test(part)) {
      const runs = part.match(/[一-鿿]+/g) || [];
      for (const run of runs) {
        if (run.length >= 2 && run.length <= 4) tokens.push(run);
        for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
      }
      tokens.push(...part.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean));
    } else if (part.length > 1) {
      tokens.push(part);
    }
  }
  return [...new Set(tokens.filter(t => t.length > 1 && !STOP_WORDS.has(t)))];
}

function jaccardSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) { if (setB.has(x)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

// ===================== Data I/O =====================

function emptyPopulation() {
  return { version: SCHEMA_VERSION, session_count: 0, population: [] };
}

function normalizeRule(rule) {
  if (!rule.complexity) rule.complexity = 'simple';
  // Rules from before v3 keep their complexity; only rules born unclassified get an LLM pass
  if (!('classified' in rule)) rule.classified = true;
  if (!('content_hash' in rule)) rule.content_hash = null;
  if (!('skill_path' in rule)) rule.skill_path = null;
  return rule;
}

/** Read the store. Missing → empty population. Corrupt → throws (never treated as empty). */
function loadPopulation() {
  const data = readJson(RULES_PATH, emptyPopulation);
  if (data.version === 1 && Array.isArray(data.rules)) {
    // Migrate v1 → v2 shape; migrateStore() takes it the rest of the way
    return {
      version: 2, session_count: 0,
      population: data.rules.map(r => normalizeRule({
        ...r,
        score: r.fitness || 0,
        relevance_count: r.sessions_evaluated || 0,
      })),
    };
  }
  if (!Array.isArray(data.population)) data.population = [];
  for (const rule of data.population) normalizeRule(rule);
  return data;
}

// Population held by this process inside mutatePopulation (makes the lock re-entrant
// and lets reads inside a mutation see the in-flight state).
let _held = null;

function current() {
  return _held || loadPopulation();
}

function saveUnlocked(data) {
  // Keep one backup of the last good store before replacing it
  try {
    writeFileAtomic(RULES_BAK, fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  writeJsonAtomic(RULES_PATH, data);
}

/**
 * Lock rules.json, re-read it, run fn(data), save. Throwing inside fn saves nothing.
 * Never call an LLM inside fn: compute first, then apply here.
 */
function mutatePopulation(fn) {
  if (_held) return fn(_held);
  return withLock(RULES_PATH, () => {
    const data = loadPopulation();
    _held = data;
    try {
      const result = fn(data);
      saveUnlocked(data);
      return result;
    } finally {
      _held = null;
    }
  });
}

/** Legacy API: save a population loaded with loadPopulation() (demo/tests). */
function savePopulation(data) {
  if (_held) { if (data !== _held) Object.assign(_held, data); return; }
  withLock(RULES_PATH, () => saveUnlocked(data));
}

function loadRules() { return loadPopulation(); }
function saveRules(data) { savePopulation(data); }

function loadConflicts() {
  const data = readJson(CONFLICTS_PATH, () => ({ version: 1, pending: [] }));
  if (!Array.isArray(data.pending)) data.pending = [];
  return data;
}

function generateId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function logChange(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  appendBounded(CHANGELOG_PATH, line, 1024 * 1024);
}

function archiveRules(rules, reason) {
  if (!rules.length) return;
  const at = new Date().toISOString();
  const text = rules.map(r => JSON.stringify({ archived_at: at, archive_reason: reason, ...r })).join('\n');
  appendBounded(ARCHIVE_PATH, text, 5 * 1024 * 1024);
}

function setStatus(rule, status, reason) {
  rule.status = status;
  rule.status_reason = reason || null;
  rule.status_changed_at = new Date().toISOString();
}

function ageDays(isoOrDate, now) {
  const t = isoOrDate ? new Date(isoOrDate).getTime() : NaN;
  return Number.isFinite(t) ? (now - t) / DAY_MS : 0;
}

// ===================== Population queries =====================

function getByStatus(project, status) {
  return current().population.filter(r => r.project === project && r.status === status);
}
function getActiveRules(project) { return getByStatus(project, 'active'); }
function getDormant(project) { return getByStatus(project, 'dormant'); }

function incrementSession() {
  return mutatePopulation(data => {
    data.session_count = (data.session_count || 0) + 1;
    return data.session_count;
  });
}

// ===================== Add rule =====================

/**
 * Insert a rule into an already-loaded population (use inside mutatePopulation).
 * Enforces MAX_ACTIVE: an 'active' request at the cap becomes 'candidate'.
 */
function insertRule(data, project, content, source, keywords, status, complexity, reason) {
  let effectiveStatus = status || 'active';
  if (effectiveStatus === 'active') {
    const activeCount = data.population.filter(r => r.project === project && r.status === 'active').length;
    if (activeCount >= MAX_ACTIVE) effectiveStatus = 'candidate';
  }

  const id = generateId();
  const now = new Date().toISOString();
  const rule = {
    id, project, content, source,
    keywords: (keywords && keywords.length) ? keywords : extractKeywords(content),
    score: 5,  // Start at neutral (0-10 scale, 5 = untested)
    relevance_count: 0,
    sessions_evaluated: 0,
    created: now.slice(0, 10),
    status: effectiveStatus,
    status_reason: reason || null,
    status_changed_at: now,
    complexity: complexity || 'simple',
    classified: !!complexity,  // false → processRules asks the LLM for a complexity level
    content_hash: crypto.createHash('sha256').update(content).digest('hex'),
    skill_path: null,
  };
  data.population.push(rule);
  logChange({ action: 'born', rule_id: id, project, status: rule.status, source, reason: rule.status_reason, content: content.slice(0, 300) });
  return rule;
}

function addRule(project, content, source, keywords, status, complexity) {
  return mutatePopulation(data => insertRule(data, project, content, source, keywords, status, complexity));
}

// ===================== Scoring =====================

function applyScoresTo(data, project, evaluations) {
  const changes = [];
  for (const ev of evaluations || []) {
    const rule = data.population.find(r => r.id === ev.rule_id);
    if (!rule || rule.project !== project || typeof ev.score !== 'number') continue;

    const oldScore = rule.score;
    // Exponential moving average: smooths out noise, recent scores weigh more
    const alpha = 0.3;
    rule.score = parseFloat((rule.score * (1 - alpha) + ev.score * alpha).toFixed(1));
    rule.relevance_count = (rule.relevance_count || 0) + 1;
    rule.sessions_evaluated = (rule.sessions_evaluated || 0) + 1;
    rule.last_evaluated = new Date().toISOString();

    changes.push({ rule_id: rule.id, old_score: oldScore, new_score: rule.score, llm_score: ev.score, reason: ev.reason || '' });
  }
  return changes;
}

/**
 * Apply LLM evaluation results to the population.
 * @param {Array} evaluations - [{ rule_id, score: 0-10, reason: string }]
 */
function applyScores(project, evaluations) {
  return mutatePopulation(data => applyScoresTo(data, project, evaluations));
}

/**
 * Heuristic score for every active rule from the session's observation text.
 * Strong keyword hit → toward 8, partial → toward 6, no hit → decay toward 2 (slowly),
 * so a rule nobody uses for about 11 sessions falls below the demotion line.
 * Returns the number of rules whose score moved by more than 0.2.
 */
function scoreFromObservations(data, project, obsText) {
  const text = (obsText || '').toLowerCase();
  let moved = 0;
  for (const rule of data.population) {
    if (rule.project !== project || rule.status !== 'active') continue;
    const kw = rule.keywords || [];
    const hits = kw.filter(k => text.includes(String(k).toLowerCase())).length;
    const hitRatio = kw.length > 0 ? hits / kw.length : 0;

    let target = 2, alpha = 0.1;           // unused: slow decay
    if (hitRatio > 0.6) { target = 8; alpha = 0.3; }
    else if (hitRatio > 0.3) { target = 6; alpha = 0.3; }

    const oldScore = typeof rule.score === 'number' ? rule.score : 5;
    rule.score = parseFloat((oldScore * (1 - alpha) + target * alpha).toFixed(1));
    rule.sessions_evaluated = (rule.sessions_evaluated || 0) + 1;
    if (hitRatio > 0.3) rule.relevance_count = (rule.relevance_count || 0) + 1;
    rule.last_evaluated = new Date().toISOString();
    if (Math.abs(rule.score - oldScore) > 0.2) moved++;
  }
  return moved;
}

// ===================== Lifecycle =====================

const COMPLEXITY_LEVELS = ['simple', 'compound', 'workflow', 'methodology'];

/**
 * Demote low scorers, promote candidates into free slots, prune expired rules.
 * Pruning is store-wide (TTLs are time based); demotion and promotion are per project.
 * Pruned rules are archived and removed. Use inside mutatePopulation.
 */
function lifecycleIn(data, project, now) {
  now = now || Date.now();
  const demoted = [];
  const promoted = [];
  const pruned = [];

  for (const rule of data.population) {
    if (rule.project !== project || rule.status !== 'active') continue;
    const evaluated = Math.max(rule.sessions_evaluated || 0, rule.relevance_count || 0);
    if (rule.score < 3 && evaluated >= 3) {
      const hadSkill = rule.complexity === 'methodology' ? (rule.skill_path || null) : null;
      setStatus(rule, 'dormant', `low score ${rule.score}`);
      // Downgrade complexity one level, reset scoring for a fresh EMA start if revived
      const level = COMPLEXITY_LEVELS.indexOf(rule.complexity || 'simple');
      if (level > 0) rule.complexity = COMPLEXITY_LEVELS[level - 1];
      rule.score = 5;
      rule.relevance_count = 0;
      rule.sessions_evaluated = 0;
      demoted.push({ ...rule, old_skill_path: hadSkill });
      logChange({ action: 'demoted', rule_id: rule.id, project, complexity: rule.complexity, content: rule.content.slice(0, 200) });
    }
  }

  const keep = [];
  for (const rule of data.population) {
    const since = rule.status_changed_at || rule.created;
    const expired =
      !LIVE_STATUSES.includes(rule.status) ||
      (rule.status === 'candidate' && ageDays(since, now) > CANDIDATE_TTL_DAYS) ||
      (rule.status === 'dormant' && ageDays(since, now) > DORMANT_TTL_DAYS);
    if (expired) pruned.push(rule); else keep.push(rule);
  }
  if (pruned.length) {
    data.population = keep;
    archiveRules(pruned, 'ttl');
    for (const r of pruned) logChange({ action: 'pruned', rule_id: r.id, project: r.project, status: r.status });
  }

  const activeCount = data.population.filter(r => r.project === project && r.status === 'active').length;
  const slots = MAX_ACTIVE - activeCount;
  if (slots > 0) {
    const candidates = data.population
      .filter(r => r.project === project && r.status === 'candidate')
      .sort((a, b) => b.score - a.score);
    for (const rule of candidates.slice(0, slots)) {
      setStatus(rule, 'active', 'promoted into free slot');
      promoted.push(rule);
      logChange({ action: 'promoted', rule_id: rule.id, project, content: rule.content.slice(0, 200) });
    }
  }

  return { demoted, promoted, pruned };
}

function applyLifecycle(project) {
  return mutatePopulation(data => lifecycleIn(data, project));
}

// Legacy compat
function evaluateFitness() {
  // No-op since v2: scoring happens in processRules
}

// ===================== Store migration (v3) =====================

/**
 * Bring an existing store to schema v3 (runs once, under the lock):
 *  - project keys re-keyed with paths.resolveProjectRoot, the function the hooks use: keys in
 *    a git subfolder merge into the top level; plain folders outside git stay as they are
 *    (each is its own root); keys with no root (home, ignored, missing) stay and are never written
 *  - retired statuses (dead, distilled, reflected_*) archived and removed
 *  - MAX_ACTIVE enforced per project after the merge (extra rules become candidates)
 *  - pending conflicts drained: hand-written instructions win, records archived
 * Returns migration stats, or null when the store is already current.
 */
function migrateStore() {
  let stats = null;
  if ((loadPopulation().version || 0) < SCHEMA_VERSION) {
    stats = mutatePopulation(data => {
      if ((data.version || 0) >= SCHEMA_VERSION) return null;
      // Keep the pre-migration store forever (rules.json.bak rotates on every save)
      const raw = readJson(RULES_PATH, null);
      backupOriginal(RULES_PATH, `rules.v${(raw && raw.version) || 1}.bak.json`);
      return migrateIn(data);
    });
  }
  const drained = drainConflicts();
  if (stats) stats.conflicts_drained = drained;
  return stats;
}

/** Copy `file` to DATA_DIR/<name> unless that copy already exists (never overwritten). */
function backupOriginal(file, name) {
  try {
    fs.copyFileSync(file, path.join(DATA_DIR, name), fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== 'EEXIST' && e.code !== 'ENOENT') throw e;
  }
}

/** Migrated copy of a store, no side effects (dry runs). Already-current stores come back as-is. */
function previewMigration(data) {
  const copy = JSON.parse(JSON.stringify(data));
  if ((copy.version || 0) >= SCHEMA_VERSION) return copy;
  if (copy.version === 1 && Array.isArray(copy.rules)) {
    copy.population = copy.rules.map(r => normalizeRule({ ...r, score: r.fitness || 0, relevance_count: r.sessions_evaluated || 0 }));
    delete copy.rules;
  }
  migrateIn(copy, { dryRun: true });
  return copy;
}

function migrateIn(data, { dryRun = false } = {}) {
  const now = new Date().toISOString();
  const roots = new Map();
  const rootOf = key => {
    if (!roots.has(key)) roots.set(key, key ? resolveProjectRoot(key).root : null);
    return roots.get(key);
  };

  const keep = [];
  const retired = [];
  let rekeyed = 0;
  for (const rule of data.population) {
    if (!LIVE_STATUSES.includes(rule.status)) { retired.push(rule); continue; }
    const root = rootOf(rule.project);
    if (root && root !== rule.project) {
      rule.migrated_from = rule.project;
      rule.project = root;
      rekeyed++;
    }
    // Dormant rules have no "since" date before v3: their TTL starts now.
    // Candidates age from their creation date.
    if (!rule.status_changed_at && rule.status !== 'candidate') rule.status_changed_at = now;
    keep.push(rule);
  }

  // Enforce MAX_ACTIVE per project after subdirectory keys merged into roots
  let capped = 0;
  const byProject = new Map();
  for (const rule of keep) {
    if (rule.status !== 'active') continue;
    if (!byProject.has(rule.project)) byProject.set(rule.project, []);
    byProject.get(rule.project).push(rule);
  }
  for (const rules of byProject.values()) {
    if (rules.length <= MAX_ACTIVE) continue;
    rules.sort((a, b) => (b.score - a.score) || String(b.created).localeCompare(String(a.created)));
    for (const rule of rules.slice(MAX_ACTIVE)) {
      setStatus(rule, 'candidate', 'over cap after migration');
      capped++;
    }
  }

  data.population = keep;
  data.version = SCHEMA_VERSION;
  if (!dryRun) {
    archiveRules(retired, 'retired status at v3 migration');
    logChange({ action: 'migrated', version: SCHEMA_VERSION, rekeyed, archived: retired.length, capped });
  }
  return { rekeyed, archived: retired.length, capped };
}

/** Auto-resolve every pending conflict in favor of the hand-written instructions. */
function drainConflicts() {
  if (!fs.existsSync(CONFLICTS_PATH)) return 0;
  return withLock(CONFLICTS_PATH, () => {
    const data = loadConflicts();
    if (data.pending.length === 0) return 0;
    backupOriginal(CONFLICTS_PATH, `conflicts.v${data.version || 1}.bak.json`);
    const at = new Date().toISOString();
    appendBounded(CONFLICTS_ARCHIVE, data.pending.map(c => JSON.stringify({
      ...c, status: c.status === 'pending' ? 'auto_resolved' : c.status, resolution: 'kept_existing', resolved_at: c.resolved_at || at,
    })).join('\n'), 5 * 1024 * 1024);
    const n = data.pending.filter(c => c.status === 'pending').length;
    writeJsonAtomic(CONFLICTS_PATH, { version: data.version || 1, pending: [] });
    if (n) logChange({ action: 'conflicts_auto_resolved', count: n, resolution: 'kept_existing' });
    return n;
  });
}

// ===================== Duplicate checks =====================

/** True when a live (active/candidate) rule in the project has >50% keyword overlap. */
function isDuplicate(project, keywords) {
  return current().population
    .filter(r => r.project === project && (r.status === 'active' || r.status === 'candidate'))
    .some(r => jaccardSimilarity(r.keywords, keywords) > 0.5);
}

/**
 * Keyword dedupe against instruction text (hand-written CLAUDE.md, memories).
 * Similar wording means "already covered", not "conflict"; contradictions are the LLM's job.
 */
function findSimilarChunk(content, text, threshold) {
  if (!text) return { duplicate: false, similarity: 0, chunk: '' };
  const limit = threshold == null ? 0.5 : threshold;
  const kw = extractKeywords(content);
  let best = 0;
  let bestChunk = '';
  const chunks = text.split(/\n(?=[-*]|\d+\.)/).map(c => c.trim()).filter(c => c.length > 10 && !/^#{1,4}\s/.test(c));
  for (const chunk of chunks) {
    const sim = jaccardSimilarity(kw, extractKeywords(chunk));
    if (sim > best) { best = sim; bestChunk = chunk; }
  }
  return { duplicate: best > limit, similarity: parseFloat(best.toFixed(2)), chunk: bestChunk.slice(0, 300) };
}

// ===================== Stats =====================

function getPopulationStats(project) {
  const data = current();
  const pop = data.population.filter(r => r.project === project);
  const active = pop.filter(r => r.status === 'active');
  return {
    session_count: data.session_count || 0,
    total: pop.length,
    active: active.length,
    candidate: pop.filter(r => r.status === 'candidate').length,
    dormant: pop.filter(r => r.status === 'dormant').length,
    avg_score: active.length > 0 ? parseFloat((active.reduce((s, r) => s + r.score, 0) / active.length).toFixed(1)) : 0,
  };
}

// ===================== Complexity management =====================

function updateComplexity(project, ruleId, newComplexity, skillPath) {
  return mutatePopulation(data => {
    const rule = data.population.find(r => r.id === ruleId && r.project === project);
    if (!rule) return null;
    const oldComplexity = rule.complexity || 'simple';
    rule.complexity = newComplexity;
    rule.classified = true;
    if (skillPath !== undefined) rule.skill_path = skillPath;
    logChange({ action: 'complexity_change', rule_id: ruleId, project, old: oldComplexity, new: newComplexity, skill_path: rule.skill_path });
    return rule;
  });
}

function getRelatedRules(project, rule, threshold) {
  if (threshold === undefined || threshold === null) threshold = 0.3;
  const ruleKw = rule.keywords || extractKeywords(rule.content || '');
  return current().population.filter(r => {
    if (r.project !== project || r.id === rule.id) return false;
    return jaccardSimilarity(ruleKw, r.keywords || []) > threshold;
  });
}

module.exports = {
  extractKeywords, jaccardSimilarity,
  loadPopulation, savePopulation, mutatePopulation, loadRules, saveRules,
  loadConflicts, drainConflicts,
  generateId, logChange, archiveRules, setStatus,
  insertRule, addRule, getActiveRules, getDormant, getByStatus,
  incrementSession,
  applyScores, applyScoresTo, scoreFromObservations,
  applyLifecycle, lifecycleIn, evaluateFitness,
  migrateStore, previewMigration,
  isDuplicate, findSimilarChunk, getPopulationStats,
  updateComplexity, getRelatedRules,
  MAX_ACTIVE, SCHEMA_VERSION, CANDIDATE_TTL_DAYS, DORMANT_TTL_DAYS,
  RULES_PATH, ARCHIVE_PATH,
};
