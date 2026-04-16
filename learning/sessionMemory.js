#!/usr/bin/env node
// sessionMemory.js — Persistent session memory using .md files
//
// Three-tier storage:
//   Tier 1: index.md — one line per session (injected at session-start)
//   Tier 2: session .md top — summary + key decisions (on-demand)
//   Tier 3: session .md full — complete observations (on-demand, rarely needed)
//
// Raw observations (temp .jsonl) are deleted after compression.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const INDEX_PATH = path.join(MEMORY_DIR, 'index.md');

const MAX_INDEX_LINES = 50; // Keep last 50 sessions in index

// --- Directory setup ---

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// --- Session ID ---

function generateSessionId() {
  const date = new Date().toISOString().slice(0, 10);
  const hash = Math.random().toString(36).slice(2, 5);
  return `${date}_${hash}`;
}

// --- Read observations from temp file ---

function readObservations(tempFile) {
  if (!tempFile) return [];
  try {
    const lines = fs.readFileSync(tempFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// --- Write session .md ---

/**
 * Write a session memory file with three-tier structure.
 *
 * @param {string} sessionId - e.g., "2026-04-17_a3f"
 * @param {object} compressed - Output from llmBrain.compressSession()
 * @param {Array} observations - Full observations (for Tier 3)
 * @param {object} meta - { project, toolCalls, strategy, rulesAdded, rulesPruned }
 */
function writeSession(sessionId, compressed, observations, meta) {
  ensureDirs();

  const lines = [];

  // Frontmatter
  lines.push('---');
  lines.push(`session: ${sessionId}`);
  lines.push(`date: ${new Date().toISOString()}`);
  lines.push(`project: ${meta.project || 'unknown'}`);
  lines.push(`tool_calls: ${meta.toolCalls || 0}`);
  lines.push(`strategy: ${meta.strategy || 'unknown'}`);
  lines.push(`rules_added: ${meta.rulesAdded || 0}`);
  lines.push(`rules_pruned: ${meta.rulesPruned || 0}`);
  lines.push('---');
  lines.push('');

  // Tier 2: Summary
  lines.push('## Summary');
  lines.push(compressed.summary || '(no summary)');
  lines.push('');

  if (compressed.key_decisions) {
    lines.push('## Key Decisions');
    lines.push(compressed.key_decisions);
    lines.push('');
  }

  // Tier 3: Full observation timeline
  lines.push('## Observations');
  lines.push('');
  for (const obs of (observations || [])) {
    const time = new Date(obs.ts).toTimeString().slice(0, 5);
    const tag = obs.type ? ` [${obs.type}]` : '';
    const input = (obs.input || '').slice(0, 500);
    const output = (obs.output || '').slice(0, 300);
    lines.push(`- [${time}] **${obs.tool}**${tag}: ${input}`);
    if (output) {
      lines.push(`  → ${output}`);
    }
  }

  const content = lines.join('\n') + '\n';
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.md`);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);

  return filePath;
}

// --- Update index.md (Tier 1) ---

/**
 * Append a one-line entry to index.md and trim to MAX_INDEX_LINES.
 *
 * @param {string} sessionId
 * @param {string} indexLine - One-line summary from LLM
 * @param {number} obsCount - Number of observations
 * @param {string} project - Project name
 */
function appendIndex(sessionId, indexLine, obsCount, project) {
  ensureDirs();

  const date = sessionId.split('_')[0];
  const line = `- [${date}] (${sessionId}) ${project}: ${indexLine} | ${obsCount} obs`;

  let existing = [];
  try {
    existing = fs.readFileSync(INDEX_PATH, 'utf8').trim().split('\n').filter(Boolean);
  } catch {}

  existing.push(line);

  // Keep only last N lines
  if (existing.length > MAX_INDEX_LINES) {
    existing = existing.slice(-MAX_INDEX_LINES);
  }

  const tmp = INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, existing.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, INDEX_PATH);

  return line;
}

// --- Read index for session-start injection (Tier 1) ---

/**
 * Read the last N lines of index.md for session-start context.
 * @param {number} maxLines - Max lines to return (default 15)
 */
function readIndex(maxLines) {
  const n = maxLines || 15;
  try {
    const lines = fs.readFileSync(INDEX_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

// --- Read session summary (Tier 2) ---

/**
 * Read the summary section of a session .md file.
 * @param {string} sessionId
 */
function readSessionSummary(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.md`);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Extract Summary + Key Decisions sections (before ## Observations)
    const obsIdx = content.indexOf('## Observations');
    if (obsIdx === -1) return content;
    return content.slice(0, obsIdx).trim();
  } catch { return null; }
}

// --- Read full session (Tier 3) ---

/**
 * Read the complete session .md file.
 * @param {string} sessionId
 */
function readSessionFull(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.md`);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

// --- Search sessions by keyword ---

/**
 * Search index.md for sessions matching a query.
 * Returns matching index lines + session IDs.
 * @param {string} query - Search terms
 * @param {number} maxResults - Max results (default 5)
 */
function searchSessions(query, maxResults) {
  const max = maxResults || 5;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  try {
    const lines = fs.readFileSync(INDEX_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const results = [];

    for (const line of lines.reverse()) { // newest first
      const lower = line.toLowerCase();
      const matches = terms.filter(t => lower.includes(t)).length;
      if (matches > 0) {
        // Extract session ID from the line: "- [2026-04-17] (2026-04-17_a3f)"
        const idMatch = line.match(/\((\d{4}-\d{2}-\d{2}_\w+)\)/);
        const dateMatch = line.match(/\[(\d{4}-\d{2}-\d{2})\]/);
        results.push({
          line,
          score: matches / terms.length,
          date: dateMatch ? dateMatch[1] : '',
          sessionId: idMatch ? idMatch[1] : '',
        });
      }
      if (results.length >= max) break;
    }

    return results.sort((a, b) => b.score - a.score);
  } catch { return []; }
}

// --- List recent sessions ---

function listSessions(maxCount) {
  const n = maxCount || 10;
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, n);
    return files.map(f => f.replace('.md', ''));
  } catch { return []; }
}

module.exports = {
  generateSessionId,
  readObservations,
  writeSession,
  appendIndex,
  readIndex,
  readSessionSummary,
  readSessionFull,
  searchSessions,
  listSessions,
  MEMORY_DIR,
  SESSIONS_DIR,
  INDEX_PATH,
};
