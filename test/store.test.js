#!/usr/bin/env node
// store.test.js — Rule store safety and lifecycle
// Covers: concurrent writers, corrupt-file protection, cleanup merge, conflict auto-resolution,
// LLM failure accounting, decay + TTL pruning, v3 migration (re-key, cap, conflict drain).
// Runs offline: CLAUDE_EVOLVE_DATA_DIR and HOME point into a temp sandbox, and a stub `claude`
// is first on PATH.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-store-')));
const DATA = path.join(SANDBOX, 'data');
const BIN = path.join(SANDBOX, 'bin');
const SCENARIO = path.join(SANDBOX, 'scenario.json');
process.env.CLAUDE_EVOLVE_DATA_DIR = DATA;
process.env.HOME = path.join(SANDBOX, 'home');
process.env.STUB_CLAUDE_SCENARIO = SCENARIO;
process.env.PATH = `${BIN}:${process.env.PATH}`;
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });

// Stub CLI: --version/--help for capability detection; otherwise answers by prompt prefix
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0-stub'); process.exit(0); }
if (args.includes('--help')) { console.log('--safe-mode --tools <tools...>'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(process.env.STUB_CLAUDE_SCENARIO, 'utf8')); } catch {}
for (const [prefix, resp] of Object.entries(scenario)) {
  if (!input.includes(prefix)) continue;
  if (resp === '__FAIL__') { process.stderr.write('stub failure'); process.exit(1); }
  process.stdout.write(typeof resp === 'string' ? resp : JSON.stringify(resp)); process.exit(0);
}
if (input.includes('Classify the complexity')) process.stdout.write('{"complexity":"simple"}');
else process.stdout.write('{}');
`, { mode: 0o755 });

const LEARNING = path.join(__dirname, '..', 'learning');
const ruleEngine = require(path.join(LEARNING, 'ruleEngine'));
const writer = require(path.join(LEARNING, 'claudeMdWriter'));
const { processPending, processFile, sweepPending } = require(path.join(LEARNING, 'processRules'));
const RULES = path.join(DATA, 'rules.json');
const DAY = 24 * 60 * 60 * 1000;

function resetStore(data) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  if (data) fs.writeFileSync(RULES, JSON.stringify(data));
}

function gitRepo(name) {
  const dir = path.join(SANDBOX, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return fs.realpathSync(dir);
}

function scenario(obj) {
  fs.writeFileSync(SCENARIO, JSON.stringify(obj));
}

function mkRule(project, id, extra) {
  return {
    id, project, content: `Rule ${id}`, source: 'observation', keywords: [id, `kw-${id}`],
    score: 5, relevance_count: 0, sessions_evaluated: 0, created: new Date().toISOString().slice(0, 10),
    status: 'active', complexity: 'simple', classified: true, content_hash: null, skill_path: null,
    ...extra,
  };
}

function readJsonLines(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

describe('concurrency and corruption', () => {
  beforeEach(() => resetStore());

  it('concurrent writer processes lose no rules', async () => {
    const script = `const re = require(${JSON.stringify(path.join(LEARNING, 'ruleEngine'))});
      for (let i = 0; i < 60; i++) re.addRule('/race', 'r ' + process.argv[1] + i, 'observation', [process.argv[1] + i], 'candidate');`;
    await Promise.all(['A', 'B', 'C', 'D'].map(tag => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, tag], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
    })));
    assert.equal(ruleEngine.loadPopulation().population.length, 240, 'every rule from every writer persisted');
    assert.ok(!fs.existsSync(`${RULES}.lock`), 'lock released');
  });

  it('a corrupt rules.json is never overwritten and the backup holds the last good store', () => {
    ruleEngine.addRule('/p', 'first rule', 'observation', ['first'], 'active');
    ruleEngine.addRule('/p', 'second rule', 'observation', ['second'], 'active');
    const torn = fs.readFileSync(RULES, 'utf8').slice(0, 60);
    fs.writeFileSync(RULES, torn);

    assert.throws(() => ruleEngine.addRule('/p', 'third rule', 'observation', ['third'], 'active'));
    assert.throws(() => ruleEngine.mutatePopulation(d => { d.population = []; }));
    assert.equal(fs.readFileSync(RULES, 'utf8'), torn, 'corrupt file left as is');
    assert.ok(!fs.existsSync(`${RULES}.lock`), 'lock released after the failure');
    assert.equal(JSON.parse(fs.readFileSync(`${RULES}.bak`, 'utf8')).population.length, 1, '.bak is the store before the last save');
  });
});

describe('processor apply phase', () => {
  it('cleanup merge keeps the merged rule and retires its sources', () => {
    const proj = gitRepo('merge-proj');
    resetStore();
    const ids = ['alpha apple', 'bravo banana', 'charlie cherry', 'delta date', 'echo elder', 'foxtrot fig']
      .map(t => ruleEngine.addRule(proj, `Rule about ${t}`, 'observation', t.split(' '), 'active', 'simple').id);
    scenario({
      'Session triage': { gene: 'cleanup', complexity: 'routine', reason: 'test' },
      'Rule cleanup': { actions: [{ type: 'merge', source_ids: [ids[0], ids[1]], merged_rule: 'MERGED alpha and bravo rule', keywords: ['merged', 'alpha', 'bravo'] }] },
      'conflict detector': { results: [{ index: 0, decision: 'new', reason: 'ok' }] },
    });

    processPending({ project: proj, cwd: proj, sessionId: 'merge', observations: [], newMemories: [] });

    const pop = ruleEngine.loadPopulation().population;
    const merged = pop.find(r => r.content === 'MERGED alpha and bravo rule');
    assert.ok(merged, 'merged rule exists');
    assert.equal(merged.status, 'active');
    for (const id of ids.slice(0, 2)) {
      const src = pop.find(r => r.id === id);
      assert.equal(src.status, 'dormant');
      assert.match(src.status_reason, /merged into/);
    }
    const md = fs.readFileSync(path.join(proj, writer.RULES_FILENAME), 'utf8');
    assert.ok(md.includes('MERGED alpha and bravo rule'), 'merged rule reaches the rules file');
    assert.ok(!md.includes('Rule about alpha apple'), 'sources leave the rules file');
  });

  it('a rule that contradicts the instructions goes dormant and the conflict auto-resolves', () => {
    const proj = gitRepo('conflict-proj');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Project\n- Never post Slack notifications for personal projects\n');
    resetStore();
    scenario({
      'Session triage': { gene: 'innovate', complexity: 'routine', reason: 'test' },
      'behavior analysis engine': { patterns: [{ rule: 'After shipping, post a Slack #dev notification', keywords: ['ship', 'slack', 'notify'], confidence: 'high' }], anti_patterns: [] },
      'conflict detector': { results: [{ index: 0, decision: 'conflict', reason: 'user said no Slack posts', conflicts_with: 'Never post Slack notifications', layer: 'CLAUDE.md' }] },
    });
    const observations = [1, 2, 3].map(i => ({ ts: Date.now(), tool: 'Bash', input: `git tag v${i}`, output: '' }));

    processPending({ project: proj, cwd: proj, sessionId: 'conflict', observations, newMemories: [] });

    const rule = ruleEngine.loadPopulation().population.find(r => r.content.includes('Slack #dev'));
    assert.equal(rule.status, 'dormant');
    assert.match(rule.status_reason, /conflicts with CLAUDE\.md/);
    assert.ok(readJsonLines(path.join(DATA, 'changelog.jsonl')).some(e => e.action === 'conflict_auto_resolved'));
    assert.ok(!fs.existsSync(path.join(proj, writer.RULES_FILENAME)) ||
      !fs.readFileSync(path.join(proj, writer.RULES_FILENAME), 'utf8').includes('Slack'), 'not written');
  });

  it('LLM failures are counted in the run log and the final log line', () => {
    const proj = gitRepo('fail-proj');
    resetStore();
    scenario({ 'Session triage': '__FAIL__' });

    processPending({ project: proj, cwd: proj, sessionId: 'fail', observations: [], newMemories: [] });

    const run = readJsonLines(path.join(DATA, 'runs.jsonl')).pop();
    assert.equal(run.sessionId, 'fail');
    assert.equal(run.llmFailures, 1);
    assert.equal(run.llmFailureKinds.exit, 1);
    assert.ok(run.llmCalls >= 1 && typeof run.durationMs === 'number');
    const lastLine = fs.readFileSync(path.join(DATA, 'process.log'), 'utf8').trim().split('\n').pop();
    assert.match(lastLine, /Done with 1 LLM failures \(exit×1\)/);
  });
});

describe('skills and pending sweep', () => {
  it('skillify turns mature rules into one skill dir that the rules file routes to', () => {
    const proj = gitRepo('skill-proj');
    resetStore();
    for (const t of ['dry run first', 'filter partitions', 'confirm time range']) {
      const r = ruleEngine.addRule(proj, `Always ${t}`, 'observation', t.split(' '), 'active', 'simple');
      ruleEngine.mutatePopulation(d => { const x = d.population.find(y => y.id === r.id); x.score = 8; x.relevance_count = 6; });
    }
    scenario({
      'Session triage': { gene: 'skillify', complexity: 'routine', reason: 'test' },
      'generating a Claude Code skill file': '---\nname: auto-query-safety\ndescription: How this user keeps queries cheap and correct\n---\n\n## Workflow\n1. Dry run\n',
    });

    processPending({ project: proj, cwd: proj, sessionId: 'skill', observations: [], newMemories: [] });

    const skill = path.join(proj, '.claude', 'skills', 'auto-query-safety', 'SKILL.md');
    assert.ok(fs.existsSync(skill), 'skill written in dir format');
    const active = ruleEngine.getActiveRules(proj);
    assert.ok(active.every(r => r.complexity === 'methodology' && r.skill_path === skill), 'skill_path persisted');
    const md = fs.readFileSync(path.join(proj, writer.RULES_FILENAME), 'utf8');
    assert.ok(md.includes('.claude/skills/auto-query-safety/SKILL.md'), 'routed');
    assert.ok(!md.includes('Always dry run first'), 'methodology rules live in the skill, not the rules file');
  });

  it('sweeps pending files 1-7 days old (processed or, if rootless, deleted); R2: older than 7 days are deleted unprocessed', () => {
    const proj = gitRepo('sweep-proj');
    resetStore();
    scenario({});
    const old = new Date(Date.now() - 2 * DAY);
    const valid = path.join(DATA, 'pending_old1.json');
    const rootless = path.join(DATA, 'pending_old2.json');
    const fresh = path.join(DATA, 'pending_fresh.json');
    fs.writeFileSync(valid, JSON.stringify({ project: proj, cwd: proj, sessionId: 'old1', observations: [], newMemories: [] }));
    fs.writeFileSync(rootless, JSON.stringify({ project: path.join(SANDBOX, 'no-such-dir'), observations: [] }));  // old format
    fs.writeFileSync(fresh, JSON.stringify({ project: proj, cwd: proj, sessionId: 'fresh' }));
    for (const f of [valid, rootless]) fs.utimesSync(f, old, old);
    const ancient = path.join(DATA, 'pending_april.json');
    fs.writeFileSync(ancient, JSON.stringify({ project: proj, cwd: proj, sessionId: 'april', observations: [], newMemories: [{ name: 'x', content: 'y' }] }));
    const april = new Date(Date.now() - 8 * DAY);
    fs.utimesSync(ancient, april, april);

    sweepPending(null);

    assert.ok(!fs.existsSync(ancient), 'R2: the 8-day-old file is gone');
    assert.ok(!readJsonLines(path.join(DATA, 'runs.jsonl')).some(r => r.sessionId === 'april'), 'R2: and was never processed');
    assert.match(fs.readFileSync(path.join(DATA, 'process.log'), 'utf8'), /pending_april\.json is 8 days old; deleted without processing/);
    assert.ok(!fs.existsSync(valid) && !fs.existsSync(rootless), 'old files handled');
    assert.ok(fs.existsSync(fresh), 'a fresh pending file belongs to a live processor');
    assert.ok(readJsonLines(path.join(DATA, 'runs.jsonl')).some(r => r.sessionId === 'old1'), 'valid one processed');
  });
});

describe('reviewer regressions', () => {
  it('R5: a pending for a project that no longer exists is skipped and the dir is not recreated', () => {
    const proj = gitRepo('gone-proj');
    resetStore();
    ruleEngine.addRule(proj, 'a rule for a deleted worktree', 'observation', ['deleted', 'worktree'], 'active', 'simple');
    fs.rmSync(proj, { recursive: true, force: true });
    scenario({ 'Session triage': { gene: 'innovate', complexity: 'routine' } });
    const res = processPending({ project: proj, cwd: proj, sessionId: 'gone', observations: [], newMemories: [] });
    assert.equal(res.skipped, 'project missing');
    assert.ok(!fs.existsSync(proj), 'project dir not recreated');
  });

  it('R9: the rules file is written from the active set re-read after the skill step', () => {
    const proj = gitRepo('reread-proj');
    resetStore();
    for (const t of ['dry run first', 'filter partitions', 'confirm time range']) {
      const r = ruleEngine.addRule(proj, `Always ${t}`, 'observation', t.split(' '), 'active', 'simple');
      ruleEngine.mutatePopulation(d => { const x = d.population.find(y => y.id === r.id); x.score = 8; x.relevance_count = 6; });
    }
    scenario({
      'Session triage': { gene: 'skillify', complexity: 'routine' },
      'generating a Claude Code skill file': '---\nname: auto-reread\ndescription: d\n---\nbody\n',
    });
    // A concurrent processor adds a rule while this one is in its (slow) skill step
    const skillWriter = require(path.join(LEARNING, 'skillWriter'));
    const orig = skillWriter.writeSkill;
    skillWriter.writeSkill = (...args) => {
      ruleEngine.addRule(proj, 'Rule learned by a concurrent processor', 'observation', ['concurrent', 'processor'], 'active', 'simple');
      return orig(...args);
    };
    try {
      processPending({ project: proj, cwd: proj, sessionId: 'reread', observations: [], newMemories: [] });
    } finally {
      skillWriter.writeSkill = orig;
    }
    const md = fs.readFileSync(path.join(proj, writer.RULES_FILENAME), 'utf8');
    assert.ok(md.includes('Rule learned by a concurrent processor'));
  });

  it('R10: a failure after the apply step is retried as writes only (counted and scored once)', () => {
    const proj = gitRepo('retry-proj');
    resetStore();
    const r = ruleEngine.addRule(proj, 'Run git status before committing', 'observation', ['git', 'status'], 'active', 'simple');
    scenario({ 'Session triage': { gene: 'observe', complexity: 'routine' } });
    const observations = [1, 2, 3].map(i => ({ ts: Date.now(), tool: 'Bash', input: `git status ${i}`, output: '' }));
    const file = path.join(DATA, 'pending_retry.json');
    fs.writeFileSync(file, JSON.stringify({ project: proj, cwd: proj, sessionId: 'retry', observations, newMemories: [] }));

    const origWrite = writer.writeRules;
    writer.writeRules = () => { throw new Error('disk full'); };
    try { processFile(file); } finally { writer.writeRules = origWrite; }

    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(kept.applied, 'pending marked applied before the failure');
    assert.equal(kept.attempts, 1);
    const after1 = ruleEngine.loadPopulation();
    const rule1 = after1.population.find(x => x.id === r.id);

    processFile(file);

    const after2 = ruleEngine.loadPopulation();
    const rule2 = after2.population.find(x => x.id === r.id);
    assert.equal(after2.session_count, after1.session_count, 'session counted once');
    assert.equal(rule2.score, rule1.score, 'scored once');
    assert.equal(rule2.sessions_evaluated, rule1.sessions_evaluated);
    assert.ok(!fs.existsSync(file), 'pending done');
    assert.ok(fs.readFileSync(path.join(proj, writer.RULES_FILENAME), 'utf8').includes('Run git status before committing'), 'writes redone');
  });

  it('R1: the pre-migration rules.json and conflicts.json are kept and never overwritten', () => {
    const P = gitRepo('r1-proj');
    const original = JSON.stringify({ version: 2, session_count: 4, population: [mkRule(P, 'keep1')] });
    const conflicts = JSON.stringify({ version: 1, pending: [{ id: 'c1', project: P, status: 'pending' }] });
    resetStore();
    fs.writeFileSync(RULES, original);
    fs.writeFileSync(path.join(DATA, 'conflicts.json'), conflicts);
    ruleEngine.migrateStore();
    for (let i = 0; i < 3; i++) ruleEngine.addRule(P, `later save ${i}`, 'observation', [`later${i}`], 'candidate');
    assert.equal(fs.readFileSync(path.join(DATA, 'rules.v2.bak.json'), 'utf8'), original, 'v2 store kept byte for byte');
    assert.equal(fs.readFileSync(path.join(DATA, 'conflicts.v1.bak.json'), 'utf8'), conflicts);
    // Even a second v2 store migrating later never overwrites the first copy
    fs.writeFileSync(RULES, JSON.stringify({ version: 2, session_count: 0, population: [] }));
    ruleEngine.migrateStore();
    assert.equal(fs.readFileSync(path.join(DATA, 'rules.v2.bak.json'), 'utf8'), original);
  });
});

describe('lifecycle: decay and TTL', () => {
  const P = '/lifecycle/project';

  it('an unused rule decays below the demotion line within a bounded number of sessions', () => {
    resetStore({ version: 3, session_count: 0, population: [mkRule(P, 'unused', { keywords: ['zzz', 'yyy'] }), mkRule(P, 'used', { keywords: ['deploy', 'tag'] })] });
    let sessions = 0;
    let demoted = [];
    while (sessions < 40 && demoted.length === 0) {
      sessions++;
      demoted = ruleEngine.mutatePopulation(d => {
        ruleEngine.scoreFromObservations(d, P, 'git tag v1 && npm run deploy');
        return ruleEngine.lifecycleIn(d, P).demoted;
      });
    }
    assert.equal(demoted.length, 1);
    assert.equal(demoted[0].id, 'unused');
    assert.ok(sessions > 3 && sessions <= 15, `decay took ${sessions} sessions`);
    const used = ruleEngine.loadPopulation().population.find(r => r.id === 'used');
    assert.equal(used.status, 'active');
    assert.ok(used.score > 7, 'a rule that keeps matching climbs');
    assert.ok(used.last_evaluated, 'scoring stamps last_evaluated');
  });

  it('expired candidates and long-dormant rules are pruned into the archive', () => {
    const old = new Date(Date.now() - 90 * DAY).toISOString();
    resetStore({ version: 3, session_count: 0, population: [
      mkRule(P, 'fresh-candidate', { status: 'candidate' }),
      mkRule(P, 'old-candidate', { status: 'candidate', created: old.slice(0, 10) }),
      mkRule(P, 'old-dormant', { status: 'dormant', status_changed_at: old }),
      mkRule(P, 'dead-one', { status: 'dead' }),
    ] });
    const res = ruleEngine.applyLifecycle(P);

    assert.deepEqual(res.pruned.map(r => r.id).sort(), ['dead-one', 'old-candidate', 'old-dormant']);
    const left = ruleEngine.loadPopulation().population;
    assert.deepEqual(left.map(r => r.id), ['fresh-candidate']);
    assert.equal(left[0].status, 'active', 'fresh candidate promoted into the free slot');
    const archived = readJsonLines(ruleEngine.ARCHIVE_PATH).map(r => r.id).sort();
    assert.deepEqual(archived, ['dead-one', 'old-candidate', 'old-dormant']);
  });
});

describe('v3 migration', () => {
  it('re-keys subdirectory projects to the git root, holds the cap and drains conflicts', () => {
    const root = gitRepo('mono');
    const sub = path.join(root, 'packages', 'a');
    fs.mkdirSync(sub, { recursive: true });
    const orphan = path.join(SANDBOX, 'plain-folder');
    fs.mkdirSync(orphan, { recursive: true });

    const population = [];
    for (let i = 0; i < 8; i++) population.push(mkRule(root, `root${i}`, { score: 5 + i / 10 }));
    for (let i = 0; i < 8; i++) population.push(mkRule(sub, `sub${i}`, { score: 6 + i / 10 }));
    population.push(mkRule(root, 'distilled1', { status: 'distilled' }));
    population.push(mkRule(orphan, 'orphan1'));
    resetStore({ version: 2, session_count: 7, population });
    fs.writeFileSync(path.join(DATA, 'conflicts.json'), JSON.stringify({ version: 1, pending: [
      { id: 'c_1', project: root, new_content: 'x', conflicts_with: 'y', status: 'pending' },
      { id: 'c_2', project: sub, new_content: 'x', conflicts_with: 'y', status: 'pending' },
    ] }));

    const stats = ruleEngine.migrateStore();
    assert.deepEqual({ rekeyed: stats.rekeyed, archived: stats.archived, capped: stats.capped, drained: stats.conflicts_drained },
      { rekeyed: 8, archived: 1, capped: 6, drained: 2 });

    const data = ruleEngine.loadPopulation();
    assert.equal(data.version, ruleEngine.SCHEMA_VERSION);
    assert.equal(data.session_count, 7);
    const atRoot = data.population.filter(r => r.project === root);
    assert.equal(atRoot.filter(r => r.status === 'active').length, ruleEngine.MAX_ACTIVE, 'cap holds after the merge');
    assert.equal(atRoot.filter(r => r.status === 'candidate').length, 6);
    assert.equal(data.population.filter(r => r.project === sub).length, 0, 'no subdirectory keys left');
    // Highest scores keep the active slots (sub rules scored 6.x beat root rules at 5.x)
    assert.ok(atRoot.filter(r => r.status === 'active').every(r => r.score >= 5.6));
    assert.equal(data.population.find(r => r.id === 'orphan1').project, orphan, 'a plain folder outside git is its own root');

    assert.equal(ruleEngine.loadConflicts().pending.length, 0, 'conflicts.json drained');
    assert.equal(readJsonLines(path.join(DATA, 'conflicts_archive.jsonl')).length, 2);
    assert.equal(ruleEngine.migrateStore(), null, 'second run is a no-op');
  });
});
