#!/usr/bin/env node
// cleanStale.js — Clean up managed rule blocks that earlier versions left in the wrong place.
//
// Earlier versions wrote rules into the CLAUDE.md of whatever directory a session started in.
// Each such directory is classified with paths.resolveProjectRoot, the same function that
// decides where sessions write today:
//   - it resolves to itself (a git top level, or a plain folder outside git) → rewrite through
//     claudeMdWriter.writeRules with its active rules, so the block moves to CLAUDE.local.md
//   - it does not (a subfolder of a git repo, home or an ancestor of home, or a folder with
//     .claude-evolve-ignore) → remove the block (a file left with only our scaffold is deleted
//     when untracked) and move any .claude/skills/auto-* out to the backup
//
// plan() writes nothing (the store migration is previewed in memory).
// apply() migrates the store first, then copies every file it touches to
// DATA_DIR/backups/clean-stale-<timestamp>/<absolute path> before changing it.
// CLI: node setup.js --clean-stale [--yes]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR, resolveProjectRoot, realpathOr } = require('./paths');
const { readJson, writeJsonAtomic, writeFileAtomic } = require('./fsutil');
const ruleEngine = require('./ruleEngine');
const writer = require('./claudeMdWriter');
const skillWriter = require('./skillWriter');

const MARKER_RE = /^[ \t]*<!-- (claude-evolve|evolver):managed-start -->[ \t]*\r?$/m;
const RULE_TAG_RE = /<!-- (?:claude-evolve|evolver):rule id=/g;

// ===================== Candidates =====================

/**
 * Every directory that may hold a block: store keys (and keys from before the v3 re-key),
 * archived rules, session log paths, HOME, and all their ancestors.
 */
function candidateDirs() {
  const seeds = new Set([os.homedir()]);
  const store = readJson(ruleEngine.RULES_PATH, () => ({}));
  for (const r of [...(store.population || []), ...(store.rules || [])]) {
    if (r && r.project) seeds.add(r.project);
    if (r && r.migrated_from) seeds.add(r.migrated_from);
  }
  try {
    for (const line of fs.readFileSync(ruleEngine.ARCHIVE_PATH, 'utf8').split('\n')) {
      try { const r = JSON.parse(line); if (r.project) seeds.add(r.project); } catch {}
    }
  } catch {}

  try {
    for (const line of fs.readFileSync(path.join(DATA_DIR, 'session_log.jsonl'), 'utf8').split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      for (const k of ['cwd', 'project', 'root']) if (typeof e[k] === 'string') seeds.add(e[k]);
    }
  } catch {}

  const dirs = new Set();
  for (const seed of seeds) {
    if (!seed || !path.isAbsolute(seed)) continue;
    for (let d = realpathOr(seed); ; d = path.dirname(d)) {
      dirs.add(d);
      if (path.dirname(d) === d) break;
    }
  }
  return [...dirs].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }).sort();
}

function autoSkills(dir) {
  const root = path.join(dir, '.claude', 'skills');
  try {
    return fs.readdirSync(root).filter(n => n.startsWith('auto-')).map(n => path.join(root, n));
  } catch { return []; }
}

/** Active rules of a root as the rules file shows them, plus skill routes. */
function rootRules(population, root) {
  const active = population.filter(r => r.project === root && r.status === 'active');
  const rules = active.filter(r => r.complexity !== 'methodology' || !(r.skill_path && fs.existsSync(r.skill_path)));
  return { rules, routes: skillWriter.listSkillRoutes(root), active: active.length };
}

// ===================== Plan =====================

/**
 * Build the plan. Writes nothing.
 * @returns {{ items: Array, dirs: number, storeVersion: number }}
 *   item: { kind: 'remove'|'delete'|'migrate'|'create'|'skill', path, rules, tracked, dir, root }
 */
function plan(dirs) {
  const raw = readJson(ruleEngine.RULES_PATH, () => ({ version: ruleEngine.SCHEMA_VERSION, population: [] }));
  const preview = ruleEngine.previewMigration(raw);
  const population = preview.population || [];
  const items = [];

  for (const dir of dirs || candidateDirs()) {
    const marked = writer.INSTRUCTION_FILES.filter(name => {
      try { return MARKER_RE.test(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return false; }
    });
    if (marked.length === 0) continue;

    const real = realpathOr(dir);
    const resolved = resolveProjectRoot(real);

    if (resolved.root !== real) {
      const reason = resolved.root ? 'git-subdir' : resolved.reason === 'home-or-ancestor' ? 'home' : resolved.reason;
      for (const name of marked) {
        const p = writer.planRewrite(path.join(dir, name), '');
        items.push({ ...fileItem(p, p.remove ? 'delete' : 'remove', dir), reason });
      }
      for (const s of autoSkills(dir)) items.push({ kind: 'skill', path: s, dir, rules: null, tracked: null, reason });
      continue;
    }
    const reason = fs.existsSync(path.join(real, '.git')) ? 'git-root' : 'folder-root';

    const { rules, routes, active } = rootRules(population, real);
    const section = writer.buildManagedSection(rules, routes);
    for (const name of writer.INSTRUCTION_FILES) {
      const p = writer.planRewrite(path.join(dir, name), name === writer.RULES_FILENAME ? section : '');
      if (!p.changed && !p.error) continue;
      let kind;
      if (p.remove) kind = 'delete';
      else if (!section) kind = 'remove';  // the root has no active rules: nothing to migrate
      else if (name === writer.RULES_FILENAME) kind = p.exists ? 'migrate' : 'create';
      else kind = 'migrate';
      items.push({ ...fileItem(p, kind, dir), root: real, activeRules: active, reason });
    }
  }
  return { items, storeVersion: raw.version || 0, previewVersion: preview.version };
}

function fileItem(p, kind, dir) {
  const text = p.content || '';
  return {
    kind,
    path: p.path,
    dir,
    rules: (text.match(RULE_TAG_RE) || []).length,
    tracked: p.exists ? (p.tracked !== undefined ? p.tracked : writer.isTracked(p.path)) : false,
    error: p.error,
  };
}

const LABELS = {
  remove: 'remove block',
  delete: 'delete empty untracked file',
  migrate: `migrate to ${writer.RULES_FILENAME}`,
  create: `create ${writer.RULES_FILENAME}`,
  skill: 'move skill',
};

function formatPlan(result) {
  const lines = [];
  for (const it of result.items) {
    const count = it.kind === 'skill' ? '-' : it.kind === 'create' ? `${it.activeRules} active` : `${it.rules} rules`;
    const tracked = it.tracked === null ? '-' : it.tracked ? 'tracked' : 'untracked';
    const note = it.kind === 'migrate' && it.root ? ` (root has ${it.activeRules} active rules)` : '';
    lines.push(`${LABELS[it.kind].padEnd(36)} ${String(it.reason || '').padEnd(11)} ${count.padEnd(10)} ${tracked.padEnd(9)} ${it.path}${note}${it.error ? `  [SKIPPED: ${it.error}]` : ''}`);
  }
  const by = k => result.items.filter(i => i.kind === k).length;
  const reasons = {};
  for (const i of result.items) reasons[i.reason] = (reasons[i.reason] || 0) + 1;
  lines.push('');
  lines.push(`Totals: ${result.items.filter(i => i.kind !== 'skill').length} files ` +
    `(${by('remove')} remove block, ${by('delete')} delete, ${by('migrate')} migrate, ${by('create')} create), ` +
    `${by('skill')} skills to move, ${result.items.reduce((n, i) => n + (i.rules || 0), 0)} rule tags in touched files`);
  lines.push(`By reason: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (result.storeVersion < ruleEngine.SCHEMA_VERSION) {
    lines.push(`Store: v${result.storeVersion} → v${ruleEngine.SCHEMA_VERSION} migration runs first (previewed in memory here).`);
  }
  return lines.join('\n');
}

// ===================== Apply =====================

function backupPath(backupDir, abs) {
  return path.join(backupDir, realpathOr(abs));
}

function backupFile(backupDir, file) {
  const dest = backupPath(backupDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(file, dest, { recursive: true, dereference: true });
  return dest;
}

/**
 * Migrate the store, re-plan against it, back up, then apply. Returns { backupDir, done, skipped }.
 */
function apply() {
  const dirs = candidateDirs();  // before the migration re-keys anything
  const migrated = ruleEngine.migrateStore();
  const result = plan(dirs);
  const backupDir = path.join(DATA_DIR, 'backups', `clean-stale-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const population = ruleEngine.loadPopulation().population;
  const done = [];
  const skipped = [];

  // Back up everything first, so a failure halfway still leaves every original saved
  const roots = new Set();
  for (const it of result.items) {
    if (it.error) { skipped.push(it); continue; }
    if (fs.existsSync(it.path)) backupFile(backupDir, it.path);
    if (it.root) {
      roots.add(it.root);
      const exclude = path.join(it.root, '.git', 'info', 'exclude');
      if (it.kind === 'create' && fs.existsSync(exclude)) backupFile(backupDir, exclude);
    }
  }

  for (const it of result.items) {
    if (it.error || it.root) continue;
    if (it.kind === 'skill') {
      fs.rmSync(it.path, { recursive: true, force: true });
    } else {
      const p = writer.planRewrite(it.path, '');
      if (p.remove) fs.unlinkSync(it.path);
      else if (p.changed) writeFileAtomic(it.path, p.next);
    }
    done.push(it);
  }
  for (const root of roots) {
    const { rules, routes } = rootRules(population, root);
    const res = writer.writeRules(root, rules, routes);
    if (res.error) skipped.push({ kind: 'migrate', path: root, error: res.error });
    else done.push(...result.items.filter(i => i.root === root && !i.error));
  }

  writeJsonAtomic(path.join(backupDir, 'manifest.json'), {
    created: new Date().toISOString(), store_migration: migrated,
    items: result.items.map(i => ({ ...i, backup: fs.existsSync(backupPath(backupDir, i.path)) ? backupPath(backupDir, i.path) : null })),
  });
  return { backupDir, done, skipped, result };
}

module.exports = { candidateDirs, plan, formatPlan, apply };
