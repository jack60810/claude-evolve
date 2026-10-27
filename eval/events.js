#!/usr/bin/env node
// events.js — Turns raw Claude Code transcripts into outcome events, so you can measure whether
// learned rules cut repeat mistakes. It reads ~/.claude/projects/*/*.jsonl, not the learning
// store: the store only holds what the system already chose to keep, so it can't judge itself.
//
//   node eval/events.js                  scan → <data>/eval/events.jsonl and sessions.jsonl
//   node eval/events.js --sample 100     blind labeling sheet → <data>/eval/labels.md
//   node eval/events.js --score          precision and estimated recall of the correction flag
//
// Event kinds: human (a message you typed; flagged when it looks like a correction), interrupt,
// rejected (you declined a tool call; your reason, if any, is the text), denied (a permission
// rule or the auto mode classifier blocked it), tool_error. Programmatic sessions (claude -p,
// Agent SDK) are skipped. A forked or resumed session repeats its parent's lines; each line is
// counted once, by its uuid. Output stays on this machine, is redacted and is mode 0600.
// No model is called.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR, resolveProjectRoot } = require('../learning/paths');
const { redact } = require('../learning/redact');
const { writeFileAtomic } = require('../learning/fsutil');

const MAX_TEXT = 1000;
const MAX_CONTEXT = 300;

// A message that reacts to what Claude just did. A starting point, not ground truth:
// --sample and --score measure how often it is right on your own messages.
const CORRECTION = [
  /不對|不是這|不是我|錯了|搞錯|弄錯|誤會|我(是)?說|我要的是|我的意思是|應該(是|要)|重來|重做|改回|還原|拿掉|不要再|別再|你(又|還是?|沒|忘)|為什麼(你|又|沒|不|要)|怎麼(又|還|沒)|沒有照|不是叫你|停下|先停|等等|等一下|不用了?|太(長|多|複雜|囉嗦)|看不懂|漏了|少了/,
  /\b(no|nope|wrong|incorrect|instead|actually|revert|undo|stop|wait)\b|\bnot what\b|\bthat'?s not\b|\bi (said|meant|asked)\b|\bdon'?t\b|\bdo not\b|\bwhy did you\b|\byou forgot\b|\bstill (not|broken|failing|wrong)\b/i,
];
const SYSTEM_TEXT = /^\s*(<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)\b|This session is being continued|Caveat:)/;
// A slash command counts by what you typed after its name: the <command-args> of the tagged
// form, or the rest of the line of the raw "/name args" form.
const COMMAND_TAGS = /^\s*<command-(message|name|args)>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_RAW = /^\s*\/[\w:-]+(\s+|$)/;
// Pasted text is someone else's words; keep a marker, not the paste.
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;
const INTERRUPT = /^\s*\[Request interrupted by user/;
const INTERRUPT_TOOL = /^\s*\[Request interrupted by user for tool use\]/;
const REJECTED = /^The user doesn't want to (proceed|take this action)/;
const DENIED = /^Permission for this (action|command) was denied/;
const USER_SAID = /the user said:\s*([\s\S]*)$/i;
const PROGRAMMATIC = /^sdk/;

const looksLikeCorrection = text => CORRECTION.some(re => re.test(text));
const clip = (text, max) => { const t = redact(String(text).trim()); return t.length > max ? t.slice(0, max) + '…' : t; };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  return Array.isArray(block.content) ? block.content.map(x => (x && x.text) || '').join('\n') : '';
}

// The part of a message that you wrote yourself.
function ownWords(text) {
  let t = text;
  if (COMMAND_TAGS.test(t)) { const m = t.match(COMMAND_ARGS); t = m ? m[1] : ''; }
  else t = t.replace(COMMAND_RAW, '');
  return t.replace(PASTED, '[pasted text]').trim();
}

// Newer lines say who wrote them (origin, promptSource); both must agree when both are there.
// Older lines say neither, and then only a plain string counts: tool results and injected
// context arrive as arrays or meta lines.
function typedByHuman(o) {
  if (o.isMeta || o.isCompactSummary || o.isSidechain) return false;
  if (o.origin && o.origin.kind !== 'human') return false;
  if (o.promptSource && o.promptSource !== 'typed' && o.promptSource !== 'queued') return false;
  if (o.origin || o.promptSource) return true;
  return typeof (o.message && o.message.content) === 'string';
}

// One transcript → { session, events }. session is null for programmatic sessions.
// seen holds line uuids already counted in other transcripts (forks and resumes).
function scanFile(file, rootCache = new Map(), seen = new Set()) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events = [];
  const toolNames = new Map();
  const queuedSeen = new Set();
  const s = {
    session: path.basename(file, '.jsonl'), file, cwd: null, project: null, entrypoint: null,
    start: null, end: null, human: 0, corrections: 0, interrupts: 0, rejected: 0, denied: 0,
    tool_calls: 0, tool_errors: 0,
  };
  let afterClaude = false;    // has Claude spoken yet? A session's opening message corrects nothing.
  let lastClaude = '';
  let prevTools = [];
  let afterRejection = false; // a rejection without a reason is followed by an interrupt line

  const add = (o, kind, fields) => {
    events.push({ session: s.session, ts: o.timestamp || null, cwd: o.cwd || s.cwd, kind, ...fields });
  };
  const addHuman = (o, raw, queued, emit) => {
    const t = ownWords(raw);
    if (!t || SYSTEM_TEXT.test(raw) || INTERRUPT.test(raw)) return;
    afterRejection = false;
    if (emit) {
      const correction = afterClaude && looksLikeCorrection(t);
      s.human++;
      if (correction) s.corrections++;
      add(o, 'human', {
        ...(queued && queued.timestamp ? { ts: queued.timestamp } : {}),
        text: clip(t, MAX_TEXT), correction, after_claude: afterClaude, prev_tools: prevTools,
        context: lastClaude ? clip(lastClaude, MAX_CONTEXT) : null, ...(queued ? { queued: true } : {}),
      });
    }
    prevTools = [];
  };
  const addInterrupt = (o, text, emit) => {
    if (afterRejection && INTERRUPT_TOOL.test(text)) { afterRejection = false; return; }
    if (!emit) return;
    s.interrupts++;
    add(o, 'interrupt', { prev_tools: prevTools });
  };

  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const emit = !(o.uuid && seen.has(o.uuid));
    if (o.uuid) seen.add(o.uuid);
    if (o.entrypoint && !s.entrypoint) s.entrypoint = o.entrypoint;
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.timestamp) {
      if (!s.start || o.timestamp < s.start) s.start = o.timestamp;
      if (!s.end || o.timestamp > s.end) s.end = o.timestamp;
    }
    if (o.isSidechain) continue;

    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      afterClaude = true;
      afterRejection = false;
      const said = textOf(o.message.content).trim();
      if (said) lastClaude = said;
      for (const b of o.message.content) {
        if (b && b.type === 'tool_use') {
          if (emit) s.tool_calls++;
          toolNames.set(b.id, b.name);
          if (!prevTools.includes(b.name)) prevTools = [...prevTools, b.name];
        }
      }
      continue;
    }

    if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command') {
      const a = o.attachment;
      if (a.commandMode !== 'prompt' || a.isMeta || (a.origin && a.origin.kind !== 'human') || typeof a.prompt !== 'string') continue;
      if (a.source_uuid) {
        if (queuedSeen.has(a.source_uuid)) continue;
        queuedSeen.add(a.source_uuid);
      }
      addHuman(o, a.prompt, a, emit);
      continue;
    }

    if (o.type !== 'user' || !o.message) continue;
    const content = o.message.content;
    const blocks = Array.isArray(content) ? content.filter(Boolean) : [];

    // Results first: a rejection and its interrupt line can share one message.
    for (const b of blocks) {
      if (b.type !== 'tool_result' || !b.is_error) continue;
      const text = resultText(b).trim();
      const tool = toolNames.get(b.tool_use_id) || null;
      // Classify by the result's own text: toolDenialKind is per line, and one line can carry
      // several parallel results.
      if (REJECTED.test(text)) {
        afterRejection = true;
        if (!emit) continue;
        s.rejected++;
        const said = text.match(USER_SAID);
        add(o, 'rejected', { tool, text: said ? clip(said[1], MAX_TEXT) : null });
      } else if (!emit) {
        continue;
      } else if (DENIED.test(text)) {
        s.denied++;
        add(o, 'denied', { tool, reason: o.toolDenialKind || null, text: clip(text.split('\n')[0], 200) });
      } else {
        s.tool_errors++;
        add(o, 'tool_error', { tool, text: clip(text.split('\n').slice(0, 3).join(' '), 200) });
      }
    }
    for (const b of blocks) if (b.type === 'text' && INTERRUPT.test(b.text || '')) addInterrupt(o, b.text, emit);
    if (typeof content === 'string' && INTERRUPT.test(content)) addInterrupt(o, content, emit);
    if (typedByHuman(o)) addHuman(o, textOf(content), null, emit);
  }

  if (PROGRAMMATIC.test(s.entrypoint || '')) return { session: null, events: [] };
  if (s.cwd) {
    if (!rootCache.has(s.cwd)) rootCache.set(s.cwd, resolveProjectRoot(s.cwd).root);
    s.project = rootCache.get(s.cwd);
  }
  for (const e of events) e.project = s.project;
  return { session: s, events };
}

function transcriptFiles(projectsDir) {
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return files; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
  }
  return files.sort();
}

const writePrivate = (file, text) => writeFileAtomic(file, text, { mode: 0o600 });
const toJsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const readJsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function scan(projectsDir, outDir) {
  const sessions = [];
  const events = [];
  const rootCache = new Map();
  const seen = new Set();
  let skipped = 0;
  for (const file of transcriptFiles(projectsDir)) {
    const r = scanFile(file, rootCache, seen);
    if (!r.session) { skipped++; continue; }
    r.session.file = path.relative(projectsDir, file);
    sessions.push(r.session);
    events.push(...r.events);
  }
  sessions.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writePrivate(path.join(outDir, 'sessions.jsonl'), toJsonl(sessions));
  writePrivate(path.join(outDir, 'events.jsonl'), toJsonl(events));
  return { sessions, events, skipped };
}

// Seeded so a sheet can be rebuilt exactly.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Half the sheet comes from flagged messages (measures precision), half from unflagged ones
// (measures what the flag misses). The sheet never shows which half a message is from.
function writeSample(outDir, n, seed, { force = false } = {}) {
  const sheet = path.join(outDir, 'labels.md');
  if (!force && fs.existsSync(sheet) && parseLabels(fs.readFileSync(sheet, 'utf8')).size) {
    throw new Error(`${sheet} already has labels. Score it, or pass --force to replace it.`);
  }
  const eligible = readJsonl(path.join(outDir, 'events.jsonl')).filter(e => e.kind === 'human' && e.after_claude);
  const flagged = eligible.filter(e => e.correction);
  const plain = eligible.filter(e => !e.correction);
  const rand = rng(seed);
  const kf = Math.min(Math.ceil(n / 2), flagged.length);
  const ku = Math.min(n - kf, plain.length);
  const picks = shuffle([
    ...shuffle(flagged, rand).slice(0, kf).map(e => ({ e, flag: true })),
    ...shuffle(plain, rand).slice(0, ku).map(e => ({ e, flag: false })),
  ], rand);

  const width = String(picks.length).length;
  const items = picks.map((p, i) => ({ id: String(i + 1).padStart(width, '0'), flag: p.flag, session: p.e.session, ts: p.e.ts }));
  const quote = t => String(t || '').split('\n').map(l => `> ${l}`).join('\n');
  const where = e => (e.project || e.cwd || '').replace(os.homedir(), '~');
  const body = picks.map((p, i) => [
    `## ${items[i].id}`,
    `${String(p.e.ts || '').slice(0, 10)} · ${where(p.e)}`,
    ...(p.e.context ? ['', 'Claude:', quote(p.e.context)] : []),
    '', 'You:', quote(p.e.text), '', 'label: ', '',
  ].join('\n'));
  const header = [
    '# Correction labels',
    '',
    '每則訊息標一個：y＝在糾正 Claude 剛做的事，或說它沒照你的意思做。n＝新任務、追問、同意或閒聊。?＝看不出來。',
    'Mark each message: y = it corrects what Claude just did, or says Claude missed what you meant.',
    'n = a new task, a follow-up, an approval or small talk. ? = can\'t tell.',
    '',
    'Then run: node eval/events.js --score',
    '', '',
  ].join('\n');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writePrivate(sheet, header + body.join('\n'));
  writePrivate(path.join(outDir, 'labels.key.json'), JSON.stringify({
    created: new Date().toISOString(), seed, population: { flagged: flagged.length, plain: plain.length }, items,
  }, null, 2) + '\n');
  return { sheet, flagged: kf, plain: ku, population: { flagged: flagged.length, plain: plain.length } };
}

const LABEL_VALUES = { y: 'y', yes: 'y', n: 'n', no: 'n', '?': '?' };

// id → what was written after "label:". Blank labels are left out.
function parseLabels(text) {
  const labels = new Map();
  for (const chunk of text.split(/^## /m).slice(1)) {
    const id = chunk.split(/\s/)[0];
    const m = chunk.match(/^label:[ \t]*(.*)$/m);
    if (m && m[1].trim()) labels.set(id, m[1].trim());
  }
  return labels;
}

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

function score(outDir) {
  const key = JSON.parse(fs.readFileSync(path.join(outDir, 'labels.key.json'), 'utf8'));
  const labels = parseLabels(fs.readFileSync(path.join(outDir, 'labels.md'), 'utf8'));
  const tally = { flagged: { y: 0, n: 0, '?': 0 }, plain: { y: 0, n: 0, '?': 0 } };
  const disagree = [];
  const invalid = [];
  let blank = 0;
  for (const item of key.items) {
    const raw = labels.get(item.id);
    if (!raw) { blank++; continue; }
    const label = LABEL_VALUES[raw.toLowerCase()];
    if (!label) { invalid.push(item.id); continue; }
    tally[item.flag ? 'flagged' : 'plain'][label]++;
    if (label !== '?' && (label === 'y') !== item.flag) disagree.push(item.id);
  }
  const fl = tally.flagged.y + tally.flagged.n;
  const pl = tally.plain.y + tally.plain.n;
  const precision = fl ? tally.flagged.y / fl : null;
  const missRate = pl ? tally.plain.y / pl : null;
  const precisionCi = wilson(tally.flagged.y, fl);
  const missRateCi = wilson(tally.plain.y, pl);
  // Scale each half back to its population: flagged × precision are real corrections the flag
  // catches, unflagged × miss rate are real corrections it misses.
  const recallOf = (p, m) => {
    const caught = key.population.flagged * p;
    const missed = key.population.plain * m;
    return caught + missed === 0 ? null : caught / (caught + missed);
  };
  const ready = precision !== null && missRate !== null;
  const result = {
    scored: new Date().toISOString(), labeled: key.items.length - blank - invalid.length, blank, invalid, tally,
    precision, precision_ci: precisionCi, miss_rate: missRate, miss_rate_ci: missRateCi, population: key.population,
    est_caught: ready ? key.population.flagged * precision : null,
    est_missed: ready ? key.population.plain * missRate : null,
    recall: ready ? recallOf(precision, missRate) : null,
    // Not a confidence interval: the worst and best case of the two intervals above.
    recall_range: ready ? [recallOf(precisionCi[0], missRateCi[1]), recallOf(precisionCi[1], missRateCi[0])] : null,
    disagree,
  };
  writePrivate(path.join(outDir, 'labels.score.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

const pct = x => x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`;
const range = ([lo, hi]) => `${pct(lo)}–${pct(hi)}`;

function main(argv) {
  const args = argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i < 0 ? null : (args[i + 1] || ''); };
  const known = new Set(['--projects-dir', '--out', '--sample', '--seed', '--score', '--force', '--help']);
  const unknown = args.filter(a => a.startsWith('--') && !known.has(a));
  if (args.includes('--help') || unknown.length) {
    console.log('Usage: node eval/events.js [--projects-dir DIR] [--out DIR] [--sample N [--seed S] [--force] | --score]');
    return unknown.length ? 1 : 0;
  }
  const projectsDir = path.resolve(opt('--projects-dir') || path.join(os.homedir(), '.claude', 'projects'));
  const outDir = path.resolve(opt('--out') || path.join(DATA_DIR, 'eval'));

  if (args.includes('--score')) {
    const r = score(outDir);
    const asked = r.labeled + r.blank + r.invalid.length;
    console.log(`Labeled ${r.labeled}/${asked} (? ${r.tally.flagged['?'] + r.tally.plain['?']}, blank ${r.blank})`);
    if (r.invalid.length) console.log(`Not y, n or ?, left out: ${r.invalid.join(' ')}`);
    console.log(`Precision of the correction flag: ${r.tally.flagged.y}/${r.tally.flagged.y + r.tally.flagged.n} = ${pct(r.precision)} (95% CI ${range(r.precision_ci)})`);
    console.log(`Corrections the flag missed: ${r.tally.plain.y}/${r.tally.plain.y + r.tally.plain.n} = ${pct(r.miss_rate)} (95% CI ${range(r.miss_rate_ci)})`);
    console.log(`Estimated recall: ${pct(r.recall)}${r.recall_range ? ` (between ${range(r.recall_range)} at the ends of both intervals)` : ''}; population ${r.population.flagged} flagged, ${r.population.plain} unflagged`);
    if (r.disagree.length) console.log(`Flag and label disagree on: ${r.disagree.join(' ')}`);
    return 0;
  }
  if (args.includes('--sample')) {
    const n = Number(opt('--sample'));
    const seed = opt('--seed') === null ? 1 : Number(opt('--seed'));
    if (!Number.isInteger(n) || n <= 0) { console.error('--sample needs a positive whole number'); return 1; }
    if (!Number.isInteger(seed)) { console.error('--seed needs a whole number'); return 1; }
    const r = writeSample(outDir, n, seed, { force: args.includes('--force') });
    console.log(`Wrote ${r.flagged + r.plain} messages to ${r.sheet} (${r.flagged} flagged of ${r.population.flagged}, ${r.plain} unflagged of ${r.population.plain})`);
    return 0;
  }

  const r = scan(projectsDir, outDir);
  const count = kind => r.events.filter(e => e.kind === kind).length;
  const human = r.events.filter(e => e.kind === 'human');
  const first = r.sessions.length ? String(r.sessions[0].start).slice(0, 10) : '-';
  const last = r.sessions.length ? String(r.sessions.reduce((m, s) => s.end > m ? s.end : m, '')).slice(0, 10) : '-';
  console.log(`Scanned ${r.sessions.length} sessions (${r.skipped} programmatic skipped), ${first} to ${last}`);
  console.log(`human ${human.length} (looks like a correction: ${human.filter(e => e.correction).length}), interrupt ${count('interrupt')}, rejected ${count('rejected')}, denied ${count('denied')}, tool_error ${count('tool_error')}, tool calls ${r.sessions.reduce((n, s) => n + s.tool_calls, 0)}`);
  console.log(`Wrote ${path.join(outDir, 'events.jsonl')} and sessions.jsonl`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { scanFile, scan, writeSample, parseLabels, score, wilson, looksLikeCorrection, ownWords };
