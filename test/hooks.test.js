// hooks.test.js — End-to-end tests for the three hooks (post-tool, session-start, session-end).
//
// Each hook runs as a real child process fed a crafted JSON payload on stdin, with
// CLAUDE_EVOLVE_DATA_DIR, TMPDIR and HOME pointed at scratch directories and a stub `claude`
// first on PATH. A NODE_OPTIONS preload intercepts the background processor: when a
// process starts processRules.js, the preload copies the pending file it was given into a
// capture directory and exits, so no rule processing (and no LLM call) ever runs.
//
// Run: node --test test/hooks.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'learning', 'hooks');
const LEARNING = path.join(__dirname, '..', 'learning');

let ROOT, HOME, BIN, PRELOAD, CLAUDE_CALLS;

const PRELOAD_SRC = `
const fs = require('fs');
const path = require('path');
if (path.basename(process.argv[1] || '') === 'processRules.js') {
  const pending = process.argv[2];
  const out = path.join(process.env.CE_TEST_CAPTURE, path.basename(pending));
  fs.writeFileSync(out + '.tmp', JSON.stringify({
    pending: JSON.parse(fs.readFileSync(pending, 'utf8')),
    cwd: process.cwd(),
    child: process.env.CLAUDE_EVOLVE_CHILD,
  }));
  fs.renameSync(out + '.tmp', out);
  process.exit(0);
}
`;

function gitRepo(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  return fs.realpathSync(dir);
}

/** Fresh data dir, temp dir and capture dir for one test. */
function sandbox(name) {
  const base = path.join(ROOT, 'sb', name);
  const sb = { data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), capture: path.join(base, 'capture') };
  for (const d of Object.values(sb)) fs.mkdirSync(d, { recursive: true });
  sb.env = {
    ...process.env,
    HOME,
    TMPDIR: sb.tmp,
    CLAUDE_EVOLVE_DATA_DIR: sb.data,
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    NODE_OPTIONS: `--require "${PRELOAD}"`,
    CE_TEST_CAPTURE: sb.capture,
    GIT_CEILING_DIRECTORIES: ROOT,
  };
  delete sb.env.CLAUDE_EVOLVE_CHILD;
  delete sb.env.EVOLVER_CHILD;
  sb.obsFile = sid => path.join(sb.tmp, `claude-evolve-${sid}.jsonl`);
  return sb;
}

function runHook(hook, payload, env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [path.join(HOOKS, hook)], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const start = (sb, sid, cwd) => runHook('session-start.js',
  { session_id: sid, cwd, hook_event_name: 'SessionStart', source: 'startup' }, sb.env, cwd);
const tool = (sb, sid, cwd, name, input, response) => runHook('post-tool.js',
  { session_id: sid, cwd, hook_event_name: 'PostToolUse', tool_name: name, tool_input: input, tool_response: response }, sb.env, cwd);
const bash = (sb, sid, cwd, command, stdout = 'ok') => tool(sb, sid, cwd, 'Bash', { command }, { stdout, stderr: '', interrupted: false });
const end = (sb, sid, cwd) => runHook('session-end.js',
  { session_id: sid, cwd, hook_event_name: 'SessionEnd', reason: 'other' }, sb.env, cwd);

function readRecords(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 50));
  }
}

const captured = (sb, sid) => {
  const f = path.join(sb.capture, `pending_${sid}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const sessionLog = sb => {
  try { return readRecords(path.join(sb.data, 'session_log.jsonl')); } catch { return []; }
};

before(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-hooks-')));
  HOME = path.join(ROOT, 'home');
  BIN = path.join(ROOT, 'bin');
  PRELOAD = path.join(ROOT, 'preload.js');
  CLAUDE_CALLS = path.join(ROOT, 'claude-calls.log');
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(PRELOAD, PRELOAD_SRC);
  fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\necho "$*" >> "${CLAUDE_CALLS}"\necho '{}'\n`, { mode: 0o755 });
});

after(() => {
  assert.equal(fs.existsSync(CLAUDE_CALLS), false, 'no hook may call claude');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('hooks', () => {
  it('each hook exits in under 1 s', async () => {
    const sb = sandbox('timing');
    const proj = gitRepo('p-timing');
    const s = await start(sb, 't1', proj);
    const toolRuns = [];
    for (let i = 0; i < 5; i++) toolRuns.push(await bash(sb, 't1', proj, `ls ${i}`));
    const e = await end(sb, 't1', proj);
    for (const r of [s, ...toolRuns, e]) {
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 1000, `hook took ${r.ms} ms`);
    }
    assert.ok(await waitFor(() => captured(sb, 't1')), 'processor spawned for a 5-call session');
  });

  it('captures tool_response (object and string) and legacy tool_output', async () => {
    const sb = sandbox('capture');
    const proj = gitRepo('p-capture');
    await tool(sb, 'cap', proj, 'Bash', { command: 'make' }, { stdout: 'hello-out', stderr: 'warn-err', interrupted: false });
    await tool(sb, 'cap', proj, 'mcp__srv__do', { q: 1 }, 'plain string result');
    await tool(sb, 'cap', proj, 'mcp__srv__list', { q: 2 }, { content: [{ type: 'text', text: 'mcp block text' }] });
    await runHook('post-tool.js', { session_id: 'cap', cwd: proj, tool_name: 'Bash', tool_input: { command: 'old' }, tool_output: 'legacy-out' }, sb.env, proj);

    const file = sb.obsFile('cap');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const [header, ...obs] = readRecords(file);
    assert.equal(header.type, 'session');
    assert.equal(header.sessionId, 'cap');
    assert.equal(header.cwd, proj);
    assert.equal(header.pid, process.pid);
    assert.ok(Number.isFinite(header.startMs));
    assert.equal(obs.length, 4);
    assert.match(obs[0].output, /hello-out/);
    assert.match(obs[0].output, /\[stderr\] warn-err/);
    assert.equal(obs[1].output, 'plain string result');
    assert.equal(obs[1].type, 'mcp_action');
    assert.equal(obs[2].output, 'mcp block text');
    assert.equal(obs[3].output, 'legacy-out');
  });

  it('logs malformed payloads to hook_errors.log instead of failing silently', async () => {
    const sb = sandbox('errors');
    const child = spawnSync(process.execPath, [path.join(HOOKS, 'post-tool.js')], { input: '{not json', env: sb.env });
    assert.equal(child.status, 0);
    assert.equal(child.stdout.toString(), '');
    assert.match(fs.readFileSync(path.join(sb.data, 'hook_errors.log'), 'utf8'), /\[post-tool\]/);
  });

  it('redacts secrets in inputs and outputs before they reach disk', async () => {
    const sb = sandbox('redact');
    const proj = gitRepo('p-redact');
    const secrets = [
      'ntn_abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijkl',
      'hunter2pass',
      'eyJhbGciOiJIUzI1NiJ9.payload123',
      'MIIEowIBAAKCAQEA1234',
    ];
    await bash(sb, 'red', proj,
      `NOTION_TOKEN=${secrets[0]} curl -H "Authorization: Bearer ${secrets[6]}" -H "x-api-key: ${secrets[1]}" https://x`,
      `token ${secrets[2]} key ${secrets[3]}\n{"password": "${secrets[5]}"}\n-----BEGIN RSA PRIVATE KEY-----\n${secrets[7]}\n-----END RSA PRIVATE KEY-----`);
    await tool(sb, 'red', proj, 'mcp__slack__post', { token: secrets[4], text: 'max_tokens=4000 and a task-runner' }, 'sent');
    await tool(sb, 'red', proj, 'Edit', { file_path: '/x/.env', old_string: 'API_KEY=old', new_string: `password = "${secrets[5]}"` }, { filePath: '/x/.env', originalFile: secrets[2] });

    const raw = fs.readFileSync(sb.obsFile('red'), 'utf8');
    for (const s of secrets) assert.ok(!raw.includes(s), `secret leaked: ${s}`);
    assert.match(raw, /\[REDACTED\]/);
    assert.match(raw, /max_tokens=4000 and a task-runner/, 'ordinary words survive');

    const { redact } = require(path.join(LEARNING, 'redact'));
    for (const plain of ['const token = getToken();', 'Bearer authentication', 'num_tokens=12', 'secret_sauce', 'sk-learn']) {
      assert.equal(redact(plain), plain);
    }
  });

  it('keeps two concurrent sessions apart', async () => {
    const sb = sandbox('concurrent');
    const proj = gitRepo('p-concurrent');
    await Promise.all([start(sb, 'sessA', proj), start(sb, 'sessB', proj)]);
    const runs = [];
    for (let i = 0; i < 8; i++) {
      runs.push(bash(sb, 'sessA', proj, `echo A-${i}`, `A-out-${i}`));
      runs.push(bash(sb, 'sessB', proj, `echo B-${i}`, `B-out-${i}`));
    }
    await Promise.all(runs);

    for (const [sid, tag] of [['sessA', 'A'], ['sessB', 'B']]) {
      const { header, observations } = splitRecords(readRecords(sb.obsFile(sid)));
      assert.equal(header.sessionId, sid);
      assert.equal(observations.length, 8);
      assert.ok(observations.every(o => o.input.startsWith(`echo ${tag}-`) && o.output.startsWith(`${tag}-out-`)));
    }

    await Promise.all([end(sb, 'sessA', proj), end(sb, 'sessB', proj)]);
    for (const [sid, tag] of [['sessA', 'A'], ['sessB', 'B']]) {
      const cap = await waitFor(() => captured(sb, sid));
      assert.ok(cap, `pending for ${sid}`);
      assert.equal(cap.pending.sessionId, sid);
      assert.equal(cap.pending.observations.length, 8);
      assert.ok(cap.pending.observations.every(o => o.input.startsWith(`echo ${tag}-`)));
      assert.equal(fs.existsSync(sb.obsFile(sid)), false, 'temp file deleted');
    }
  });

  it('SessionStart prints hookSpecificOutput for this project only, and nothing otherwise', async () => {
    const sb = sandbox('start-output');
    const proj = gitRepo('p-start');
    const other = gitRepo('p-start-other');
    const plain = path.join(ROOT, 'plain-start');
    fs.mkdirSync(plain, { recursive: true });

    // Nothing to say: no output at all
    const empty = await start(sb, 's0', proj);
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, '');

    const r = spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(LEARNING, 'sessionMemory'))}).appendIndex('2026-10-14_abc', 'fixed the widget', 7, ${JSON.stringify(proj)})`,
    ], { env: sb.env });
    assert.equal(r.status, 0, String(r.stderr));
    const hintsPath = path.join(sb.data, 'skill_hints.json');
    fs.writeFileSync(hintsPath, JSON.stringify({ hints: [{ pattern_id: 'r_1', message: 'Your deploy workflow is mature', shown: false }] }));

    const out = await start(sb, 's1', proj);
    assert.equal(out.code, 0);
    const json = JSON.parse(out.stdout);
    assert.deepEqual(Object.keys(json), ['hookSpecificOutput']);
    assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(json.hookSpecificOutput.additionalContext, /fixed the widget/);
    assert.match(json.hookSpecificOutput.additionalContext, /Your deploy workflow is mature/);
    assert.doesNotMatch(json.hookSpecificOutput.additionalContext, /Reply /);
    assert.equal(JSON.parse(fs.readFileSync(hintsPath, 'utf8')).hints[0].shown, true, 'hint marked shown once emitted');

    // Another project and a non-git directory see none of it
    assert.equal((await start(sb, 's2', other)).stdout, '');
    assert.equal((await start(sb, 's3', plain)).stdout, '');
  });

  it('detects a nested-frontmatter feedback memory written after session start', async () => {
    const sb = sandbox('memory');
    const proj = gitRepo('p-memory');
    const memDir = path.join(HOME, '.claude', 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const old = path.join(memDir, 'feedback_old.md');
    fs.writeFileSync(old, '---\nname: old\ndescription: written before the session\nmetadata:\n  type: feedback\n---\nold body\n');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(old, past, past);

    await start(sb, 'mem', proj);
    const header = readRecords(sb.obsFile('mem'))[0];
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(path.join(memDir, 'no_slack.md'),
      '---\nname: No Slack notify\ndescription: Do not offer Slack posts for personal repos\nmetadata:\n  type: feedback\n---\nBody of nested memory\n');
    fs.writeFileSync(path.join(memDir, 'feedback_flat.md'),
      '---\nname: Flat one\ndescription: Old flat frontmatter still works\ntype: feedback\n---\nflat body\n');
    fs.writeFileSync(path.join(memDir, 'project_note.md'),
      '---\nname: Not feedback\ndescription: project memory\nmetadata:\n  type: project\n---\nx\n');
    await bash(sb, 'mem', proj, 'git status');
    await end(sb, 'mem', proj);

    const cap = await waitFor(() => captured(sb, 'mem'));
    assert.ok(cap, 'a session with new feedback memories is processed even with one tool call');
    const p = cap.pending;
    assert.equal(p.project, proj);
    assert.equal(p.cwd, proj);
    assert.equal(p.sessionId, 'mem');
    assert.equal(p.sessionStartMs, header.startMs);
    assert.deepEqual(p.newMemories.map(m => m.name).sort(), ['Flat one', 'No Slack notify']);
    assert.ok(!('existingActiveRules' in p) && !('handWrittenContent' in p));
    assert.equal(cap.cwd, proj, 'processor runs in the project root');
    assert.equal(cap.child, '1', 'processor gets CLAUDE_EVOLVE_CHILD=1');
  });

  it('finds memories keyed by the git root when launched from a subfolder', async () => {
    const sb = sandbox('subfolder');
    const proj = gitRepo('p-subfolder');
    const sub = path.join(proj, 'dbt', 'project');
    fs.mkdirSync(sub, { recursive: true });
    const memDirOf = dir => path.join(HOME, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
    const rootMem = memDirOf(proj);
    const subMem = memDirOf(sub);
    fs.mkdirSync(rootMem, { recursive: true });
    fs.mkdirSync(subMem, { recursive: true });

    await start(sb, 'subf', sub);
    await new Promise(r => setTimeout(r, 20));
    const mem = (name, type = 'feedback') => `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  type: ${type}\n---\nbody\n`;
    fs.writeFileSync(path.join(rootMem, 'root_fb.md'), mem('Root feedback'));
    fs.writeFileSync(path.join(rootMem, 'root_ref.md'), mem('Root reference', 'reference'));
    fs.writeFileSync(path.join(subMem, 'sub_fb.md'), mem('Sub feedback'));
    await bash(sb, 'subf', sub, 'dbt run');
    await end(sb, 'subf', sub);

    const cap = await waitFor(() => captured(sb, 'subf'));
    assert.ok(cap, 'feedback in the root memory dir makes the session non-trivial');
    assert.equal(cap.pending.project, proj);
    assert.equal(cap.pending.cwd, sub);
    assert.deepEqual(cap.pending.newMemories.map(m => m.name).sort(), ['Root feedback', 'Sub feedback']);

    // getAllMemories (called by processRules with pending.cwd): union of both dirs, no duplicates
    const names = cwd => JSON.parse(spawnSync(process.execPath, ['-e',
      `console.log(JSON.stringify(require(${JSON.stringify(path.join(LEARNING, 'memoryReader'))}).getAllMemories(${JSON.stringify(cwd)}).map(m => m.name).sort()))`,
    ], { env: sb.env, encoding: 'utf8' }).stdout);
    assert.deepEqual(names(sub), ['Root feedback', 'Root reference', 'Sub feedback']);
    assert.deepEqual(names(proj), ['Root feedback', 'Root reference'], 'cwd == root reads the dir once');
  });

  it('exits at once under CLAUDE_EVOLVE_CHILD=1', async () => {
    const sb = sandbox('child');
    const proj = gitRepo('p-child');
    const childEnv = { ...sb.env, CLAUDE_EVOLVE_CHILD: '1' };

    const t = await runHook('post-tool.js', { session_id: 'kid', cwd: proj, tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: 'y' }, childEnv, proj);
    const s = await runHook('session-start.js', { session_id: 'kid', cwd: proj }, childEnv, proj);
    for (const r of [t, s]) {
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    }
    assert.equal(fs.existsSync(sb.obsFile('kid')), false, 'nothing recorded');

    // An existing session file is left alone by a child's SessionEnd
    await bash(sb, 'kid2', proj, 'ls');
    const e = await runHook('session-end.js', { session_id: 'kid2', cwd: proj }, childEnv, proj);
    assert.equal(e.code, 0);
    assert.equal(e.stdout, '');
    assert.equal(fs.existsSync(sb.obsFile('kid2')), true);
  });

  it('SessionStart sweeps a file whose Claude process is dead, not a live one', async () => {
    const sb = sandbox('sweep');
    const proj = gitRepo('p-sweep');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const obs = n => Array.from({ length: n }, (_, i) => JSON.stringify({ ts: Date.now(), tool: 'Bash', input: `cmd ${i}`, output: '' }));
    const write = (sid, pid) => fs.writeFileSync(sb.obsFile(sid),
      [JSON.stringify({ type: 'session', sessionId: sid, startMs: Date.now() - 1000, pid, cwd: proj }), ...obs(5)].join('\n') + '\n');
    write('dead', deadPid);
    write('alive', process.pid);
    const legacyOld = path.join(sb.tmp, 'claude-learning-123-2026-01-01.jsonl');
    const legacyNew = path.join(sb.tmp, 'claude-learning-456-2026-10-14.jsonl');
    fs.writeFileSync(legacyOld, '{}\n');
    fs.writeFileSync(legacyNew, '{}\n');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(legacyOld, twoDaysAgo, twoDaysAgo);

    const s = await start(sb, 'fresh', proj);
    assert.equal(s.code, 0);
    assert.ok(s.ms < 1000, `session-start took ${s.ms} ms`);

    const cap = await waitFor(() => captured(sb, 'dead'));
    assert.ok(cap, 'dead session processed via the sweep');
    assert.equal(cap.pending.sessionId, 'dead');
    assert.equal(cap.pending.observations.length, 5);
    assert.ok(await waitFor(() => !fs.existsSync(sb.obsFile('dead')) && !fs.existsSync(sb.obsFile('dead') + '.processing')));
    assert.equal(fs.existsSync(sb.obsFile('alive')), true, 'live session untouched');
    assert.equal(fs.existsSync(legacyOld), false, 'legacy file older than 1 day removed');
    assert.equal(fs.existsSync(legacyNew), true);
  });

  it('a trivial session spawns nothing', async () => {
    const sb = sandbox('trivial');
    const proj = gitRepo('p-trivial');
    await start(sb, 'triv', proj);
    await bash(sb, 'triv', proj, 'ls');
    await bash(sb, 'triv', proj, 'pwd');
    await end(sb, 'triv', proj);
    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(fs.readdirSync(sb.capture), []);
    assert.deepEqual(fs.readdirSync(sb.data).filter(f => f.startsWith('pending_')), []);
    assert.equal(fs.existsSync(sb.obsFile('triv')), false);
    assert.equal(sessionLog(sb).at(-1).learning, 'skipped: trivial session');
  });

  it('ignores a Stop payload (processing runs once per session, on SessionEnd)', async () => {
    const sb = sandbox('stop');
    const proj = gitRepo('p-stop');
    for (let i = 0; i < 5; i++) await bash(sb, 'stp', proj, `ls ${i}`);
    const r = await runHook('session-end.js', { session_id: 'stp', cwd: proj, hook_event_name: 'Stop' }, sb.env, proj);
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(sb.obsFile('stp')), true, 'file not claimed on Stop');
    await end(sb, 'stp', proj);
    assert.ok(await waitFor(() => captured(sb, 'stp')));
  });

  // Six tool calls: enough that the session is not trivial
  async function session(sb, sid, cwd) {
    await start(sb, sid, cwd);
    for (let i = 0; i < 6; i++) await bash(sb, sid, cwd, `ls ${i}`);
    await end(sb, sid, cwd);
  }

  async function assertNoPending(sb, cwd) {
    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(fs.readdirSync(sb.capture), []);
    assert.deepEqual(fs.readdirSync(sb.data).filter(f => f.startsWith('pending_')), []);
    const last = sessionLog(sb).at(-1);
    assert.equal(last.learning, 'skipped: no project root');
    assert.equal(last.tool_calls, 6);
  }

  it('a non-git working directory is its own root and writes pending for it', async () => {
    const sb = sandbox('nongit');
    const plain = path.join(ROOT, 'plain-nongit');
    fs.mkdirSync(plain, { recursive: true });
    await session(sb, 'ng', plain);
    const cap = await waitFor(() => captured(sb, 'ng'));
    assert.ok(cap, 'pending written');
    assert.equal(cap.pending.project, fs.realpathSync(plain));
    assert.equal(cap.pending.cwd, fs.realpathSync(plain));
  });

  it('home writes no pending', async () => {
    const sb = sandbox('home');
    await session(sb, 'hm', HOME);
    await assertNoPending(sb, HOME);
  });

  it('a folder with .claude-evolve-ignore writes no pending', async () => {
    const sb = sandbox('ignored');
    const container = path.join(ROOT, 'container');
    fs.mkdirSync(container, { recursive: true });
    fs.writeFileSync(path.join(container, '.claude-evolve-ignore'), '');
    await session(sb, 'ig', container);
    await assertNoPending(sb, container);
  });

  it('a subfolder of an ignored folder is its own root (the opt-out is not inherited)', async () => {
    const sb = sandbox('ignored-child');
    const container = path.join(ROOT, 'container2');
    const child = path.join(container, 'analysis-2026-10-21');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(container, '.claude-evolve-ignore'), '');
    await session(sb, 'igc', child);
    const cap = await waitFor(() => captured(sb, 'igc'));
    assert.ok(cap, 'pending written');
    assert.equal(cap.pending.project, fs.realpathSync(child));
  });
});

describe('memoryReader.parseFrontmatter', () => {
  const { parseFrontmatter } = require(path.join(LEARNING, 'memoryReader'));

  it('reads nested metadata.type and flat type alike', () => {
    const nested = parseFrontmatter('---\nname: x\ndescription: "a: b"\nmetadata:\n  type: feedback\n---\nbody\n');
    assert.equal(nested.type, 'feedback');
    assert.equal(nested.description, 'a: b');
    assert.equal(nested.metadata.type, 'feedback');
    assert.equal(nested.body, 'body');
    assert.equal(parseFrontmatter('---\nname: y\ntype: reference\n---\n').type, 'reference');
    assert.equal(parseFrontmatter('no frontmatter').type, undefined);
  });
});

describe('sessionMemory.generateSessionId', () => {
  const { generateSessionId } = require(path.join(LEARNING, 'sessionMemory'));

  it('is collision-safe within a day and keeps the date prefix', () => {
    const ids = Array.from({ length: 5000 }, () => generateSessionId());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids.slice(0, 50)) assert.match(id, /^\d{4}-\d{2}-\d{2}_[0-9a-f]{12}$/);

    const uuid = '3EE8BE5D-666b-453a-be0d-e626cd6e9d4a';
    const a = generateSessionId(uuid);
    const b = generateSessionId(uuid);
    assert.match(a, /^\d{4}-\d{2}-\d{2}_3ee8be5d[0-9a-f]{6}$/, 'derived from the Claude session_id');
    assert.notEqual(a, b, 'a resumed session does not overwrite its earlier summary');
    assert.equal(a.split('_')[0], new Date().toISOString().slice(0, 10));
  });
});

function splitRecords(records) {
  return {
    header: records.find(r => r.type === 'session'),
    observations: records.filter(r => r.type !== 'session'),
  };
}
