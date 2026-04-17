#!/usr/bin/env node
// ruleEngine.js — Rule population engine (signal-gene pipeline)
//
// Population:
//   active  — in CLAUDE.md, evaluated by LLM each session
//   dormant — demoted, kept in pool (LLM can revive during optimize)
//   dead    — dormant for too long, archived
//
// Scoring:
//   LLM evaluates each active rule per session: 0-10 score
//   Rules below threshold after enough sessions → dormant
//   No manual +1/-2. No confidence formula. LLM judges directly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const RULES_PATH = path.join(DATA_DIR, 'rules.json');
const CONFLICTS_PATH = path.join(DATA_DIR, 'conflicts.json');
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.jsonl');

const MAX_ACTIVE = 10;             // Max rules in CLAUDE.md
const DORMANT_TTL_SESSIONS = 15;   // Die after 15 sessions in dormant

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
    if (/[\u4e00-\u9fff]/.test(part)) {
      const runs = part.match(/[\u4e00-\u9fff]+/g) || [];
      for (const run of runs) {
        if (run.length >= 2 && run.length <= 4) tokens.push(run);
        for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
      }
      tokens.push(...part.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean));
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

function loadPopulation() {
  try {
    const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    if (data.version === 1 && Array.isArray(data.rules)) {
      // Migrate v1 → v2
      return {
        version: 2, session_count: 0,
        population: data.rules.map(r => ({
          ...r,
          score: r.fitness || 0,
          relevance_count: r.sessions_evaluated || 0,
          dormant_since_session: 0,
        })),
      };
    }
    // Migrate: backfill complexity tracking fields for existing rules
    for (const rule of data.population || []) {
      if (!rule.complexity) rule.complexity = 'simple';
      if (!('content_hash' in rule)) rule.content_hash = null;
      if (!('skill_path' in rule)) rule.skill_path = null;
    }
    return data;
  } catch {
    return { version: 2, session_count: 0, population: [] };
  }
}

function savePopulation(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = RULES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, RULES_PATH);
}

function loadRules() { return loadPopulation(); }
function saveRules(data) { savePopulation(data); }

function loadConflicts() {
  try { return JSON.parse(fs.readFileSync(CONFLICTS_PATH, 'utf8')); }
  catch { return { version: 1, pending: [] }; }
}

function saveConflicts(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFLICTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFLICTS_PATH);
}

function generateId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

const MAX_LOG_LINES = 500;

function logChange(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(CHANGELOG_PATH, line, 'utf8');
  if (Math.random() < 0.02) {
    try {
      const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').trim().split('\n');
      if (lines.length > MAX_LOG_LINES) {
        fs.writeFileSync(CHANGELOG_PATH + '.tmp', lines.slice(-MAX_LOG_LINES).join('\n') + '\n', 'utf8');
        fs.renameSync(CHANGELOG_PATH + '.tmp', CHANGELOG_PATH);
      }
    } catch {}
  }
}

// ===================== Population queries =====================

function getByStatus(project, status) {
  return loadPopulation().population.filter(r => r.project === project && r.status === status);
}
function getActiveRules(project) { return getByStatus(project, 'active'); }
function getDormant(project) { return getByStatus(project, 'dormant'); }

function incrementSession(project) {
  const data = loadPopulation();
  data.session_count = (data.session_count || 0) + 1;
  savePopulation(data);
  return data.session_count;
}

// ===================== Add rule =====================

function addRule(project, content, source, keywords, status, complexity) {
  const data = loadPopulation();

  // Enforce MAX_ACTIVE: if requesting active but at cap, downgrade to candidate
  let effectiveStatus = status || 'active';
  if (effectiveStatus === 'active') {
    const activeCount = data.population.filter(r => r.project === project && r.status === 'active').length;
    if (activeCount >= MAX_ACTIVE) effectiveStatus = 'candidate';
  }

  const id = generateId();
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const rule = {
    id, project, content, source,
    keywords: keywords || extractKeywords(content),
    score: 5,  // Start at neutral (0-10 scale, 5 = untested)
    relevance_count: 0,
    sessions_evaluated: 0,
    created: new Date().toISOString().slice(0, 10),
    status: effectiveStatus,
    dormant_since_session: 0,
    complexity: complexity || 'simple',
    content_hash: contentHash,
    skill_path: null,
  };
  data.population.push(rule);
  savePopulation(data);
  logChange({ action: 'born', rule_id: id, project, status: rule.status, source, content: content.slice(0, 300) });
  return rule;
}

// ===================== LLM-driven scoring =====================

/**
 * Apply LLM evaluation results to the population.
 * @param {string} project
 * @param {Array} evaluations - [{ rule_id, score: 0-10, reason: string }]
 */
function applyScores(project, evaluations) {
  const data = loadPopulation();
  const changes = [];

  for (const ev of evaluations) {
    const rule = data.population.find(r => r.id === ev.rule_id);
    if (!rule || rule.project !== project) continue;

    const oldScore = rule.score;
    // Exponential moving average: smooths out noise, recent scores weigh more
    const alpha = 0.3; // 30% new, 70% old
    rule.score = parseFloat((rule.score * (1 - alpha) + ev.score * alpha).toFixed(1));
    rule.relevance_count = (rule.relevance_count || 0) + 1;
    rule.sessions_evaluated = (rule.sessions_evaluated || 0) + 1;

    changes.push({
      rule_id: rule.id,
      old_score: oldScore,
      new_score: rule.score,
      llm_score: ev.score,
      reason: ev.reason || '',
    });
  }

  savePopulation(data);
  return changes;
}

/**
 * Demote low-scoring rules to dormant. Promote high-scoring candidates.
 * Kill long-dormant rules.
 * @param {string} project
 * @param {number} sessionCount - current global session count
 */
const COMPLEXITY_LEVELS = ['simple', 'compound', 'workflow', 'methodology'];

function applyLifecycle(project, sessionCount) {
  const data = loadPopulation();
  const demoted = [];
  const promoted = [];
  const killed = [];

  // Demote: active rules with score < 3 after 3+ evaluations
  for (const rule of data.population) {
    if (rule.project !== project) continue;

    if (rule.status === 'active' && rule.score < 3 && rule.relevance_count >= 3) {
      rule.status = 'dormant';
      rule.dormant_since_session = sessionCount;

      // Track skill file info before complexity downgrade
      const hadSkillFile = rule.complexity === 'methodology' && !!rule.skill_path;
      const oldSkillPath = rule.skill_path || null;

      // Downgrade complexity one level
      const currentLevel = COMPLEXITY_LEVELS.indexOf(rule.complexity || 'simple');
      if (currentLevel > 0) {
        rule.complexity = COMPLEXITY_LEVELS[currentLevel - 1];
      }
      // Reset scoring for fresh EMA start
      rule.score = 5;
      rule.relevance_count = 0;
      rule.sessions_evaluated = 0;

      demoted.push({ ...rule, had_skill_file: hadSkillFile, old_skill_path: oldSkillPath });
      logChange({ action: 'demoted', rule_id: rule.id, project, score: rule.score, complexity: rule.complexity, content: rule.content.slice(0, 200) });
    }

    // Kill dormant rules that have been dormant too long
    if (rule.status === 'dormant' && rule.dormant_since_session > 0) {
      if (sessionCount - rule.dormant_since_session >= DORMANT_TTL_SESSIONS) {
        rule.status = 'dead';
        killed.push(rule);
        logChange({ action: 'dead', rule_id: rule.id, project, content: rule.content.slice(0, 200) });
      }
    }
  }

  // Promote: if active count < MAX_ACTIVE, promote top-scoring candidates
  const activeCount = data.population.filter(r => r.project === project && r.status === 'active').length;
  const slots = MAX_ACTIVE - activeCount;
  if (slots > 0) {
    const candidates = data.population
      .filter(r => r.project === project && r.status === 'candidate')
      .sort((a, b) => b.score - a.score);
    for (const rule of candidates.slice(0, slots)) {
      rule.status = 'active';
      promoted.push(rule);
      logChange({ action: 'promoted', rule_id: rule.id, project, content: rule.content.slice(0, 200) });
    }
  }

  savePopulation(data);
  return { demoted, promoted, killed };
}

// Legacy compat
function evaluateFitness(project) {
  // No-op in v2, scoring is done by applyScores
}

// ===================== Conflict detection =====================

function detectConflict(newContent, handWrittenContent) {
  if (!handWrittenContent) return { hasConflict: false, similarity: 0 };
  const newKw = extractKeywords(newContent);
  const chunks = handWrittenContent
    .split(/\n(?=[-*]|\d+\.)/).map(c => c.trim())
    .filter(c => c.length > 10 && !c.match(/^#{1,4}\s/));
  let maxSim = 0;
  let conflictChunk = '';
  for (const chunk of chunks) {
    const sim = Math.max(
      jaccardSimilarity(newKw, extractKeywords(chunk)),
      semanticOverlap(newContent, chunk)
    );
    if (sim > maxSim) { maxSim = sim; conflictChunk = chunk; }
  }
  return { hasConflict: maxSim > 0.3, similarity: parseFloat(maxSim.toFixed(2)), conflictsWith: conflictChunk.slice(0, 500) };
}

function semanticOverlap(a, b) {
  const ca = extractConcepts(a);
  const cb = extractConcepts(b);
  if (ca.size === 0 || cb.size === 0) return 0;
  let overlap = 0;
  for (const c of ca) { if (cb.has(c)) overlap++; }
  return overlap < 2 ? 0 : overlap / Math.min(ca.size, cb.size);
}

function extractConcepts(text) {
  const lower = text.toLowerCase();
  const concepts = new Set();
  const terms = lower.match(/[a-z][a-z0-9_-]{1,30}/g) || [];
  for (const t of terms) { if (!STOP_WORDS.has(t) && t.length > 2) concepts.add(t); }
  return concepts;
}

function addConflict(project, newContent, conflictsWith, similarity) {
  const data = loadConflicts();
  const id = 'c_' + Date.now().toString(36);
  data.pending.push({ id, project, new_content: newContent, conflicts_with: conflictsWith, similarity, created: new Date().toISOString(), status: 'pending' });
  saveConflicts(data);
  logChange({ action: 'conflict', conflict_id: id, project, new_content: newContent.slice(0, 200) });
  return id;
}

function getPendingConflicts(project) {
  return loadConflicts().pending.filter(c => c.project === project && c.status === 'pending');
}

function resolveConflict(conflictId, resolution) {
  const data = loadConflicts();
  const c = data.pending.find(x => x.id === conflictId);
  if (!c) return null;
  c.status = resolution;
  c.resolved_at = new Date().toISOString();
  saveConflicts(data);
  return c;
}

// ===================== Duplicate check =====================

function isDuplicate(project, keywords) {
  return loadPopulation().population
    .filter(r => r.project === project && (r.status === 'active' || r.status === 'candidate'))
    .some(r => jaccardSimilarity(r.keywords, keywords) > 0.5);
}

// ===================== Stats =====================

function getPopulationStats(project) {
  const data = loadPopulation();
  const pop = data.population.filter(r => r.project === project);
  const active = pop.filter(r => r.status === 'active');
  return {
    session_count: data.session_count || 0,
    total: pop.length,
    active: active.length,
    candidate: pop.filter(r => r.status === 'candidate').length,
    dormant: pop.filter(r => r.status === 'dormant').length,
    dead: pop.filter(r => r.status === 'dead').length,
    avg_score: active.length > 0 ? parseFloat((active.reduce((s, r) => s + r.score, 0) / active.length).toFixed(1)) : 0,
  };
}

// ===================== Complexity management =====================

function updateComplexity(project, ruleId, newComplexity, skillPath) {
  const data = loadPopulation();
  const rule = data.population.find(r => r.id === ruleId && r.project === project);
  if (!rule) return null;
  const oldComplexity = rule.complexity || 'simple';
  rule.complexity = newComplexity;
  if (skillPath !== undefined) rule.skill_path = skillPath;
  savePopulation(data);
  logChange({ action: 'complexity_change', rule_id: ruleId, project, old: oldComplexity, new: newComplexity, skill_path: rule.skill_path });
  return rule;
}

function getRelatedRules(project, rule, threshold) {
  if (threshold === undefined || threshold === null) threshold = 0.3;
  const pop = loadPopulation().population;
  const ruleKw = rule.keywords || extractKeywords(rule.content || '');
  return pop.filter(r => {
    if (r.project !== project || r.id === rule.id) return false;
    const sim = jaccardSimilarity(ruleKw, r.keywords || []);
    return sim > threshold;
  });
}

module.exports = {
  extractKeywords, jaccardSimilarity,
  loadPopulation, savePopulation, loadRules, saveRules,
  loadConflicts, saveConflicts,
  generateId, logChange,
  addRule, getActiveRules, getDormant, getByStatus,
  incrementSession,
  applyScores, applyLifecycle, evaluateFitness,
  detectConflict, addConflict, getPendingConflicts, resolveConflict,
  isDuplicate, getPopulationStats,
  updateComplexity, getRelatedRules,
  MAX_ACTIVE,
};
