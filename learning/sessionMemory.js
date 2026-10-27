#!/usr/bin/env node
// sessionMemory.js — Persistent session memory using .md files
//
// Three-tier storage:
//   Tier 1: index.md — one line per session (injected at session-start)
//   Tier 2: session .md top — summary + key decisions (on-demand)
//   Tier 3: session .md full — complete observations (on-demand, rarely needed)
//
// Raw observations (temp .jsonl) are deleted after compression.
//
// Each project root has its own index file, so session-start only shows the current
// project's history. Session files older than 90 days, or beyond the newest 500, are pruned.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');
const { writeFileAtomic, withLock } = require('./fsutil');

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const INDEX_DIR = path.join(MEMORY_DIR, 'index');
const INDEX_PATH = path.join(MEMORY_DIR, 'index.md'); // legacy global index (no project root known)
const PRUNE_MARKER = path.join(MEMORY_DIR, '.last_prune');

const MAX_INDEX_LINES = 50; // Keep last 50 sessions per project index
const KEEP_SESSIONS = 500;
const KEEP_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Observation temp files: one per Claude Code session, keyed by the hook payload's session_id.
const OBS_PREFIX = 'claude-evolve-';

// --- Directory setup ---

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// --- Session ID ---

/**
 * Session-memory id: "<YYYY-MM-DD>_<suffix>". The date prefix is parsed elsewhere.
 * With a Claude session_id, the suffix is its first 8 alphanumerics (traceable to the
 * transcript) plus 24 random bits, so a resumed session never overwrites its earlier
 * summary. Without one, the suffix is 48 random bits.
 */
function generateSessionId(claudeSessionId) {
  const date = new Date().toISOString().slice(0, 10);
  const sid = String(claudeSessionId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
  return `${date}_${sid}${crypto.randomBytes(sid ? 3 : 6).toString('hex')}`;
}

// --- Observation temp file (written by post-tool, read by session-end) ---

function sessionKey(payload) {
  const id = (payload && payload.session_id) || `ppid-${process.ppid}`;
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function observationFile(key) {
  return path.join(os.tmpdir(), `${OBS_PREFIX}${key}.jsonl`);
}

/**
 * Create the observation file with its session record, unless it already exists.
 * pid is the Claude process (the hook's parent), used by the session-start sweep.
 */
function startObservationFile(file, sessionId, cwd) {
  const header = { type: 'session', sessionId, startMs: Date.now(), pid: process.ppid, cwd };
  try {
    fs.writeFileSync(file, JSON.stringify(header) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

/** Split raw records into the session record and the tool observations. */
function splitObservations(records) {
  const header = records.find(r => r.type === 'session') || null;
  return { header, observations: records.filter(r => r.type !== 'session') };
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
  writeFileAtomic(filePath, content);
  try { pruneSessions(); } catch {}

  return filePath;
}

// --- Retention ---

/**
 * Delete session files older than KEEP_DAYS or beyond the newest KEEP_SESSIONS
 * (whichever keeps fewer). Runs at most once a day, tracked by a marker file.
 */
function pruneSessions(now = Date.now()) {
  try {
    if (now - fs.statSync(PRUNE_MARKER).mtimeMs < DAY_MS) return 0;
  } catch {}
  ensureDirs();
  fs.writeFileSync(PRUNE_MARKER, new Date(now).toISOString() + '\n');

  const files = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(SESSIONS_DIR, f);
    try { files.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  files.forEach((f, i) => {
    if (i < KEEP_SESSIONS && now - f.mtime <= KEEP_DAYS * DAY_MS) return;
    try { fs.unlinkSync(f.fp); removed++; } catch {}
  });
  return removed;
}

// --- Update the project index (Tier 1) ---

/** Index file for a project root: <basename>-<hash>.md under memory/index/. */
function indexPathFor(projectRoot) {
  const hash = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 10);
  return path.join(INDEX_DIR, `${path.basename(projectRoot) || 'root'}-${hash}.md`);
}

/**
 * Append a one-line entry to the project's index and trim to MAX_INDEX_LINES.
 *
 * @param {string} sessionId
 * @param {string} indexLine - One-line summary from LLM
 * @param {number} obsCount - Number of observations
 * @param {string} project - Project root (absolute path). A bare name falls back to the
 *   legacy global index, which session-start never reads.
 */
function appendIndex(sessionId, indexLine, obsCount, project) {
  const file = path.isAbsolute(project || '') ? indexPathFor(project) : INDEX_PATH;
  const date = String(sessionId).split('_')[0];
  const line = `- [${date}] (${sessionId}) ${path.basename(project || 'unknown')}: ${indexLine} | ${obsCount} obs`;

  withLock(file, () => {
    let existing = [];
    try {
      existing = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } catch {}
    existing.push(line);
    writeFileAtomic(file, existing.slice(-MAX_INDEX_LINES).join('\n') + '\n');
  });

  return line;
}

// --- Read index for session-start injection (Tier 1) ---

/**
 * Read the last N lines of a project's index for session-start context.
 * @param {number} maxLines - Max lines to return (default 15)
 * @param {string|null} projectRoot - Project root; null returns nothing
 */
function readIndex(maxLines, projectRoot) {
  if (!projectRoot) return [];
  const n = maxLines || 15;
  try {
    const lines = fs.readFileSync(indexPathFor(projectRoot), 'utf8').trim().split('\n').filter(Boolean);
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
 * Search a project's index for sessions matching a query.
 * Returns matching index lines + session IDs.
 * @param {string} query - Search terms
 * @param {number} maxResults - Max results (default 5)
 * @param {string} [projectRoot] - Project root; omitted searches the legacy global index
 */
function searchSessions(query, maxResults, projectRoot) {
  const max = maxResults || 5;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  try {
    const file = projectRoot ? indexPathFor(projectRoot) : INDEX_PATH;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
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
  sessionKey,
  observationFile,
  startObservationFile,
  splitObservations,
  readObservations,
  writeSession,
  appendIndex,
  readIndex,
  readSessionSummary,
  readSessionFull,
  searchSessions,
  listSessions,
  pruneSessions,
  indexPathFor,
  OBS_PREFIX,
  MEMORY_DIR,
  SESSIONS_DIR,
  INDEX_PATH,
};
