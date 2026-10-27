#!/usr/bin/env node
// setup.test.js — setup.js against a scratch HOME. Never touches the real ~/.claude.
// A stub `claude` is first on PATH, so no real CLI and no LLM calls are involved.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SETUP = path.join(REPO, 'setup.js');
const HOOKS = path.join(REPO, 'learning', 'hooks');
const WIN = process.platform === 'win32';

let root;      // scratch dir for this run
let binDir;    // holds the stub claude
let homeSeq = 0;

before(() => {
  // Real path: on macOS os.tmpdir() sits under the /var -> /private/var symlink, and setup.js
  // writes hook paths with symlinks resolved.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-setup-')));
  binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// --- Helpers ---

const asJson = obj => JSON.stringify(obj, null, 2) + '\n';

/** Fresh HOME. `settings` is the exact text to put in ~/.claude/settings.json (omit for none). */
function newHome(settings) {
  const home = path.join(root, `home-${++homeSeq}`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings);
  return home;
}

const settingsPath = home => path.join(home, '.claude', 'settings.json');
const readText = home => fs.readFileSync(settingsPath(home), 'utf8');
const readJson = home => JSON.parse(readText(home));
const backups = home => fs.readdirSync(path.join(home, '.claude')).filter(f => f.startsWith('settings.json.bak-'));

function childEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    CLAUDE_EVOLVE_DATA_DIR: path.join(root, 'data'),
    PATH: binDir + path.delimiter + process.env.PATH,
  };
}

function run(home, args, setup = SETUP) {
  return spawnSync(process.execPath, [setup, ...args], {
    encoding: 'utf8', cwd: root, env: childEnv(home), timeout: 30000,
  });
}

function copyDir(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(path.join(src, name))) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

const cmd = file => `node "${path.join(HOOKS, file)}"`;

const OTHER = {
  permissions: { allow: ['Bash(ls:*)'] },
  env: { FOO: 'bar' },
  hooks: {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other-stop' }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/other/audit.js' }] }],
  },
};

// An install from an older version: checkout in a folder named "evolver", session-end on Stop,
// unquoted commands, and a user hook of their own in the same Stop entry.
const OLD_DIR = '/somewhere/evolver/learning/hooks';
const OLD_INSTALL = {
  model: 'opus',
  hooks: {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `node ${OLD_DIR}/session-start.js`, timeout: 3 }] }],
    PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `node ${OLD_DIR}/post-tool.js`, timeout: 2 }] }],
    Stop: [
      { matcher: '', hooks: [
        { type: 'command', command: 'echo mine' },
        { type: 'command', command: `node ${OLD_DIR}/session-end.js`, timeout: 8 },
      ] },
      { matcher: '', hooks: [{ type: 'command', command: 'bash ~/bin/notify.sh # claude-evolve finished' }] },
    ],
  },
};

// =====================================================================

describe('setup.js install', () => {
  it('merges into a settings.json that has other hooks and settings', () => {
    const original = asJson(OTHER);
    const home = newHome(original);
    const r = run(home, []);
    assert.equal(r.status, 0, r.stderr);

    const s = readJson(home);
    assert.deepEqual(s.permissions, OTHER.permissions);
    assert.deepEqual(s.env, OTHER.env);
    assert.deepEqual(s.hooks.Stop, OTHER.hooks.Stop, 'user Stop hook untouched, ours not added to Stop');
    assert.equal(s.hooks.PostToolUse.length, 2);
    assert.deepEqual(s.hooks.PostToolUse[0], OTHER.hooks.PostToolUse[0]);
    assert.deepEqual(s.hooks.PostToolUse[1].hooks, [{ type: 'command', command: cmd('post-tool.js'), timeout: 2 }]);
    assert.deepEqual(s.hooks.SessionStart[0].hooks, [{ type: 'command', command: cmd('session-start.js'), timeout: 3 }]);
    assert.deepEqual(s.hooks.SessionEnd[0].hooks, [{ type: 'command', command: cmd('session-end.js'), timeout: 8 }]);

    const bak = backups(home);
    assert.equal(bak.length, 1, 'one backup');
    assert.equal(fs.readFileSync(path.join(home, '.claude', bak[0]), 'utf8'), original, 'backup is byte-identical');
  });

  it('creates settings.json when none exists, without a backup', () => {
    const home = newHome();
    const r = run(home, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(readJson(home).hooks).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart']);
    assert.equal(backups(home).length, 0);
  });

  it('is idempotent: a second run changes nothing and makes no backup', () => {
    const home = newHome(asJson(OTHER));
    assert.equal(run(home, []).status, 0);
    const after1 = readText(home);
    const r = run(home, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No changes made/);
    assert.equal(readText(home), after1);
    assert.equal(backups(home).length, 1);
  });

  it('moves session-end from Stop to SessionEnd and finds a copy in a folder with any name', () => {
    const home = newHome(asJson(OLD_INSTALL));

    const before = run(home, ['--check']);
    assert.equal(before.status, 1);
    assert.match(before.stdout, /session-end\.js is still registered on Stop/);

    const r = run(home, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Moved session-end\.js from Stop to SessionEnd/);

    const s = readJson(home);
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.hooks.Stop, [
      { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] },
      OLD_INSTALL.hooks.Stop[1],
    ], 'user hooks stay on Stop, including the one that only mentions claude-evolve');
    assert.equal(s.hooks.SessionStart.length, 1, 'no duplicate SessionStart');
    assert.equal(s.hooks.PostToolUse.length, 1, 'no duplicate PostToolUse');
    assert.equal(s.hooks.SessionStart[0].hooks[0].command, cmd('session-start.js'));
    assert.deepEqual(s.hooks.SessionEnd[0].hooks, [{ type: 'command', command: cmd('session-end.js'), timeout: 8 }]);

    const after = run(home, ['--check']);
    assert.equal(after.status, 0, after.stdout);
    assert.match(after.stdout, /✓ SessionEnd →/);
    assert.doesNotMatch(after.stdout, /still registered/);
  });

  it('aborts on a settings.json with a comment or trailing comma and leaves it byte-identical', () => {
    const broken = '{\n  // my notes\n  "permissions": {"allow": ["Bash(ls:*)"]},\n  "model": "opus",\n}\n';
    for (const args of [[], ['--remove'], ['--check']]) {
      const home = newHome(broken);
      const r = run(home, args);
      assert.equal(r.status, 1, `args=${args}`);
      assert.match(r.stderr, /not valid JSON/);
      assert.equal(readText(home), broken);
      assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['settings.json'], 'no backup or temp file');
    }
  });

  it('writes through a symlinked settings.json instead of replacing it', { skip: WIN }, () => {
    const home = newHome();
    const real = path.join(root, `dotfiles-settings-${homeSeq}.json`);
    fs.writeFileSync(real, asJson(OTHER));
    fs.symlinkSync(real, settingsPath(home));
    assert.equal(run(home, []).status, 0);
    assert.ok(fs.lstatSync(settingsPath(home)).isSymbolicLink());
    assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.SessionEnd);
  });
});

describe('setup.js CLI', () => {
  it('rejects unknown flags with usage and writes nothing', () => {
    for (const args of [['--hlep'], ['--check', '--bogus'], ['constructor']]) {
      const home = newHome();
      const r = run(home, args);
      assert.equal(r.status, 1, `args=${args}`);
      assert.match(r.stderr, /Unknown option/);
      assert.match(r.stderr, /Usage:/);
      assert.equal(fs.existsSync(settingsPath(home)), false);
    }
  });

  it('--help prints usage and exits 0', () => {
    const r = run(newHome(), ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /--remove/);
  });

  it('--check reports every hook with its event, and fails when nothing is installed', () => {
    const home = newHome();
    const empty = run(home, ['--check']);
    assert.equal(empty.status, 1);
    assert.match(empty.stdout, /✗ SessionStart — not installed/);
    assert.match(empty.stdout, /✗ SessionEnd — not installed/);

    assert.equal(run(home, []).status, 0);
    const ok = run(home, ['--check']);
    assert.equal(ok.status, 0, ok.stdout);
    for (const event of ['SessionStart', 'PostToolUse', 'SessionEnd']) assert.match(ok.stdout, new RegExp(`✓ ${event} →`));
  });
});

describe('setup.js hook commands at runtime', () => {
  it('works when the checkout path contains a space', { skip: WIN }, () => {
    const copy = path.join(root, 'my evolve');
    copyDir(REPO, copy, p => ['.git', '.claude', '.github', 'node_modules', 'demo-output', 'test'].includes(path.basename(p))
      || p === path.join(REPO, 'learning', 'data'));

    const home = newHome();
    const r = run(home, [], path.join(copy, 'setup.js'));
    assert.equal(r.status, 0, r.stderr);

    const hooks = readJson(home).hooks;
    const startCmd = hooks.SessionStart[0].hooks[0].command;
    const toolCmd = hooks.PostToolUse[0].hooks[0].command;
    const endCmd = hooks.SessionEnd[0].hooks[0].command;
    assert.ok(startCmd.includes(`"${path.join(copy, 'learning', 'hooks', 'session-start.js')}"`), startCmd);

    const sh = (command, input) => spawnSync('sh', ['-c', command], { encoding: 'utf8', input, env: childEnv(home), timeout: 30000 });
    for (const command of [startCmd, toolCmd]) {
      const out = sh(command, '{"session_id":"s1","tool_name":"Read","tool_input":{"file_path":"/x"},"tool_response":"y"}');
      assert.equal(out.status, 0, out.stderr);
      // A hook with nothing to say prints nothing; when it does print, it must be JSON.
      if (out.stdout.trim()) JSON.parse(out.stdout);
    }
    // session-end would start the learning processor, so only check that the quoted path resolves.
    const syntax = sh(endCmd.replace(/^node /, 'node --check '), '');
    assert.equal(syntax.status, 0, syntax.stderr);
  });
});

describe('setup.js --remove', () => {
  it('restores the original settings byte for byte', () => {
    for (const original of [asJson(OTHER), asJson({ model: 'opus' })]) {
      const home = newHome(original);
      assert.equal(run(home, []).status, 0);
      assert.notEqual(readText(home), original);
      const r = run(home, ['--remove']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readText(home), original);
    }
  });

  it('removes from Stop and SessionEnd but keeps the user\'s own hooks', () => {
    const home = newHome(asJson(OLD_INSTALL));
    const r = run(home, ['--remove']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(home), {
      model: 'opus',
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] },
          OLD_INSTALL.hooks.Stop[1],
        ],
      },
    });
    assert.equal(backups(home).length, 1);
  });

  it('does nothing and creates no file when there is no settings.json', () => {
    const home = newHome();
    const r = run(home, ['--remove']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Nothing to remove/);
    assert.equal(fs.existsSync(settingsPath(home)), false);
  });
});
