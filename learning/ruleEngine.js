#!/usr/bin/env node
// ruleEngine.js — Genetic Algorithm engine for rule evolution
//
// Population model:
//   active    — in CLAUDE.md, being tested every session
//   candidate — newly born (crossover/mutation/correction), waiting for a slot
//   dormant   — demoted from active, kept in gene pool for immigration
//   dead      — failed tournament 3 generations in a row, archived
//
// Fitness model:
//   Only scored when RELEVANT to a session (LLM decides relevance)
//   +1  rule relevant + behavior follows rule (validated)
//   -1  rule relevant + behavior violates rule (ignored by user)
//   -3  rule relevant + user explicitly corrected same topic (failed)
//    0  rule not relevant to this session (no score change)
//   confidence = fitness / sqrt(max(relevance_count, 1))
//
// Generation cycle (every GENERATION_SIZE sessions):
//   1. Evaluate fitness (relevance-aware)
//   2. Tournament selection (bottom rules demoted, top stay)
//   3. Crossover (combine two high-fitness rules)
//   4. Mutation (LLM rewrites a rule variant)
//   5. Immigration (promote dormant rules back)
//   6. Promote candidates to active (if slots available)
//   7. Write active rules to CLAUDE.md

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const RULES_PATH = path.join(DATA_DIR, 'rules.json');
const CONFLICTS_PATH = path.join(DATA_DIR, 'conflicts.json');
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.jsonl');

// GA parameters
const GENERATION_SIZE = 5;         // Sessions per generation
const MAX_ACTIVE = 10;             // Max rules in CLAUDE.md at once
const TOURNAMENT_CULL_RATIO = 0.2; // Bottom 20% demoted each generation
const IMMIGRATION_RATE = 0.1;      // 10% chance to revive a dormant rule
const MUTATION_RATE = 0.2;         // 20% of active rules get a mutation variant
const CROSSOVER_COUNT = 1;         // Number of crossover offspring per generation
const DEAD_AFTER_DORMANT_GENS = 3; // Die after 3 generations in dormant

// ===================== Stop words & keyword extraction =====================

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
  const parts = normalized.split(/\s+/);
  for (const part of parts) {
    if (/[\u4e00-\u9fff]/.test(part)) {
      const cjkRuns = part.match(/[\u4e00-\u9fff]+/g) || [];
      for (const run of cjkRuns) {
        if (run.length <= 4 && run.length >= 2) tokens.push(run);
        for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
      }
      const nonCjk = part.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean);
      tokens.push(...nonCjk);
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
  let intersection = 0;
  for (const x of setA) { if (setB.has(x)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ===================== Data I/O =====================

function loadPopulation() {
  try {
    const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    // Migrate from v1 flat format
    if (data.version === 1 && Array.isArray(data.rules)) {
      return migrateV1ToV2(data);
    }
    return data;
  } catch {
    return createEmptyPopulation();
  }
}

function createEmptyPopulation() {
  return {
    version: 2,
    generation: 0,
    sessions_in_generation: 0,
    population: [], // All rules regardless of status
  };
}

function migrateV1ToV2(v1Data) {
  const pop = createEmptyPopulation();
  for (const rule of (v1Data.rules || [])) {
    pop.population.push({
      ...rule,
      relevance_count: rule.sessions_evaluated || 0,
      dormant_generations: 0,
      born_generation: 0,
      last_generation_scored: 0,
    });
  }
  return pop;
}

function savePopulation(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = RULES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, RULES_PATH);
}

// Backward compat: loadRules/saveRules still work
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
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_LOG_LINES) {
        fs.writeFileSync(CHANGELOG_PATH + '.tmp', lines.slice(-MAX_LOG_LINES).join('\n') + '\n', 'utf8');
        fs.renameSync(CHANGELOG_PATH + '.tmp', CHANGELOG_PATH);
      }
    } catch {}
  }
}

// ===================== Population queries =====================

function getByStatus(project, status) {
  const data = loadPopulation();
  return data.population.filter(r => r.project === project && r.status === status);
}

function getActiveRules(project) { return getByStatus(project, 'active'); }
function getCandidates(project) { return getByStatus(project, 'candidate'); }
function getDormant(project) { return getByStatus(project, 'dormant'); }

/**
 * Confidence score: separates "tested and good" from "untested".
 * High fitness + high relevance = truly good.
 * High fitness + low relevance = just untested.
 */
function confidence(rule) {
  return rule.fitness / Math.sqrt(Math.max(rule.relevance_count || 1, 1));
}

// ===================== Add rules to population =====================

function addRule(project, content, source, keywords, status) {
  const data = loadPopulation();
  const kw = keywords || extractKeywords(content);
  const id = generateId();
  const rule = {
    id, project, type: 'rule',
    content, source,
    keywords: kw,
    fitness: 0,
    relevance_count: 0,
    created: new Date().toISOString().slice(0, 10),
    last_evaluated: new Date().toISOString().slice(0, 10),
    sessions_evaluated: 0,
    status: status || 'candidate', // New rules start as candidates
    born_generation: data.generation,
    last_generation_scored: data.generation,
    dormant_generations: 0,
  };
  data.population.push(rule);
  savePopulation(data);
  logChange({ action: 'born', rule_id: id, project, status: rule.status, source, content: content.slice(0, 300) });
  return rule;
}

// ===================== Fitness scoring (relevance-aware) =====================

/**
 * Score rules based on LLM relevance evaluation results.
 * @param {string} project
 * @param {Array} evaluations - [{ rule_id, relevant: bool, followed: bool, corrected: bool }]
 */
function scoreFitness(project, evaluations) {
  const data = loadPopulation();
  const changes = [];

  for (const ev of evaluations) {
    const rule = data.population.find(r => r.id === ev.rule_id);
    if (!rule || rule.project !== project) continue;

    rule.sessions_evaluated += 1;
    rule.last_evaluated = new Date().toISOString().slice(0, 10);

    if (!ev.relevant) {
      // Not relevant to this session — no score change
      changes.push({ rule_id: rule.id, delta: 0, reason: 'not_relevant' });
      continue;
    }

    rule.relevance_count = (rule.relevance_count || 0) + 1;

    if (ev.corrected) {
      // Rule topic was explicitly corrected — rule failed hard
      rule.fitness -= 3;
      changes.push({ rule_id: rule.id, delta: -3, reason: 'corrected' });
    } else if (ev.followed) {
      // Rule was relevant and behavior followed it — validated
      rule.fitness += 1;
      changes.push({ rule_id: rule.id, delta: +1, reason: 'followed' });
    } else {
      // Rule was relevant but behavior violated it (no correction though)
      rule.fitness -= 1;
      changes.push({ rule_id: rule.id, delta: -1, reason: 'violated' });
    }
  }

  savePopulation(data);
  return changes;
}

// Legacy fallback for old code
function evaluateFitness(project, correctionKeywords, skipIds, correctionTexts) {
  // Old-style: all active rules get +1 unless corrected
  const data = loadPopulation();
  const skip = skipIds || new Set();
  const rules = data.population.filter(r => r.project === project && r.status === 'active' && !skip.has(r.id));
  for (const rule of rules) {
    rule.fitness += 1;
    rule.sessions_evaluated += 1;
    rule.relevance_count = (rule.relevance_count || 0) + 1;
    rule.last_evaluated = new Date().toISOString().slice(0, 10);
  }
  savePopulation(data);
}

// ===================== Generation cycle =====================

/**
 * Record that a session happened. Returns true if a new generation should run.
 */
function tickSession(project) {
  const data = loadPopulation();
  data.sessions_in_generation = (data.sessions_in_generation || 0) + 1;
  savePopulation(data);
  return data.sessions_in_generation >= GENERATION_SIZE;
}

/**
 * Run tournament selection on active rules.
 * Bottom TOURNAMENT_CULL_RATIO are demoted to dormant.
 * Returns { promoted: [], demoted: [] }.
 */
function tournamentSelection(project) {
  const data = loadPopulation();
  const active = data.population.filter(r => r.project === project && r.status === 'active');

  if (active.length <= 2) return { promoted: [], demoted: [] };

  // Sort by confidence (fitness / sqrt(relevance)), not raw fitness
  active.sort((a, b) => confidence(b) - confidence(a));

  const cullCount = Math.max(1, Math.floor(active.length * TOURNAMENT_CULL_RATIO));
  const demoted = active.slice(-cullCount);

  for (const rule of demoted) {
    const r = data.population.find(x => x.id === rule.id);
    if (r) {
      r.status = 'dormant';
      r.dormant_generations = 0;
      logChange({
        action: 'demoted', rule_id: r.id, project,
        fitness: r.fitness, confidence: confidence(r).toFixed(2),
        relevance: r.relevance_count, content: r.content.slice(0, 200),
      });
    }
  }

  // Promote top candidates to fill slots
  const slots = MAX_ACTIVE - (active.length - cullCount);
  const candidates = data.population
    .filter(r => r.project === project && r.status === 'candidate')
    .sort((a, b) => b.fitness - a.fitness);

  const promoted = candidates.slice(0, Math.max(0, slots));
  for (const rule of promoted) {
    const r = data.population.find(x => x.id === rule.id);
    if (r) {
      r.status = 'active';
      logChange({
        action: 'promoted', rule_id: r.id, project,
        content: r.content.slice(0, 200), source: r.source,
      });
    }
  }

  // Age dormant rules — die after DEAD_AFTER_DORMANT_GENS generations
  for (const rule of data.population) {
    if (rule.project === project && rule.status === 'dormant') {
      rule.dormant_generations = (rule.dormant_generations || 0) + 1;
      if (rule.dormant_generations >= DEAD_AFTER_DORMANT_GENS) {
        rule.status = 'dead';
        logChange({
          action: 'dead', rule_id: rule.id, project,
          content: rule.content.slice(0, 200), reason: 'dormant_too_long',
        });
      }
    }
  }

  savePopulation(data);
  return { promoted, demoted };
}

/**
 * Immigration: randomly revive dormant rules back to candidate.
 */
function immigration(project) {
  const data = loadPopulation();
  const dormant = data.population.filter(r => r.project === project && r.status === 'dormant');
  const revived = [];

  for (const rule of dormant) {
    if (Math.random() < IMMIGRATION_RATE) {
      rule.status = 'candidate';
      rule.dormant_generations = 0;
      revived.push(rule);
      logChange({
        action: 'immigration', rule_id: rule.id, project,
        content: rule.content.slice(0, 200),
      });
    }
  }

  if (revived.length > 0) savePopulation(data);
  return revived;
}

/**
 * Advance to next generation. Reset session counter.
 */
function advanceGeneration(project) {
  const data = loadPopulation();
  data.generation = (data.generation || 0) + 1;
  data.sessions_in_generation = 0;

  // Mark all active rules with current generation
  for (const rule of data.population) {
    if (rule.project === project && rule.status === 'active') {
      rule.last_generation_scored = data.generation;
    }
  }

  savePopulation(data);
  logChange({ action: 'new_generation', generation: data.generation, project });
  return data.generation;
}

// ===================== Conflict detection =====================

function semanticSimilarity(textA, textB) {
  const conceptsA = extractConcepts(textA);
  const conceptsB = extractConcepts(textB);
  if (conceptsA.size === 0 || conceptsB.size === 0) return 0;
  let overlap = 0;
  for (const c of conceptsA) { if (conceptsB.has(c)) overlap++; }
  if (overlap < 2) return 0;
  const smaller = Math.min(conceptsA.size, conceptsB.size);
  return smaller === 0 ? 0 : overlap / smaller;
}

function extractConcepts(text) {
  const lower = text.toLowerCase();
  const concepts = new Set();
  const enTerms = lower.match(/[a-z][a-z0-9_-]{1,30}/g) || [];
  for (const t of enTerms) {
    if (!STOP_WORDS.has(t) && t.length > 2) concepts.add(t);
  }
  const domainTerms = lower.match(/\b(sql|api|dag|etl|cte|dry.?run|select|filter|query|table|date|event|metric|deploy|config|test|lint|build|docker|claude\.md|skill\.md)\b/g) || [];
  for (const t of domainTerms) concepts.add(t.replace(/[^a-z_.]/g, ''));
  return concepts;
}

function detectConflict(newContent, handWrittenContent) {
  if (!handWrittenContent) return { hasConflict: false, similarity: 0 };
  const newKw = extractKeywords(newContent);
  const chunks = handWrittenContent
    .split(/\n(?=[-*]|\d+\.)/)
    .map(c => c.trim())
    .filter(c => c.length > 10 && !c.match(/^#{1,4}\s/));
  let maxSim = 0;
  let conflictChunk = '';
  for (const chunk of chunks) {
    const kwSim = jaccardSimilarity(newKw, extractKeywords(chunk));
    const semSim = semanticSimilarity(newContent, chunk);
    const combined = Math.max(kwSim, semSim);
    if (combined > maxSim) { maxSim = combined; conflictChunk = chunk; }
  }
  return {
    hasConflict: maxSim > 0.3,
    similarity: parseFloat(maxSim.toFixed(2)),
    conflictsWith: conflictChunk.slice(0, 500),
  };
}

function addConflict(project, newContent, conflictsWith, similarity) {
  const data = loadConflicts();
  const id = 'c_' + Date.now().toString(36);
  data.pending.push({
    id, project, new_content: newContent,
    conflicts_with: conflictsWith,
    similarity: parseFloat(similarity.toFixed(2)),
    created: new Date().toISOString(), status: 'pending',
  });
  saveConflicts(data);
  logChange({ action: 'conflict_detected', conflict_id: id, project, new_content: newContent.slice(0, 200) });
  return id;
}

function getPendingConflicts(project) {
  return loadConflicts().pending.filter(c => c.project === project && c.status === 'pending');
}

function resolveConflict(conflictId, resolution) {
  const data = loadConflicts();
  const conflict = data.pending.find(c => c.id === conflictId);
  if (!conflict) return null;
  conflict.status = resolution;
  conflict.resolved_at = new Date().toISOString();
  saveConflicts(data);
  logChange({ action: 'conflict_resolved', conflict_id: conflictId, resolution });
  return conflict;
}

// ===================== Duplicate check =====================

function isDuplicate(project, keywords) {
  const pop = loadPopulation().population;
  return pop
    .filter(r => r.project === project && (r.status === 'active' || r.status === 'candidate'))
    .some(r => jaccardSimilarity(r.keywords, keywords) > 0.5);
}

// ===================== Population stats =====================

function getPopulationStats(project) {
  const data = loadPopulation();
  const pop = data.population.filter(r => r.project === project);
  return {
    generation: data.generation,
    sessions_in_generation: data.sessions_in_generation,
    total: pop.length,
    active: pop.filter(r => r.status === 'active').length,
    candidate: pop.filter(r => r.status === 'candidate').length,
    dormant: pop.filter(r => r.status === 'dormant').length,
    dead: pop.filter(r => r.status === 'dead').length,
    avg_fitness: pop.filter(r => r.status === 'active').length > 0
      ? (pop.filter(r => r.status === 'active').reduce((s, r) => s + r.fitness, 0) / pop.filter(r => r.status === 'active').length).toFixed(1)
      : 0,
    avg_confidence: pop.filter(r => r.status === 'active').length > 0
      ? (pop.filter(r => r.status === 'active').reduce((s, r) => s + confidence(r), 0) / pop.filter(r => r.status === 'active').length).toFixed(2)
      : 0,
  };
}

module.exports = {
  // Keywords
  extractKeywords, jaccardSimilarity,
  // Data I/O
  loadPopulation, savePopulation, loadRules, saveRules,
  loadConflicts, saveConflicts,
  generateId, logChange,
  // Population
  addRule, getActiveRules, getCandidates, getDormant, getByStatus,
  confidence,
  // Fitness
  scoreFitness, evaluateFitness,
  // Generation cycle
  tickSession, tournamentSelection, immigration, advanceGeneration,
  // Conflict
  detectConflict, addConflict, getPendingConflicts, resolveConflict,
  // Utils
  isDuplicate, getPopulationStats,
  // Constants (exposed for processRules)
  GENERATION_SIZE, MAX_ACTIVE, MUTATION_RATE, CROSSOVER_COUNT,
};
