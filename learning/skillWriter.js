#!/usr/bin/env node
// skillWriter.js — Write/delete auto-generated skills in .claude/skills/
// Methodology-level rules graduate into one skill per project, in the format Claude Code
// discovers: .claude/skills/auto-<slug>/SKILL.md with name/description frontmatter.
//
// Ownership: a skill carries a hash marker line right after its frontmatter. A file whose
// content no longer matches the hash (the user edited it), or that has no marker, is never
// overwritten or deleted. New skill dirs in a git repo are added to .git/info/exclude.
// Zero npm dependencies — uses only Node.js built-ins.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fsutil');
const { ensureGitExcluded, sanitizeText } = require('./claudeMdWriter');

const SKILLS_DIR = path.join('.claude', 'skills');
const SKILL_PREFIX = 'auto-';
const SKILL_FILE = 'SKILL.md';
const HASH_MARKER = 'claude-evolve:auto-skill';
const EXCLUDE_PATTERN = '/.claude/skills/auto-*/';

// ===================== Slugs and paths =====================

function cleanSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 50).replace(/-$/, '');
}

/**
 * Generate a URL-safe slug from rule keywords or content.
 * @param {Object} rule - Rule object with keywords and/or content
 * @returns {string} Slug like "bq-analysis-workflow"
 */
function generateSlug(rule) {
  const words = (rule.keywords && rule.keywords.length > 0)
    ? rule.keywords.slice(0, 5)
    : (rule.content || '').toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 5);

  const slug = words
    .map(w => String(w).toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .join('-');

  return slug || ('skill-' + cleanSlug(rule.id || Date.now().toString(36)));
}

function skillsRoot(projectPath) {
  return path.join(projectPath, SKILLS_DIR);
}

function skillFilePath(projectPath, slug) {
  return path.join(skillsRoot(projectPath), SKILL_PREFIX + slug, SKILL_FILE);
}

/** Where a rule's skill would be by keyword slug (fallback when skill_path is unknown). */
function findSkillFile(projectPath, rule) {
  return skillFilePath(projectPath, generateSlug(rule));
}

function slugFromPath(skillPath) {
  return path.basename(path.dirname(skillPath)).slice(SKILL_PREFIX.length);
}

// ===================== Hash / ownership =====================

/** SHA-256 of the content without the hash marker line. */
function computeHash(content) {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.includes(HASH_MARKER));
  if (idx !== -1) lines.splice(idx, 1);
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function extractStoredHash(content) {
  const match = content.match(/claude-evolve:auto-skill\s+hash=([a-f0-9]+)/);
  return match ? match[1] : null;
}

/** 'ours' (unedited), 'edited' (marker present, content changed) or 'foreign' (no marker). */
function ownership(content) {
  const stored = extractStoredHash(content);
  if (!stored) return 'foreign';
  return computeHash(content) === stored ? 'ours' : 'edited';
}

function readOwnership(file) {
  try { return ownership(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ===================== Content =====================

function splitFrontmatter(content) {
  const text = content.replace(/\r\n?/g, '\n').trim();
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  return { fm: m[1].split('\n'), body: m[2] };
}

/**
 * Normalize a skill to the Claude Code format: frontmatter first with name = dir name and
 * a description, then the hash marker line, then the body.
 */
function finalizeSkill(content, slug, fallbackDescription, meta) {
  // Drop any old marker line (flat skills had it above the frontmatter)
  const cleaned = content.split('\n').filter(l => !l.includes(HASH_MARKER)).join('\n');
  const parts = splitFrontmatter(cleaned) || { fm: [], body: cleaned };
  const body = parts.body.replace(/^\n+/, '');
  const fm = parts.fm.filter(l => !/^name\s*:/.test(l));
  fm.unshift(`name: ${SKILL_PREFIX}${slug}`);
  if (!fm.some(l => /^description\s*:/.test(l))) {
    fm.splice(1, 0, `description: ${sanitizeText(fallbackDescription, true)}`);
  }

  const marker = (hash) => `<!-- ${HASH_MARKER} hash=${hash} project-type=${meta.projectType || 'unknown'} created=${meta.created} -->`;
  const assemble = (hash) => ['---', ...fm, '---', marker(hash), body.trimEnd(), ''].join('\n');
  return assemble(computeHash(assemble('')));
}

function describeRules(allRules) {
  const keywords = [...new Set(allRules.flatMap(r => r.keywords || []))];
  const domainTerms = keywords.filter(k => k.length > 2).slice(0, 4).join(', ');
  return { keywords, domainTerms };
}

/**
 * Template skill (used when the LLM fails). Returns full content with frontmatter.
 */
function buildSkillBody(primaryRule, relatedRules, slug, projectType) {
  const allRules = [primaryRule, ...(relatedRules || [])];
  const { domainTerms } = describeRules(allRules);
  const description = `${domainTerms} workflow, auto-learned from ${allRules.length} observed patterns. Use when working on ${projectType || 'this type of'} tasks.`;

  const lines = [
    '---',
    `name: ${SKILL_PREFIX}${slug}`,
    `description: ${sanitizeText(description, true)}`,
    '---',
    '',
    `# ${domainTerms} Methodology`,
    '',
    `Auto-learned from ${primaryRule.sessions_evaluated || '?'} sessions of ${projectType || 'project'} work.`,
    'This skill encodes patterns that were consistently followed and proved useful over time.',
    '',
    '## Steps',
    '',
  ];
  allRules.forEach((rule, i) => {
    lines.push(`${i + 1}. ${sanitizeText(rule.content, true).replace(/^[-*]\s*/, '')}`);
  });
  lines.push('');
  lines.push('## About this skill');
  lines.push('');
  lines.push('Generated by [claude-evolve](https://github.com/jack60810/claude-evolve). If you edit this file, claude-evolve detects the edit (content hash) and stops overwriting or deleting it.');
  return lines.join('\n') + '\n';
}

// ===================== Write skill =====================

function ensureExcluded(projectPath, file) {
  ensureGitExcluded(projectPath, path.relative(projectPath, file), EXCLUDE_PATTERN);
}

/**
 * Write the ONE skill for a project's methodology group.
 * Keeps the slug of an existing skill (no rename churn); a changed slug removes the old dir.
 * Sets skill_path on the passed rule objects; the caller persists it.
 *
 * @returns {{ written: boolean, path: string, reason?: string }}
 */
function writeSkill(projectPath, primaryRule, relatedRules, projectType, memories, sessionNarratives) {
  const allRules = [primaryRule, ...(relatedRules || [])];
  // Never create a project root that no longer exists (deleted worktree or workspace)
  if (!fs.existsSync(projectPath)) return { written: false, path: '', reason: 'project root does not exist' };
  migrateFlatSkills(projectPath);

  const existing = allRules.map(r => r.skill_path).find(p => p && fs.existsSync(p)) || null;
  if (existing && readOwnership(existing) !== 'ours') {
    return { written: false, path: existing, reason: 'user-edited' };
  }

  const { keywords } = describeRules(allRules);
  const fallbackSlug = generateSlug({ keywords, id: primaryRule.id });

  const llmBrain = require('./llmBrain');
  const result = llmBrain.generateSkillContent(allRules, projectType, fallbackSlug, memories, sessionNarratives);

  let slug = existing ? slugFromPath(existing) : fallbackSlug;
  if (!existing && result && result.content) {
    const nameMatch = result.content.match(/^name:\s*"?auto-([^"\n]+)"?\s*$/m);
    if (nameMatch && cleanSlug(nameMatch[1])) slug = cleanSlug(nameMatch[1]);
  }

  const file = skillFilePath(projectPath, slug);
  if (file !== existing && fs.existsSync(file) && readOwnership(file) !== 'ours') {
    return { written: false, path: file, reason: 'user-edited' };
  }

  const created = primaryRule.created || new Date().toISOString().slice(0, 10);
  const { domainTerms } = describeRules(allRules);
  const fallbackDescription = `${domainTerms} workflow auto-learned from ${allRules.length} observed patterns`;
  const source = (result && result.content) ? result.content : buildSkillBody(primaryRule, relatedRules, slug, projectType);
  const content = finalizeSkill(source, slug, fallbackDescription, { projectType, created });

  const isNew = !fs.existsSync(file);
  writeFileAtomic(file, content);
  if (isNew) ensureExcluded(projectPath, file);
  if (existing && existing !== file) removeSkillFile(existing);

  for (const r of allRules) r.skill_path = file;
  return { written: true, path: file, reason: (result && result.content) ? undefined : 'template-fallback' };
}

// ===================== Delete / reconcile =====================

function removeSkillFile(file) {
  try { fs.unlinkSync(file); } catch {}
  const dir = path.dirname(file);
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
}

/**
 * Delete a rule's skill. Files the user edited (or never ours) are kept.
 * @returns {{ deleted: boolean, path: string, reason?: string }}
 */
function deleteSkill(projectPath, rule) {
  const skillPath = rule.skill_path || findSkillFile(projectPath, rule);
  if (!fs.existsSync(skillPath)) return { deleted: false, path: skillPath };
  if (readOwnership(skillPath) !== 'ours') return { deleted: false, path: skillPath, reason: 'user-edited' };
  removeSkillFile(skillPath);
  return { deleted: true, path: skillPath };
}

function listAutoSkillFiles(projectPath) {
  const root = skillsRoot(projectPath);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith(SKILL_PREFIX))
    .map(e => path.join(root, e.name, SKILL_FILE))
    .filter(f => fs.existsSync(f));
}

/**
 * Delete every unedited auto skill not in keepPaths (renamed, demoted or orphaned).
 * @returns {string[]} deleted paths
 */
function reconcileSkills(projectPath, keepPaths) {
  const keep = new Set(keepPaths || []);
  const deleted = [];
  for (const file of listAutoSkillFiles(projectPath)) {
    if (keep.has(file) || readOwnership(file) !== 'ours') continue;
    removeSkillFile(file);
    deleted.push(file);
  }
  return deleted;
}

/**
 * Move old flat skills (.claude/skills/auto-*.md) into auto-<slug>/SKILL.md.
 * Unedited files are re-stamped (still ours); edited ones move as-is without a marker (user-owned).
 * @returns {string[]} new paths
 */
function migrateFlatSkills(projectPath) {
  const root = skillsRoot(projectPath);
  let names = [];
  try { names = fs.readdirSync(root).filter(f => f.startsWith(SKILL_PREFIX) && f.endsWith('.md')); } catch { return []; }
  const moved = [];
  for (const name of names) {
    const flat = path.join(root, name);
    try {
      if (!fs.statSync(flat).isFile()) continue;
      const content = fs.readFileSync(flat, 'utf8');
      const own = ownership(content);
      const slug = cleanSlug(name.slice(SKILL_PREFIX.length, -3)) || 'skill';
      const file = skillFilePath(projectPath, slug);
      let movedNow = false;
      if (!fs.existsSync(file)) {
        const created = (content.match(/created=(\S+)/) || [])[1] || new Date().toISOString().slice(0, 10);
        const projectType = (content.match(/project-type=(\S+)/) || [])[1];
        const next = own === 'ours'
          ? finalizeSkill(content, slug, `${slug.replace(/-/g, ' ')} workflow`, { projectType, created })
          : content.split('\n').filter(l => !l.includes(HASH_MARKER)).join('\n');
        writeFileAtomic(file, next);
        ensureExcluded(projectPath, file);
        moved.push(file);
        movedNow = true;
      }
      // Keep a flat file the user edited when its new location is already taken
      if (movedNow || own === 'ours') fs.unlinkSync(flat);
    } catch {}
  }
  return moved;
}

function parseFrontmatterFields(content) {
  const parts = splitFrontmatter(content);
  if (!parts) return {};
  const out = { triggers: [] };
  let key = null;
  for (const line of parts.fm) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'name') out.name = v;
      else if (key === 'description' && v && v !== '|' && v !== '>') out.description = v;
      continue;
    }
    const item = line.match(/^\s+-\s*"?([^"]+?)"?\s*$/);
    if (item && key === 'triggers') { out.triggers.push(item[1]); continue; }
    if (key === 'description' && !out.description && line.trim()) out.description = line.trim();
  }
  return out;
}

/** Routes for the rules file: only auto skills that exist on disk. */
function listSkillRoutes(projectPath) {
  return listAutoSkillFiles(projectPath).map(file => {
    const f = parseFrontmatterFields(fs.readFileSync(file, 'utf8'));
    const dirName = path.basename(path.dirname(file));
    return {
      name: dirName,
      path: path.relative(projectPath, file).split(path.sep).join('/'),
      description: f.description || 'Auto-generated skill',
      triggers: (f.triggers || []).slice(0, 5),
    };
  });
}

module.exports = {
  writeSkill,
  deleteSkill,
  reconcileSkills,
  migrateFlatSkills,
  listSkillRoutes,
  findSkillFile,
  skillFilePath,
  // Exported for testing
  generateSlug,
  computeHash,
  extractStoredHash,
  ownership,
  buildSkillBody,
  EXCLUDE_PATTERN,
};
