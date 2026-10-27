#!/usr/bin/env node
// clean-stale.test.js — `setup.js --clean-stale`: plan (dry run) and apply
// Covers the root policy (paths.resolveProjectRoot): git roots and plain folders outside git
// migrate in place; git subfolders, home and ignored folders get their block removed. Also:
// tracked file keeps its hand-written text, untracked scaffold deleted, auto skills moved
// (only out of non-roots), dry run writes nothing, backup mirrors the originals.
// Offline: HOME and DATA_DIR live in a temp sandbox.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-clean-')));
const HOME = path.join(SANDBOX, 'home');
const DATA = path.join(SANDBOX, 'data');
process.env.HOME = HOME;
process.env.CLAUDE_EVOLVE_DATA_DIR = DATA;

const REPO = path.join(__dirname, '..');
const cleaner = require('../learning/cleanStale');
const writer = require('../learning/claudeMdWriter');
const ruleEngine = require('../learning/ruleEngine');

const WS = path.join(SANDBOX, 'ws');
const SCAFFOLD = path.join(WS, 'scaffold');
const ROOT = path.join(WS, 'repo');
const SUB = path.join(ROOT, 'sub');
const ROOT2 = path.join(WS, 'repo2');
const IGN = path.join(WS, 'ignored');
const CHILD = path.join(IGN, 'child');

const block = ids => [
  '<!-- claude-evolve:managed-start -->', '',
  ...ids.flatMap(id => [`<!-- claude-evolve:rule id=${id} score=5.1 created=2026-05-01 source=observation complexity=simple -->`, `- stale rule ${id}`, '<!-- /claude-evolve:rule -->', '']),
  '<!-- claude-evolve:managed-end -->',
].join('\n');
const scaffold = ids => `# CLAUDE.md\n\n## Auto-learned Rules\n\n${block(ids)}\n`;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
const rule = (project, id, extra) => ({
  id, project, content: `live rule ${id}`, source: 'observation', keywords: [id], score: 6, relevance_count: 1,
  sessions_evaluated: 1, created: '2026-10-01', status: 'active', complexity: 'simple', ...extra,
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Hash of every file under a directory (path → sha256), to prove a run wrote nothing
function treeHash(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

before(() => {
  fs.mkdirSync(HOME, { recursive: true });
  // Plain folder outside git (its own root): hand-written text plus a block
  write(path.join(WS, 'CLAUDE.md'), `# Workspace notes\n- keep this hand-written line\n\n## Auto-learned Rules\n\n${block(['r_ws1', 'r_ws2'])}\n`);
  // Plain folder that only holds our scaffold; its skill stays (it is a root)
  write(path.join(SCAFFOLD, 'CLAUDE.md'), scaffold(['r_sc1']));
  write(path.join(SCAFFOLD, '.claude', 'skills', 'auto-keep', 'SKILL.md'), '---\nname: auto-keep\n---\n');
  // Ignored container: block removed, old auto skills moved out
  write(path.join(IGN, '.claude-evolve-ignore'), '');
  write(path.join(IGN, 'CLAUDE.md'), scaffold(['r_ign']));
  write(path.join(IGN, '.claude', 'skills', 'auto-old.md'), '<!-- claude-evolve:auto-skill hash=abc -->\n---\nname: auto-old\n---\n');
  write(path.join(IGN, '.claude', 'skills', 'auto-dir', 'SKILL.md'), '---\nname: auto-dir\n---\n');
  // A folder inside the ignored one is its own root (the opt-out is not inherited)
  write(path.join(CHILD, 'CLAUDE.md'), scaffold(['r_child']));
  // Git root with a tracked CLAUDE.md: hand-written text, a legacy block and a current block
  fs.mkdirSync(ROOT, { recursive: true });
  execFileSync('git', ['init', '-q', ROOT]);
  write(path.join(ROOT, 'CLAUDE.md'), `# Repo\n- hand rule stays\n\n## Auto-learned Rules\n\n<!-- evolver:managed-start -->\n<!-- evolver:rule id=r_old score=1 -->\n- legacy rule\n<!-- /evolver:rule -->\n<!-- evolver:managed-end -->\n\n## Auto-learned Rules\n\n${block(['r_sub1'])}\n`);
  git(ROOT, 'add', 'CLAUDE.md');
  git(ROOT, 'commit', '-q', '-m', 'init');
  // Subdirectory of the repo (not a root) with an untracked scaffold
  write(path.join(SUB, 'CLAUDE.md'), scaffold(['r_sub1', 'r_sub2']));
  // Second git root with an untracked file that only holds the block
  fs.mkdirSync(ROOT2, { recursive: true });
  execFileSync('git', ['init', '-q', ROOT2]);
  write(path.join(ROOT2, 'CLAUDE.md'), scaffold(['r_r2']));
  // HOME itself had rules written into it
  write(path.join(HOME, 'CLAUDE.md'), `# Me\n- personal note\n\n${block(['r_home'])}\n`);

  // v2 store: subdirectory keys, rootless keys
  write(path.join(DATA, 'rules.json'), JSON.stringify({ version: 2, session_count: 3, population: [
    rule(SUB, 'r_sub1'), rule(SUB, 'r_sub2'), rule(ROOT2, 'r_r2'),
    rule(WS, 'r_ws1'), rule(SCAFFOLD, 'r_sc1'), rule(HOME, 'r_home'), rule(IGN, 'r_ign'), rule(CHILD, 'r_child'),
    rule(ROOT, 'r_old', { status: 'dormant' }),
  ] }));
});

describe('clean-stale', () => {
  let planResult;

  it('dry run (CLI) writes nothing at all and prints one line per file', () => {
    const before = treeHash(SANDBOX);
    const out = spawnSync(process.execPath, [path.join(REPO, 'setup.js'), '--clean-stale'], {
      encoding: 'utf8', env: { ...process.env, HOME, CLAUDE_EVOLVE_DATA_DIR: DATA },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(treeHash(SANDBOX), before, 'no file created, changed or removed');
    assert.ok(!fs.existsSync(path.join(DATA, 'backups')));
    assert.match(out.stdout, /dry run/);
    assert.match(out.stdout, /Totals: /);
    assert.ok(out.stdout.includes(path.join(ROOT, 'CLAUDE.md')));
  });

  it('plans each file by what resolveProjectRoot says about its directory', () => {
    planResult = cleaner.plan();
    const kinds = Object.fromEntries(planResult.items.map(i => [path.relative(SANDBOX, i.path), [i.kind, i.reason, i.tracked, i.rules]]));
    assert.ok(planResult.items.every(i => i.path.startsWith(SANDBOX + path.sep)), 'nothing outside the sandbox');
    const L = writer.RULES_FILENAME;
    assert.deepEqual(kinds, {
      'home/CLAUDE.md': ['remove', 'home', false, 1],
      'ws/CLAUDE.md': ['migrate', 'folder-root', false, 2],
      [`ws/${L}`]: ['create', 'folder-root', false, 0],
      'ws/scaffold/CLAUDE.md': ['delete', 'folder-root', false, 1],
      [`ws/scaffold/${L}`]: ['create', 'folder-root', false, 0],
      'ws/ignored/CLAUDE.md': ['delete', 'ignored', false, 1],
      'ws/ignored/.claude/skills/auto-dir': ['skill', 'ignored', null, null],
      'ws/ignored/.claude/skills/auto-old.md': ['skill', 'ignored', null, null],
      'ws/ignored/child/CLAUDE.md': ['delete', 'folder-root', false, 1],
      [`ws/ignored/child/${L}`]: ['create', 'folder-root', false, 0],
      'ws/repo/CLAUDE.md': ['migrate', 'git-root', true, 2],
      [`ws/repo/${L}`]: ['create', 'git-root', false, 0],
      'ws/repo/sub/CLAUDE.md': ['delete', 'git-subdir', false, 2],
      'ws/repo2/CLAUDE.md': ['delete', 'git-root', false, 1],
      [`ws/repo2/${L}`]: ['create', 'git-root', false, 0],
    });
  });

  it('apply migrates the store, removes and migrates blocks, and backs up every original', () => {
    const originals = {};
    for (const it of planResult.items) {
      if (it.kind !== 'skill' && fs.existsSync(it.path)) originals[it.path] = fs.readFileSync(it.path, 'utf8');
    }
    const { backupDir, skipped } = cleaner.apply();
    assert.deepEqual(skipped, []);
    assert.equal(ruleEngine.loadPopulation().version, ruleEngine.SCHEMA_VERSION, 'store migrated first');

    // Plain folders outside git are roots: rules move to the rules file in place, skills stay
    const ws = fs.readFileSync(path.join(WS, 'CLAUDE.md'), 'utf8');
    assert.ok(ws.includes('- keep this hand-written line') && !ws.includes('managed-start') && !ws.includes('Auto-learned'));
    assert.ok(fs.readFileSync(path.join(WS, writer.RULES_FILENAME), 'utf8').includes('live rule r_ws1'));
    assert.ok(!fs.existsSync(path.join(SCAFFOLD, 'CLAUDE.md')));
    assert.ok(fs.readFileSync(path.join(SCAFFOLD, writer.RULES_FILENAME), 'utf8').includes('live rule r_sc1'));
    assert.ok(fs.existsSync(path.join(SCAFFOLD, '.claude', 'skills', 'auto-keep', 'SKILL.md')), 'a root keeps its skills');
    assert.ok(!fs.existsSync(path.join(CHILD, 'CLAUDE.md')));
    assert.ok(fs.readFileSync(path.join(CHILD, writer.RULES_FILENAME), 'utf8').includes('live rule r_child'));

    // Not roots: git subfolder, ignored folder, home → block removed, skills moved, nothing written
    assert.ok(!fs.existsSync(path.join(SUB, 'CLAUDE.md')));
    assert.ok(!fs.existsSync(path.join(SUB, writer.RULES_FILENAME)));
    assert.ok(!fs.existsSync(path.join(IGN, 'CLAUDE.md')));
    assert.ok(!fs.existsSync(path.join(IGN, writer.RULES_FILENAME)));
    assert.ok(!fs.existsSync(path.join(IGN, '.claude', 'skills', 'auto-old.md')));
    assert.ok(!fs.existsSync(path.join(IGN, '.claude', 'skills', 'auto-dir')));
    assert.ok(!fs.readFileSync(path.join(HOME, 'CLAUDE.md'), 'utf8').includes('managed-start'));
    assert.ok(!fs.existsSync(path.join(HOME, writer.RULES_FILENAME)));
    const keys = Object.fromEntries(ruleEngine.loadPopulation().population.map(r => [r.id, r.project]));
    assert.equal(keys.r_sub1, ROOT, 'git subfolder keys re-keyed to the top level');
    assert.equal(keys.r_ws1, WS, 'plain folder keys stay as they are');
    assert.equal(keys.r_ign, IGN, 'ignored keys stay (never written)');

    // Root with a tracked file: hand-written text stays, rules (re-keyed from sub/) move to the rules file
    const rootMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    assert.ok(rootMd.includes('- hand rule stays') && !rootMd.includes('managed') && !rootMd.includes('legacy rule'));
    const local = fs.readFileSync(path.join(ROOT, writer.RULES_FILENAME), 'utf8');
    assert.ok(local.includes('live rule r_sub1') && local.includes('live rule r_sub2') && !local.includes('legacy rule'));
    // Root with an untracked scaffold: file deleted, rules moved
    assert.ok(!fs.existsSync(path.join(ROOT2, 'CLAUDE.md')));
    assert.ok(fs.readFileSync(path.join(ROOT2, writer.RULES_FILENAME), 'utf8').includes('live rule r_r2'));

    // Backup mirrors every original byte for byte, at its absolute path
    for (const [file, text] of Object.entries(originals)) {
      assert.equal(fs.readFileSync(path.join(backupDir, file), 'utf8'), text, `backup of ${file}`);
    }
    assert.ok(fs.existsSync(path.join(backupDir, IGN, '.claude', 'skills', 'auto-dir', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(backupDir, IGN, '.claude', 'skills', 'auto-old.md')));
    assert.ok(fs.existsSync(path.join(backupDir, 'manifest.json')));

    // A second plan finds nothing left to do
    assert.deepEqual(cleaner.plan().items, []);
  });
});
