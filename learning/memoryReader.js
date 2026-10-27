#!/usr/bin/env node
// memoryReader.js — Read Claude Code project feedback memories
// Detects new feedback memories created during the current session,
// which represent user corrections and confirmations.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveProjectRoot, realpathOr } = require('./paths');

/**
 * Encode a project path to the Claude Code memory directory path.
 * /Users/alice/projects/myapp → -Users-alice-projects-myapp
 * Resolves symlinks (e.g., /tmp → /private/tmp on macOS) for consistent matching.
 */
function encodeProjectPath(projectPath) {
  let resolved = projectPath;
  try { resolved = fs.realpathSync(projectPath); } catch {}
  return resolved.replace(/\//g, '-');
}

/**
 * Find the Claude Code project memory directory for a given project path.
 * Tries the symlink-resolved and raw paths (e.g., /tmp vs /private/tmp on macOS), each
 * encoded both ways: "/" → "-", and every non-alphanumeric → "-" (Claude Code's slug).
 */
function getProjectMemoryDir(projectPath) {
  const baseDir = path.join(os.homedir(), '.claude', 'projects');
  let resolved = projectPath;
  try { resolved = fs.realpathSync(projectPath); } catch {}

  const candidates = [];
  for (const p of [resolved, projectPath]) {
    for (const slug of [p.replace(/\//g, '-'), p.replace(/[^A-Za-z0-9]/g, '-')]) {
      const dir = path.join(baseDir, slug, 'memory');
      if (!candidates.includes(dir)) candidates.push(dir);
    }
  }
  return candidates.find(d => fs.existsSync(d)) || candidates[0];
}

/**
 * Memory files for a launch directory. Claude Code may key auto-memory by the launch folder
 * or by its git root, so both memory dirs are read (when they differ) and the union is
 * returned, deduped by file path. Returns [{ f, fp }].
 */
function listMemoryFiles(projectPath) {
  const dirs = [getProjectMemoryDir(projectPath)];
  try {
    const { root } = resolveProjectRoot(projectPath);
    if (root) dirs.push(getProjectMemoryDir(root));
  } catch {}

  const seen = new Set();
  const files = [];
  for (const dir of new Set(dirs.map(d => realpathOr(d)))) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      const fp = path.join(dir, f);
      if (!f.endsWith('.md') || seen.has(fp)) continue;
      seen.add(fp);
      files.push({ f, fp });
    }
  }
  return files;
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse YAML-ish frontmatter from a memory .md file.
 * Reads top-level `key: value` and one level of nesting:
 *   metadata:
 *     type: feedback
 * becomes result.metadata = { type: 'feedback' }. A nested `type` also fills a missing
 * top-level `type`, so old flat files and new nested files read the same way.
 */
function parseFrontmatter(text) {
  const match = String(text).replace(/\r\n/g, '\n').match(/^\uFEFF?---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!match) return { body: text };

  const result = { body: match[2].trim() };
  let block = null;

  for (const line of match[1].split('\n')) {
    const nested = line.match(/^[ \t]+([\w-]+):[ \t]*(.*)$/);
    if (nested && block) {
      result[block][nested[1]] = unquote(nested[2]);
      continue;
    }
    const kv = line.match(/^([\w-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    if (kv[2].trim() === '') {
      block = kv[1];
      result[block] = {};
    } else {
      block = null;
      result[kv[1]] = unquote(kv[2]);
    }
  }

  for (const [k, v] of Object.entries(result)) {
    if (v && typeof v === 'object' && typeof v.type === 'string' && !result.type) result.type = v.type;
    if (v && typeof v === 'object' && Object.keys(v).length === 0) delete result[k];
  }
  return result;
}

/**
 * Session start time from the session record in an observation temp file.
 * Falls back to 3 hours ago (generous window) when the file or record is missing.
 */
function getSessionStartTime(observationFile) {
  try {
    for (const line of fs.readFileSync(observationFile, 'utf8').split('\n')) {
      if (!line.includes('"session"')) continue;
      const rec = JSON.parse(line);
      if (rec.type === 'session' && Number.isFinite(rec.startMs)) return rec.startMs;
    }
  } catch {}
  return Date.now() - 3 * 60 * 60 * 1000;
}

/**
 * Read new feedback memories created during this session (memory type `feedback`,
 * flat or nested frontmatter, modified at or after sessionStartTime).
 * Returns array of { file, name, description, content, source, mtime }
 */
function getNewFeedbackMemories(projectPath, sessionStartTime) {
  const since = Number.isFinite(sessionStartTime) ? sessionStartTime : getSessionStartTime(null);
  const memories = [];

  for (const { f, fp } of listMemoryFiles(projectPath)) {
    if (f === 'MEMORY.md') continue;

    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }

    // Only pick up files modified during this session
    if (stat.mtimeMs < since) continue;

    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const parsed = parseFrontmatter(raw);

      if (parsed.type !== 'feedback') continue;

      memories.push({
        file: f,
        name: parsed.name || '',
        description: parsed.description || '',
        content: parsed.body || '',
        source: 'correction',
        mtime: stat.mtimeMs,
      });
    } catch {}
  }

  return memories;
}

/**
 * Read ALL memories for a project (user, feedback, project, reference).
 * Used by skill generation to understand the user's thinking patterns.
 * Returns array of { file, type, name, description, content }
 */
function getAllMemories(projectPath) {
  const memories = [];
  for (const { f, fp } of listMemoryFiles(projectPath)) {
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const parsed = parseFrontmatter(raw);
      memories.push({
        file: f,
        type: parsed.type || 'unknown',
        name: parsed.name || '',
        description: parsed.description || '',
        content: parsed.body || '',
      });
    } catch {}
  }
  return memories;
}

/**
 * Determine if a memory describes a multi-step workflow (→ skill)
 * vs a single rule (→ CLAUDE.md rule).
 */
function isWorkflowPattern(content) {
  // Numbered steps
  if (/(?:^|\n)\s*\d+\.\s/m.test(content)) {
    const steps = content.match(/(?:^|\n)\s*\d+\.\s/gm);
    if (steps && steps.length >= 3) return true;
  }
  // "first... then..." patterns
  if (/first.*then.*(?:finally|lastly|after that)/i.test(content)) return true;
  if (/\u5148.*\u518D.*(?:\u6700\u5F8C|\u7136\u5F8C|\u63A5\u8457)/i.test(content)) return true;

  return false;
}

/**
 * Extract the core rule text from a memory.
 * Prefers description (concise), falls back to first meaningful line of body.
 */
function extractRuleContent(memory) {
  // Use description if it's a good one-liner
  if (memory.description && memory.description.length > 10 && memory.description.length < 300) {
    return memory.description;
  }

  // Otherwise use first meaningful line of body
  if (memory.content) {
    const lines = memory.content.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 10 && !l.startsWith('**Why') && !l.startsWith('**How'));
    if (lines.length > 0) return lines[0];
  }

  return memory.name || '';
}

module.exports = {
  encodeProjectPath, getProjectMemoryDir, listMemoryFiles, parseFrontmatter,
  getSessionStartTime, getNewFeedbackMemories, getAllMemories,
  isWorkflowPattern, extractRuleContent,
};
