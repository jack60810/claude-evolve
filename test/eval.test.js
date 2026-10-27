// eval.test.js — eval/events.js on crafted transcripts: which lines count as your words,
// how tool errors are split, forks counted once, the blind labeling sheet and its scoring.
//
// Run: node --test test/eval.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EVENTS = path.join(__dirname, '..', 'eval', 'events.js');
const { scanFile, scan, writeSample, parseLabels, score, wilson } = require(EVENTS);

let ROOT, PROJECTS, CWD;

const ts = n => `2026-10-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const human = (n, text, extra = {}) => ({ type: 'user', timestamp: ts(n), cwd: CWD, entrypoint: 'cli', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text }, ...extra });
const claude = (n, text, tools = [], extra = {}) => ({
  type: 'assistant', timestamp: ts(n), cwd: CWD, entrypoint: 'cli',
  message: { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...tools.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} }))] },
  ...extra,
});
const results = (n, blocks, extra = {}) => ({ type: 'user', timestamp: ts(n), cwd: CWD, entrypoint: 'cli', message: { role: 'user', content: blocks }, ...extra });
const err = (id, content) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content });
const queued = (n, prompt, extra = {}) => ({ type: 'attachment', timestamp: ts(n), cwd: CWD, attachment: { type: 'queued_command', commandMode: 'prompt', prompt, origin: { kind: 'human' }, timestamp: ts(n), ...extra } });
const typed = events => events.filter(e => e.kind === 'human');

function transcript(name, lines) {
  const dir = path.join(PROJECTS, '-tmp-proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

before(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-eval-')));
  PROJECTS = path.join(ROOT, 'projects');
  CWD = path.join(ROOT, 'work');
  fs.mkdirSync(CWD);
});

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

describe('scanFile', () => {
  it('counts only words you typed, and flags corrections only after Claude has spoken', () => {
    const file = transcript('s1', [
      human(1, '不對，先幫我看 README'),                       // opening message: never a correction
      claude(2, 'Reading it now.', [['t1', 'Read']]),
      results(3, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      { type: 'user', timestamp: ts(4), cwd: CWD, isMeta: true, message: { role: 'user', content: '不對 meta' } },
      { type: 'user', timestamp: ts(5), cwd: CWD, origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: '<task-notification>x</task-notification>' } },
      { type: 'user', timestamp: ts(6), cwd: CWD, message: { role: 'user', content: '<command-name>/model</command-name>' } },
      { type: 'user', timestamp: ts(7), cwd: CWD, message: { role: 'user', content: 'This session is being continued from a previous conversation' } },
      human(8, '不對，我要的是 CHANGELOG'),
      human(9, 'thanks, looks good'),
      { type: 'user', timestamp: ts(10), cwd: CWD, message: { role: 'user', content: 'no, use the other file' } },  // older line: no origin
      { type: 'user', timestamp: ts(11), cwd: CWD, isSidechain: true, origin: { kind: 'human' }, message: { role: 'user', content: 'wrong' } },
      human(12, 'wrong, try the suggestion', { promptSource: 'suggestion_accepted' }),  // picked, not typed
    ]);
    const { session, events } = scanFile(file);
    const t = typed(events);
    assert.deepEqual(t.map(e => e.text), ['不對，先幫我看 README', '不對，我要的是 CHANGELOG', 'thanks, looks good', 'no, use the other file']);
    assert.deepEqual(t.map(e => e.correction), [false, true, false, true]);
    assert.equal(t[1].context, 'Reading it now.');
    assert.deepEqual(t[1].prev_tools, ['Read']);
    assert.deepEqual([session.human, session.corrections, session.tool_calls], [4, 2, 1]);
  });

  it('keeps slash-command arguments, drops pasted text, and never matches keywords inside a paste', () => {
    const file = transcript('s1b', [
      human(1, 'start'),
      claude(2, 'ok'),
      human(3, '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>don\'t touch tests</command-args>'),
      human(4, '<command-message>model</command-message>\n<command-name>/model</command-name>'),
      human(5, '/code-review ultra'),
      human(6, '<pasted_content id="p1">\nno, wrong, stop\n</pasted_content id="p1">\n幫我整理這段'),
    ]);
    const t = typed(scanFile(file).events);
    assert.deepEqual(t.map(e => e.text), ['start', 'don\'t touch tests', 'ultra', '[pasted text]\n幫我整理這段']);
    assert.deepEqual(t.map(e => e.correction), [false, true, false, false]);
  });

  it('keeps each queued message once, keyed by its source, and keeps a real repeat', () => {
    const file = transcript('s2', [
      human(1, 'start'),
      claude(2, 'working'),
      queued(3, 'wait, stop', { source_uuid: 'q1' }),
      queued(4, 'wait, stop', { source_uuid: 'q1' }),
      { type: 'attachment', timestamp: ts(5), cwd: CWD, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'agent done', origin: { kind: 'task-notification' } } },
      human(6, 'and use tabs', { promptSource: 'queued' }),
      human(7, 'wait, stop'),  // typed again on purpose: counts
    ]);
    const t = typed(scanFile(file).events);
    assert.deepEqual(t.map(e => e.text), ['start', 'wait, stop', 'and use tabs', 'wait, stop']);
    assert.equal(t[1].queued, true);
    assert.equal(t[1].correction, true);
  });

  it('splits tool errors by each result\'s own text, and a rejection\'s interrupt line is not a second event', () => {
    const file = transcript('s3', [
      human(1, 'go'),
      claude(2, '', [['a', 'Bash'], ['b', 'Edit'], ['c', 'Bash'], ['d', 'Write']]),
      results(3, [
        err('a', 'Exit code 1\nboom\nmore\nmore'),
        err('b', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\n不要改這個檔案'),
      ], { toolDenialKind: 'user-rejected' }),
      results(4, [err('c', [{ type: 'text', text: 'Permission for this action was denied by the Claude Code auto mode classifier.' }])], { toolDenialKind: 'automode-blocked' }),
      results(5, [err('d', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected.')], { toolDenialKind: 'user-rejected' }),
      results(6, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      claude(7, 'ok, waiting', [['e', 'Bash']]),
      results(8, [{ type: 'text', text: '[Request interrupted by user]' }]),
    ]);
    const { session, events } = scanFile(file);
    const pick = kind => events.filter(e => e.kind === kind);
    assert.deepEqual(pick('tool_error').map(e => [e.tool, e.text]), [['Bash', 'Exit code 1 boom more']]);
    assert.deepEqual(pick('rejected').map(e => [e.tool, e.text]), [['Edit', '不要改這個檔案'], ['Write', null]]);
    assert.deepEqual(pick('denied').map(e => [e.tool, e.reason]), [['Bash', 'automode-blocked']]);
    assert.deepEqual(pick('interrupt').map(e => e.prev_tools), [['Bash', 'Edit', 'Write']]);
    assert.deepEqual([session.tool_errors, session.rejected, session.denied, session.interrupts], [1, 2, 1, 1]);
  });

  it('redacts secrets in what it keeps', () => {
    const file = transcript('s4', [human(1, 'hi'), claude(2, 'ok'), human(3, 'no, the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')]);
    const last = scanFile(file).events.pop();
    assert.ok(!last.text.includes('abcdefghijklmnop'), last.text);
  });

  it('skips programmatic sessions (claude -p and the Agent SDK)', () => {
    for (const entrypoint of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
      const file = transcript(`s5-${entrypoint}`, [{ ...human(1, 'Summarize this'), entrypoint, origin: undefined, promptSource: 'sdk' }]);
      assert.equal(scanFile(file).session, null, entrypoint);
    }
  });
});

describe('forks and resumes', () => {
  it('counts a line shared by two transcripts once, and the fork still knows Claude spoke', () => {
    fs.rmSync(PROJECTS, { recursive: true, force: true });
    const shared = [
      human(1, 'go', { uuid: 'u1' }),
      claude(2, 'done', [['t1', 'Bash']], { uuid: 'u2' }),
      results(3, [err('t1', 'Exit code 2')], { uuid: 'u3' }),
      human(4, 'no, wrong folder', { uuid: 'u4' }),
    ];
    transcript('a-parent', shared);
    transcript('b-fork', [...shared, claude(5, 'fixed', [], { uuid: 'u5' }), human(6, 'actually, revert it', { uuid: 'u6' })]);
    const r = scan(PROJECTS, path.join(ROOT, 'out-fork'));
    const t = typed(r.events);
    assert.deepEqual(t.map(e => e.text), ['go', 'no, wrong folder', 'actually, revert it']);
    assert.equal(t[2].correction, true);
    assert.equal(r.events.filter(e => e.kind === 'tool_error').length, 1);
    assert.equal(r.sessions.reduce((n, s) => n + s.tool_calls, 0), 1);
  });
});

describe('labeling sheet and score', () => {
  let OUT;
  const mode = f => fs.statSync(path.join(OUT, f)).mode & 0o777;

  before(() => {
    OUT = path.join(ROOT, 'out');
    fs.rmSync(PROJECTS, { recursive: true, force: true });
    const lines = [human(0, 'begin'), claude(1, 'ok')];
    for (let i = 0; i < 30; i++) lines.push(human(2 + i, i < 10 ? `不對 ${i}` : `next task ${i}`), claude(2 + i, 'done'));
    transcript('big', lines);
  });

  it('writes private, sorted outputs', () => {
    const r = scan(PROJECTS, OUT);
    assert.equal(r.sessions.length, 1);
    assert.equal(mode('.'), 0o700);
    for (const f of ['events.jsonl', 'sessions.jsonl']) assert.equal(mode(f), 0o600, f);
  });

  it('samples half flagged, half unflagged, mixed, reproducibly, without showing which is which', () => {
    const r = writeSample(OUT, 8, 7);
    assert.deepEqual([r.flagged, r.plain], [4, 4]);
    assert.deepEqual(r.population, { flagged: 10, plain: 20 });
    const sheet = fs.readFileSync(r.sheet, 'utf8');
    const key = JSON.parse(fs.readFileSync(path.join(OUT, 'labels.key.json'), 'utf8'));
    assert.deepEqual((sheet.match(/^## (\S+)/gm) || []).map(h => h.slice(3)), key.items.map(i => i.id));
    const flags = key.items.map(i => i.flag);
    assert.notDeepEqual(flags, [...flags].sort().reverse(), 'flagged items must not all come first');
    assert.notDeepEqual(flags, [...flags].sort(), 'flagged items must not all come last');
    assert.ok(!/flag/i.test(sheet.split('## ').slice(1).join('')), 'item bodies must not reveal the flag');
    for (const f of ['labels.md', 'labels.key.json']) assert.equal(mode(f), 0o600, f);
    writeSample(OUT, 8, 7);
    assert.equal(fs.readFileSync(r.sheet, 'utf8'), sheet);
  });

  it('scores precision, miss rate and a recall range scaled to each half\'s population', () => {
    const key = JSON.parse(fs.readFileSync(path.join(OUT, 'labels.key.json'), 'utf8'));
    let sheet = fs.readFileSync(path.join(OUT, 'labels.md'), 'utf8');
    // Flagged: yes, y, y, n, plus nothing else. Unflagged: blank, ?, Y, N.
    const flaggedLabels = ['yes', 'y', 'y', 'n'];
    const plainLabels = [null, '?', 'Y', 'N'];
    for (const item of key.items) {
      const label = item.flag ? flaggedLabels.shift() : plainLabels.shift();
      if (label) sheet = sheet.replace(new RegExp(`(## ${item.id}[\\s\\S]*?^label:) $`, 'm'), `$1 ${label}`);
    }
    fs.writeFileSync(path.join(OUT, 'labels.md'), sheet);
    assert.equal(parseLabels(sheet).size, 7);

    const r = score(OUT);
    assert.equal(r.blank, 1);
    assert.equal(r.tally.plain['?'], 1);
    assert.equal(r.precision, 0.75);
    assert.equal(r.miss_rate, 0.5);
    // caught 10 × 0.75 = 7.5, missed 20 × 0.5 = 10 → recall = 7.5 / 17.5
    assert.ok(Math.abs(r.recall - 7.5 / 17.5) < 1e-9, String(r.recall));
    assert.ok(r.recall_range[0] < r.recall && r.recall < r.recall_range[1], JSON.stringify(r.recall_range));
    assert.equal(r.disagree.length, 2);
    assert.equal(mode('labels.score.json'), 0o600);
  });

  it('leaves out labels that are not y, n or ?, and never overwrites a sheet that has any label', () => {
    let sheet = fs.readFileSync(path.join(OUT, 'labels.md'), 'utf8');
    sheet = sheet.replace(/^label: .*$/gm, 'label: ').replace(/^label: $/m, 'label: 1');
    fs.writeFileSync(path.join(OUT, 'labels.md'), sheet);
    const r = score(OUT);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.labeled, 0);
    assert.throws(() => writeSample(OUT, 8, 7), /already has labels/);
    assert.doesNotThrow(() => writeSample(OUT, 8, 7, { force: true }));
  });

  it('wilson interval matches the closed form', () => {
    const [lo, hi] = wilson(3, 4);
    assert.equal(lo.toFixed(3), '0.301');
    assert.equal(hi.toFixed(3), '0.954');
    assert.deepEqual(wilson(0, 0), [0, 1]);
  });

  it('CLI rejects unknown flags and a bad seed', () => {
    const run = args => spawnSync(process.execPath, [EVENTS, ...args], { encoding: 'utf8' });
    const bogus = run(['--bogus']);
    assert.equal(bogus.status, 1);
    assert.match(bogus.stdout, /Usage/);
    const seed = run(['--out', OUT, '--sample', '8', '--seed', 'abc', '--force']);
    assert.equal(seed.status, 1);
    assert.match(seed.stderr, /--seed/);
  });
});
