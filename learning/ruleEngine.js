#!/usr/bin/env node
// ruleEngine.js — Core rule management for evolver learning system
// Handles: rule CRUD, fitness scoring, pruning, distillation, conflict detection, changelog

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const RULES_PATH = path.join(DATA_DIR, 'rules.json');
const CONFLICTS_PATH = path.join(DATA_DIR, 'conflicts.json');
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.jsonl');

// --- Stop words (EN + ZH-TW) for keyword extraction ---

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
  // ZH common particles
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '個', '上', '也', '很', '到', '說', '要', '去', '你', '會', '著', '沒有',
  '看', '好', '自己', '這', '他', '她', '們', '吧', '被', '把', '讓', '用',
  '那', '什麼', '怎麼', '如果', '可以', '因為', '所以', '但是', '還是',
  '或者', '而且', '嗎', '呢', '啊', '喔', '欸', '對',
]);

// --- Keyword extraction & similarity ---

function extractKeywords(text) {
  if (!text) return [];
  const normalized = text.toLowerCase()
    .replace(/[`*#\[\](){}|><!,;:.?!，。；：？！、「」『』（）【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split on whitespace, extract CJK as both 2-grams and whole runs (for exact match)
  const tokens = [];
  const parts = normalized.split(/\s+/);
  for (const part of parts) {
    if (/[\u4e00-\u9fff]/.test(part)) {
      // Extract contiguous CJK runs
      const cjkRuns = part.match(/[\u4e00-\u9fff]+/g) || [];
      for (const run of cjkRuns) {
        // Keep whole run as a token if short enough (≤4 chars = one concept)
        if (run.length <= 4 && run.length >= 2) tokens.push(run);
        // Always add 2-grams for partial matching
        for (let i = 0; i < run.length - 1; i++) {
          tokens.push(run.slice(i, i + 2));
        }
      }
      // Also extract non-CJK parts (e.g., "my-service")
      const nonCjk = part.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean);
      tokens.push(...nonCjk);
    } else if (part.length > 1) {
      tokens.push(part);
    }
  }

  const filtered = tokens.filter(t => t.length > 1 && !STOP_WORDS.has(t));
  return [...new Set(filtered)];
}

function jaccardSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Data I/O (atomic writes) ---

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch {
    return { version: 1, rules: [] };
  }
}

function saveRules(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = RULES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, RULES_PATH);
}

function loadConflicts() {
  try {
    return JSON.parse(fs.readFileSync(CONFLICTS_PATH, 'utf8'));
  } catch {
    return { version: 1, pending: [] };
  }
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

const MAX_LOG_LINES = 500; // Rotate logs at 500 entries

function logChange(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(CHANGELOG_PATH, line, 'utf8');

  // Rotate if too large (check every ~50 writes to avoid stat overhead)
  if (Math.random() < 0.02) {
    try {
      const content = fs.readFileSync(CHANGELOG_PATH, 'utf8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_LOG_LINES) {
        const kept = lines.slice(-MAX_LOG_LINES).join('\n') + '\n';
        fs.writeFileSync(CHANGELOG_PATH + '.tmp', kept, 'utf8');
        fs.renameSync(CHANGELOG_PATH + '.tmp', CHANGELOG_PATH);
      }
    } catch {}
  }
}

// --- Rule CRUD ---

function addRule(project, content, source, keywords) {
  const data = loadRules();
  const kw = keywords || extractKeywords(content);
  const id = generateId();
  const rule = {
    id,
    project,
    type: 'rule',
    content,
    source, // 'correction' | 'pattern' | 'confirmation'
    keywords: kw,
    fitness: 0,
    created: new Date().toISOString().slice(0, 10),
    last_evaluated: new Date().toISOString().slice(0, 10),
    sessions_evaluated: 0,
    status: 'active',
  };
  data.rules.push(rule);
  saveRules(data);
  logChange({ action: 'add_rule', rule_id: id, project, content: content.slice(0, 300), source });
  return rule;
}

function getActiveRules(project) {
  const data = loadRules();
  return data.rules.filter(r => r.project === project && r.status === 'active');
}

// --- Fitness scoring ---
// +1 per session with no re-correction on the same topic
// -2 when the same topic is corrected again

function evaluateFitness(project, newCorrectionKeywords, skipRuleIds, newCorrectionTexts) {
  const data = loadRules();
  const skip = skipRuleIds || new Set();
  const corrTexts = newCorrectionTexts || [];
  const projectRules = data.rules.filter(r => r.project === project && r.status === 'active' && !skip.has(r.id));
  const changes = [];

  for (const rule of projectRules) {
    let reCorrected = false;

    for (let ci = 0; ci < newCorrectionKeywords.length; ci++) {
      const corrKw = newCorrectionKeywords[ci];
      const kwSim = jaccardSimilarity(rule.keywords, corrKw);

      // Also check semantic similarity if text is available
      let semSim = 0;
      if (corrTexts[ci]) {
        semSim = semanticSimilarity(rule.content, corrTexts[ci]);
      }

      const bestSim = Math.max(kwSim, semSim);

      if (bestSim > 0.2) {
        rule.fitness -= 2;
        rule.last_evaluated = new Date().toISOString().slice(0, 10);
        rule.sessions_evaluated += 1;
        reCorrected = true;
        changes.push({
          rule_id: rule.id, delta: -2, reason: 'correction_repeated',
          similarity: parseFloat(bestSim.toFixed(2)),
        });
        break;
      }
    }

    if (!reCorrected) {
      // No correction on this topic — rule is working
      rule.fitness += 1;
      rule.last_evaluated = new Date().toISOString().slice(0, 10);
      rule.sessions_evaluated += 1;
      changes.push({ rule_id: rule.id, delta: +1, reason: 'no_correction' });
    }
  }

  if (changes.length > 0) saveRules(data);
  return changes;
}

// --- Pruning: remove rules with fitness < -3 after 5+ sessions ---

function pruneRules(project) {
  const data = loadRules();
  const pruned = [];

  for (const rule of data.rules) {
    if (rule.project !== project || rule.status !== 'active') continue;
    if (rule.sessions_evaluated >= 5 && rule.fitness < -3) {
      rule.status = 'pruned';
      pruned.push({ ...rule });
      logChange({
        action: 'prune_rule', rule_id: rule.id, project,
        fitness: rule.fitness, sessions: rule.sessions_evaluated,
        content: rule.content.slice(0, 200),
      });
    }
  }

  if (pruned.length > 0) saveRules(data);
  return pruned;
}

// --- Conflict detection ---
// Checks if a new rule's content has high keyword overlap with hand-written CLAUDE.md content.
// High overlap + different instruction = potential conflict.

function detectConflict(newContent, handWrittenContent) {
  if (!handWrittenContent) return { hasConflict: false, similarity: 0 };

  const newKw = extractKeywords(newContent);

  // Split hand-written content into logical chunks (list items / paragraphs)
  // Skip section headers (##) — they're too generic to conflict with
  const chunks = handWrittenContent
    .split(/\n(?=[-*]|\d+\.)/)
    .map(c => c.trim())
    .filter(c => c.length > 10 && !c.match(/^#{1,4}\s/));

  let maxSim = 0;
  let maxSemanticSim = 0;
  let conflictChunk = '';

  for (const chunk of chunks) {
    const chunkKw = extractKeywords(chunk);

    // Strategy 1: Jaccard keyword similarity
    const kwSim = jaccardSimilarity(newKw, chunkKw);

    // Strategy 2: Semantic token overlap (handles cross-language: EN rule vs ZH hand-written)
    // Extract "concept tokens" — domain terms that appear in both regardless of language
    const semSim = semanticSimilarity(newContent, chunk);

    const combinedSim = Math.max(kwSim, semSim);

    if (combinedSim > maxSim) {
      maxSim = combinedSim;
      conflictChunk = chunk;
    }
    if (semSim > maxSemanticSim) maxSemanticSim = semSim;
  }

  return {
    hasConflict: maxSim > 0.3,
    similarity: parseFloat(maxSim.toFixed(2)),
    conflictsWith: conflictChunk.slice(0, 500),
  };
}

/**
 * Semantic similarity: extract domain-specific concept tokens and compare.
 * Handles cross-language overlap (e.g., "date filter" ≈ "date filter" in mixed content).
 */
function semanticSimilarity(textA, textB) {
  const conceptsA = extractConcepts(textA);
  const conceptsB = extractConcepts(textB);
  if (conceptsA.size === 0 || conceptsB.size === 0) return 0;

  let overlap = 0;
  for (const c of conceptsA) {
    if (conceptsB.has(c)) overlap++;
  }

  // Require at least 2 overlapping concepts to avoid false positives from single generic terms
  if (overlap < 2) return 0;

  const smaller = Math.min(conceptsA.size, conceptsB.size);
  return smaller === 0 ? 0 : overlap / smaller;
}

function extractConcepts(text) {
  const lower = text.toLowerCase();
  const concepts = new Set();

  // Extract English technical terms (2+ chars)
  const enTerms = lower.match(/[a-z][a-z0-9_-]{1,30}/g) || [];
  for (const t of enTerms) {
    if (!STOP_WORDS.has(t) && t.length > 2) concepts.add(t);
  }

  // Extract domain-specific technical terms (high signal, not generic words like "analysis")
  const domainTerms = lower.match(/\b(sql|api|dag|etl|cte|dry.?run|select|filter|query|table|date|event|metric|claude\.md|skill\.md)\b/g) || [];
  for (const t of domainTerms) concepts.add(t.replace(/[^a-z_.]/g, ''));

  return concepts;
}

function addConflict(project, newContent, conflictsWith, similarity) {
  const data = loadConflicts();
  const id = 'c_' + Date.now().toString(36);
  data.pending.push({
    id,
    project,
    new_content: newContent,
    conflicts_with: conflictsWith,
    similarity: parseFloat(similarity.toFixed(2)),
    created: new Date().toISOString(),
    status: 'pending',
  });
  saveConflicts(data);
  logChange({ action: 'conflict_detected', conflict_id: id, project, new_content: newContent.slice(0, 200) });
  return id;
}

function getPendingConflicts(project) {
  const data = loadConflicts();
  return data.pending.filter(c => c.project === project && c.status === 'pending');
}

function resolveConflict(conflictId, resolution) {
  const data = loadConflicts();
  const conflict = data.pending.find(c => c.id === conflictId);
  if (!conflict) return null;
  conflict.status = resolution; // 'accept_new' | 'keep_existing' | 'dismiss'
  conflict.resolved_at = new Date().toISOString();
  saveConflicts(data);
  logChange({ action: 'conflict_resolved', conflict_id: conflictId, resolution });
  return conflict;
}

// --- Distillation: merge 3+ similar active rules into one ---

function distillRules(project) {
  const data = loadRules();
  const activeRules = data.rules.filter(r => r.project === project && r.status === 'active');

  if (activeRules.length < 3) return [];

  // Group by keyword similarity
  const assigned = new Set();
  const groups = [];

  for (let i = 0; i < activeRules.length; i++) {
    if (assigned.has(i)) continue;
    const group = [i];
    assigned.add(i);

    for (let j = i + 1; j < activeRules.length; j++) {
      if (assigned.has(j)) continue;
      const sim = jaccardSimilarity(activeRules[i].keywords, activeRules[j].keywords);
      if (sim > 0.35) {
        group.push(j);
        assigned.add(j);
      }
    }

    if (group.length >= 3) {
      groups.push(group.map(idx => activeRules[idx]));
    }
  }

  const distilled = [];
  for (const group of groups) {
    // Merge contents
    const mergedContent = group.map(r => r.content).join('\n- ');
    const mergedKeywords = [...new Set(group.flatMap(r => r.keywords))];
    const maxFitness = Math.max(...group.map(r => r.fitness));

    // Mark old rules as distilled
    for (const rule of group) {
      const orig = data.rules.find(r => r.id === rule.id);
      if (orig) orig.status = 'distilled';
    }

    const newRule = {
      id: generateId(),
      project,
      type: 'rule',
      content: mergedContent,
      source: 'distillation',
      keywords: mergedKeywords,
      fitness: maxFitness,
      created: new Date().toISOString().slice(0, 10),
      last_evaluated: new Date().toISOString().slice(0, 10),
      sessions_evaluated: 0,
      status: 'active',
      distilled_from: group.map(r => r.id),
    };

    data.rules.push(newRule);
    distilled.push(newRule);

    logChange({
      action: 'distill_rules', rule_id: newRule.id, project,
      distilled_from: group.map(r => r.id),
      content: mergedContent.slice(0, 300),
    });
  }

  if (distilled.length > 0) saveRules(data);
  return distilled;
}

// --- Duplicate check ---

function isDuplicate(project, keywords) {
  const existing = getActiveRules(project);
  return existing.some(r => jaccardSimilarity(r.keywords, keywords) > 0.5);
}

module.exports = {
  extractKeywords, jaccardSimilarity,
  loadRules, saveRules, loadConflicts, saveConflicts,
  generateId, logChange,
  addRule, getActiveRules,
  evaluateFitness, pruneRules,
  detectConflict, addConflict, getPendingConflicts, resolveConflict,
  distillRules, isDuplicate,
};
