#!/usr/bin/env node
// memoryReader.js — Read Claude Code project feedback memories
// Detects new feedback memories created during the current session,
// which represent user corrections and confirmations.

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Encode a project path to the Claude Code memory directory path.
 * /Users/alice/projects/myapp → -Users-alice-projects-myapp
 * Resolves symlinks (e.g., /tmp → /private/tmp on macOS) for consistent matching.
 */
function encodeProjectPath(projectPath) {
  let resolved = projectPath;
  try { resolved = require('fs').realpathSync(projectPath); } catch {}
  return resolved.replace(/\//g, '-');
}

/**
 * Find the Claude Code project memory directory for a given project path.
 * Tries both raw and symlink-resolved paths (e.g., /tmp vs /private/tmp on macOS).
 */
function getProjectMemoryDir(projectPath) {
  const baseDir = path.join(os.homedir(), '.claude', 'projects');

  // Try resolved path first (what process.cwd() returns)
  const resolvedEncoded = encodeProjectPath(projectPath);
  const resolvedDir = path.join(baseDir, resolvedEncoded, 'memory');
  if (fs.existsSync(resolvedDir)) return resolvedDir;

  // Try raw path (what the user might have used)
  const rawEncoded = projectPath.replace(/\//g, '-');
  const rawDir = path.join(baseDir, rawEncoded, 'memory');
  if (fs.existsSync(rawDir)) return rawDir;

  // Fallback to resolved
  return resolvedDir;
}

/**
 * Parse YAML-ish frontmatter from a memory .md file.
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: text };

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = { body };

  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      let value = kv[2].trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[kv[1]] = value;
    }
  }

  return result;
}

/**
 * Get session start time by checking the temp file created by post-tool.js.
 */
function getSessionStartTime() {
  const tmpDir = os.tmpdir();
  try {
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('claude-learning-') && f.endsWith('.jsonl'))
      .map(f => {
        const fp = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fp);
          return { path: fp, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (files.length > 0) {
      // Use creation time of most recent temp file as session start
      return files[0].ctimeMs;
    }
  } catch {}

  // Fallback: 3 hours ago (generous window)
  return Date.now() - 3 * 60 * 60 * 1000;
}

/**
 * Read new feedback memories created during this session.
 * Returns array of { file, name, description, content, source, mtime }
 */
function getNewFeedbackMemories(projectPath, sessionStartTime) {
  const memDir = getProjectMemoryDir(projectPath);

  if (!fs.existsSync(memDir)) return [];

  let files;
  try {
    files = fs.readdirSync(memDir);
  } catch { return []; }

  const memories = [];

  for (const f of files) {
    // Only look at feedback memories
    if (!f.startsWith('feedback_') || !f.endsWith('.md')) continue;

    const fp = path.join(memDir, f);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }

    // Only pick up files modified during this session
    if (stat.mtimeMs < sessionStartTime) continue;

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
  const memDir = getProjectMemoryDir(projectPath);
  if (!fs.existsSync(memDir)) return [];

  let files;
  try { files = fs.readdirSync(memDir); } catch { return []; }

  const memories = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(memDir, f);
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
  encodeProjectPath, getProjectMemoryDir, parseFrontmatter,
  getSessionStartTime, getNewFeedbackMemories, getAllMemories,
  isWorkflowPattern, extractRuleContent,
};
