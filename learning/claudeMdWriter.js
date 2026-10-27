#!/usr/bin/env node
// claudeMdWriter.js — Write auto-learned rules into the project's instruction file.
//
// One entry point, writeRules(root, rules, skillRoutes), for every write. The managed block
// (heading included) sits between whole-line markers; everything outside it is hand-written
// and never touched. Rule metadata stays in rules.json: the rule tag holds only the id, so a
// score change never rewrites the file. Unchanged bytes skip the write.
//
// Target file: RULES_FILENAME at the project root. The other instruction file at the root
// gets any managed block (or legacy `evolver:` block) removed, so rules live in one place.
//
// Safety: marker lines inside fenced code blocks are ignored, and a file with more than one
// start marker is refused rather than guessed at. Before the writer first changes or deletes
// a file that holds hand-written text, it copies the original to DATA_DIR/backups/writer/.
// CRLF files keep CRLF. Symlinked files are written through, never deleted.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeFileAtomic } = require('./fsutil');
const { DATA_DIR } = require('./paths');

// Where the managed block lives. CLAUDE.local.md is personal and git-excluded;
// set to 'CLAUDE.md' to share the rules with everyone who clones the repo.
const RULES_FILENAME = 'CLAUDE.local.md';
const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md'];

const PREFIX = 'claude-evolve';
const LEGACY_PREFIXES = ['evolver'];  // marker prefix before the rename (commit 04bcb20)
const MANAGED_START = `<!-- ${PREFIX}:managed-start -->`;
const MANAGED_END = `<!-- ${PREFIX}:managed-end -->`;
const RULE_END = `<!-- /${PREFIX}:rule -->`;
const HEADING = '## Auto-learned Rules';

function rulesFilePath(root) {
  return path.join(root, RULES_FILENAME);
}

function ruleTag(rule) {
  return `<!-- ${PREFIX}:rule id=${rule.id} -->`;
}

/** Make LLM-written text safe inside the block: no comment markers, no blank lines. */
function sanitizeText(text, singleLine) {
  let t = String(text || '').replace(/<!--|-->/g, '').replace(/\r\n?/g, '\n');
  t = singleLine ? t.replace(/\s*\n\s*/g, ' ') : t.replace(/\n[ \t]*(?=\n)/g, '').replace(/\n{2,}/g, '\n');
  return t.trim();
}

// --- Read ---

function readClaudeMd(projectPath) {
  const mdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(mdPath)) return { path: mdPath, content: '', exists: false };
  return { path: mdPath, content: fs.readFileSync(mdPath, 'utf8'), exists: true };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALL_PREFIXES = [PREFIX, ...LEGACY_PREFIXES];

function markerRe(prefix, kind) {
  return new RegExp(`^[ \\t]*${escapeRe(`<!-- ${prefix}:managed-${kind} -->`)}[ \\t]*$`);
}

/** CommonMark fence opener: up to 3 spaces, 3+ backticks or tildes; a backtick info string has no backtick. */
function fenceOpener(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { ch: m[1][0], len: m[1].length };
}

/** CommonMark fence closer: same char, at least the opener's length, nothing after it. */
function closesFence(line, fence) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

/**
 * One pass over the file: managed blocks of every prefix, outside code fences. Fences are
 * not tracked between a block's own start and end markers, so rule text can never hide our
 * end marker. Returns { [prefix]: { starts, blocks: [{ s, e }] }, unterminated, unclosedFence }.
 */
function scanBlocks(content) {
  const res = { unterminated: null, unclosedFence: false };
  for (const p of ALL_PREFIXES) res[p] = { starts: [], blocks: [] };
  let fence = null;
  let open = null;
  let pos = 0;
  for (const raw of content.split('\n')) {
    const L = { start: pos, end: pos + raw.length, text: raw.replace(/\r$/, '') };
    pos += raw.length + 1;
    if (open) {
      if (markerRe(open.prefix, 'end').test(L.text)) { res[open.prefix].blocks.push({ s: open.line, e: L }); open = null; }
      else for (const p of ALL_PREFIXES) if (markerRe(p, 'start').test(L.text)) res[p].starts.push(L);
      continue;
    }
    if (fence) { if (closesFence(L.text, fence)) fence = null; continue; }
    const startPrefix = ALL_PREFIXES.find(p => markerRe(p, 'start').test(L.text));
    if (startPrefix) { res[startPrefix].starts.push(L); open = { prefix: startPrefix, line: L }; continue; }
    fence = fenceOpener(L.text);
  }
  res.unterminated = open ? open.prefix : null;
  res.unclosedFence = !!fence;
  return res;
}

/**
 * Locate a managed block by whole-line markers outside code fences. A marker quoted inside a
 * line or shown in a fenced example never matches.
 * Returns { start, end } (end is the end of the end marker line), { unterminated, start },
 * { ambiguous, start } (more than one start marker: the caller must refuse), or null.
 * The old layout put "## Auto-learned Rules" right above the start marker; it is taken along.
 */
function findBlock(content, prefix) {
  const scan = scanBlocks(content);
  const { starts, blocks } = scan[prefix];
  if (starts.length === 0) return null;
  if (starts.length > 1) return { ambiguous: true, start: starts[0].start };
  if (blocks.length === 0) return { unterminated: true, start: starts[0].start };

  let start = blocks[0].s.start;
  const before = content.slice(0, start);
  const h = before.match(new RegExp(`(^|\\n)[ \\t]*${escapeRe(HEADING)}[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)*$`));
  if (h) start = before.length - h[0].length + h[1].length;
  return { start, end: blocks[0].e.end };
}

function joinParts(before, middle, after) {
  return [before.replace(/\s+$/, ''), middle, after.replace(/^\s+/, '')].filter(Boolean).join('\n\n');
}

/** Hand-written content = the file minus every managed block (current and legacy). */
function getHandWrittenContent(content) {
  let body = String(content || '').replace(/\r\n/g, '\n');
  for (const prefix of [PREFIX, ...LEGACY_PREFIXES]) {
    for (let b = findBlock(body, prefix); b && b.end !== undefined; b = findBlock(body, prefix)) {
      body = joinParts(body.slice(0, b.start), '', body.slice(b.end));
    }
  }
  return body.trim();
}

/** Hand-written text of every instruction file at the root, labeled by file name. */
function readInstructionFiles(root) {
  const out = [];
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(root, name);
    try {
      const text = getHandWrittenContent(fs.readFileSync(file, 'utf8'));
      if (text) out.push({ name, path: file, text });
    } catch {}
  }
  return out;
}

// --- Build managed section ---

/**
 * Build the managed block. Returns '' when there is nothing to write.
 * @param {Array} rules - Non-methodology rules to write
 * @param {Array} [skillRoutes] - [{ name, path, triggers, description }] for skills that exist
 */
function buildManagedSection(rules, skillRoutes) {
  const routes = skillRoutes || [];
  if ((!rules || rules.length === 0) && routes.length === 0) return '';

  const lines = [MANAGED_START, HEADING, ''];

  if (routes.length > 0) {
    lines.push(`<!-- ${PREFIX}:skill-routing -->`);
    lines.push('### Skill Routing');
    lines.push('');
    lines.push('The following skills were auto-generated from observed work patterns. Use them when the trigger matches:');
    lines.push('');
    for (const route of routes) {
      const rel = route.path || `.claude/skills/${route.name}/SKILL.md`;
      lines.push(`- **${sanitizeText(route.name, true)}** (${rel}): ${sanitizeText(route.description, true)}`);
      const triggers = (route.triggers || []).map(t => sanitizeText(t, true)).filter(Boolean);
      if (triggers.length > 0) lines.push(`  Triggers: ${triggers.join(', ')}`);
    }
    lines.push('');
    lines.push('When any of these triggers match, load and follow the corresponding skill before proceeding.');
    lines.push(`<!-- /${PREFIX}:skill-routing -->`);
    lines.push('');
  }

  for (const rule of rules || []) {
    const complexity = rule.complexity || 'simple';
    const text = sanitizeText(rule.content, complexity === 'simple');
    if (!text) continue;
    lines.push(ruleTag(rule));

    if (complexity === 'workflow') {
      // Workflow: headers, numbered steps and bullets kept as written
      for (const cl of text.split('\n')) lines.push(cl.trim());
    } else if (complexity === 'compound') {
      // Compound: bullet list, indented sub-bullets kept
      for (const cl of text.split('\n')) {
        if (/^\s+- /.test(cl)) { lines.push(cl); continue; }
        const trimmed = cl.trim();
        lines.push(trimmed.startsWith('- ') ? trimmed : '- ' + trimmed);
      }
    } else {
      // Simple: one bullet
      lines.push(text.startsWith('- ') ? text : '- ' + text);
    }

    lines.push(RULE_END);
    lines.push('');
  }

  lines.push(MANAGED_END);
  return lines.map(neutralizeFence).join('\n');
}

/** A rule line can never open a code fence: a leading ``` or ~~~ (after a list marker too) is escaped. */
function neutralizeFence(line) {
  return line.replace(/^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(`{3,}|~{3,})/, (m, lead, run) => `${lead}\\${run}`);
}

// --- Write ---

/**
 * Work out what putting `section` into one file ('' removes the block) would do, without
 * writing. Legacy blocks are always removed.
 * Returns { path, exists, content, next, changed, created?, remove?, tracked?, error? }.
 */
function planRewrite(file, section) {
  const exists = fs.existsSync(file);
  if (!exists && !section) return { path: file, exists, changed: false };
  const content = exists ? fs.readFileSync(file, 'utf8') : '';
  const base = { path: file, exists, content };
  // Work in LF; write back in the file's own line ending style
  const lf = content.replace(/\r\n/g, '\n');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  // A code fence left open at the end of the file hides everything below it: refuse
  if (scanBlocks(lf).unclosedFence && (section || /:managed-start -->/.test(lf))) {
    return { ...base, changed: false, error: 'a code fence is never closed; not guessing where the managed block is' };
  }

  const blockError = (b, prefix) => (b.ambiguous ? `more than one ${prefix} start marker outside code fences`
    : b.unterminated ? `unterminated ${prefix} block` : null);

  let body = lf;
  for (const prefix of LEGACY_PREFIXES) {
    for (let b = findBlock(body, prefix); b; b = findBlock(body, prefix)) {
      if (blockError(b, prefix)) return { ...base, changed: false, error: blockError(b, prefix) };
      body = joinParts(body.slice(0, b.start), '', body.slice(b.end));
    }
  }

  const ours = findBlock(body, PREFIX);
  if (ours && blockError(ours, PREFIX)) return { ...base, changed: false, error: blockError(ours, PREFIX) };

  let next = ours
    ? joinParts(body.slice(0, ours.start), section, body.slice(ours.end))
    : joinParts(body, section, '');
  next = next ? next + '\n' : '';

  if (exists && next === lf) return { ...base, next: content, changed: false };
  if (eol === '\r\n') next = next.replace(/\n/g, '\r\n');

  // Nothing but our old stub header left: the file existed only for the managed block.
  // Untracked → delete it; tracked → keep what is left so git shows an edit, not a deletion.
  // A symlink is never deleted: the write goes through it to the target.
  if (exists && /^(#\s*CLAUDE(\.local)?\.md\s*)?$/.test(next.trim())) {
    const tracked = isTracked(file);
    const link = fs.lstatSync(file).isSymbolicLink();
    return { ...base, next, changed: true, remove: !tracked && !link, tracked };
  }
  return { ...base, next, changed: true, created: !exists };
}

/** Apply a plan from planRewrite. Returns { path, changed, created?, removed?, error? }. */
function applyPlan(plan) {
  const file = plan.path;
  if (plan.error || !plan.changed) return { path: file, changed: false, error: plan.error };
  if (plan.remove) {
    fs.unlinkSync(file);
    return { path: file, changed: true, removed: true };
  }
  writeFileAtomic(file, plan.next);
  return { path: file, changed: true, created: plan.created };
}

/**
 * Copy a file's original content to DATA_DIR/backups/writer/<absolute path>.<timestamp>,
 * once per file: later changes to the same file add no new copy.
 */
function backupOnce(file) {
  const abs = path.resolve(file);
  const mirror = path.join(DATA_DIR, 'backups', 'writer', abs);
  const dir = path.dirname(mirror);
  const prefix = path.basename(abs) + '.';
  try {
    if (fs.readdirSync(dir).some(n => n.startsWith(prefix))) return null;
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const dest = `${mirror}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(abs, dest);
  return dest;
}

/**
 * The single write entry point. Writes the managed block into RULES_FILENAME at `root`
 * and removes managed/legacy blocks from the other instruction file there.
 * @returns {{ path: string, changed: boolean, error?: string }}
 */
function writeRules(root, rules, skillRoutes) {
  // Never create the project root (a deleted worktree must stay deleted)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { path: rulesFilePath(root), changed: false, error: 'project root does not exist' };
  }
  const section = buildManagedSection(rules, skillRoutes);
  // Plan both files first. If either cannot be parsed safely, write neither: a new block in
  // one file next to an old block left in the other would load the rules twice.
  const plans = INSTRUCTION_FILES.map(name => ({ name, isTarget: name === RULES_FILENAME,
    plan: planRewrite(path.join(root, name), name === RULES_FILENAME ? section : '') }));
  const errors = plans.filter(p => p.plan.error).map(p => `${p.name}: ${p.plan.error}`);
  if (errors.length) return { path: rulesFilePath(root), changed: false, error: errors.join('; ') };

  let target = null;
  let changed = false;
  for (const { name, isTarget, plan } of plans) {
    // Back up any existing file we are about to change that holds hand-written text,
    // and every non-target file (CLAUDE.md) whatever it holds
    if (plan.changed && plan.exists && (!isTarget || getHandWrittenContent(plan.content))) backupOnce(plan.path);
    const res = applyPlan(plan);
    if (res.changed) changed = true;
    if (isTarget) {
      target = res;
      if (res.created && name === 'CLAUDE.local.md') ensureGitExcluded(root, RULES_FILENAME, `/${RULES_FILENAME}`);
    }
  }
  return { path: target.path, changed };
}

function isTracked(file) {
  try {
    execFileSync('git', ['-C', path.dirname(file), 'ls-files', '--error-unmatch', path.basename(file)], {
      timeout: 2000, stdio: 'ignore',
    });
    return true;
  } catch { return false; }
}

/** Remove the managed block everywhere at the root. */
function removeManagedSection(root) {
  return writeRules(root, [], []);
}

/**
 * Add `pattern` to the repo's info/exclude unless `relPath` is already ignored.
 * No-op outside a git repo. Returns true when the exclude file was changed.
 */
function ensureGitExcluded(root, relPath, pattern) {
  const git = args => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    git(['check-ignore', '-q', relPath]);
    return false;  // exit 0: already ignored
  } catch (e) {
    if (e.status !== 1) return false;  // not a repo, or git failed
  }
  try {
    let excl = git(['rev-parse', '--git-path', 'info/exclude']).trim();
    if (!path.isAbsolute(excl)) excl = path.join(root, excl);
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (cur.split('\n').some(l => l.trim() === pattern)) return false;
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    fs.appendFileSync(excl, (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  RULES_FILENAME, INSTRUCTION_FILES, rulesFilePath,
  readClaudeMd, readInstructionFiles, getHandWrittenContent,
  buildManagedSection, writeRules, removeManagedSection, planRewrite, isTracked,
  sanitizeText, ensureGitExcluded, findBlock,
  MANAGED_START, MANAGED_END, HEADING,
};
