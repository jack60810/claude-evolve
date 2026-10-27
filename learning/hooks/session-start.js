#!/usr/bin/env node
// session-start.js — SessionStart hook
// 1. Opens this session's observation file; its first record holds the session start time.
// 2. Sweeps observation files of sessions that ended without SessionEnd (Claude process gone,
//    or idle for 24 h): claims each by rename and processes it in a detached
//    `session-end.js --sweep` child, so session start never waits for it.
// 3. Progressive disclosure: injects only Tier 1 context (index + stats) for the current
//    project root, as hookSpecificOutput.additionalContext. Prints nothing when there is
//    nothing to say.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LEARNING_ROOT = path.join(__dirname, '..');
const { DATA_DIR, CHILD_ENV, resolveProjectRoot } = require(path.join(LEARNING_ROOT, 'paths'));
const { readJson, writeJsonAtomic, withLock, appendBounded } = require(path.join(LEARNING_ROOT, 'fsutil'));
const sessionMemory = require(path.join(LEARNING_ROOT, 'sessionMemory'));

const ERROR_LOG = path.join(DATA_DIR, 'hook_errors.log');
const HINTS_PATH = path.join(DATA_DIR, 'skill_hints.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SWEEP = 5; // abandoned sessions handed off per session start

function logError(where, err) {
  try { appendBounded(ERROR_LOG, `${new Date().toISOString()} [session-start ${where}] ${err && err.stack || err}`); } catch {}
}

// ===================== Sweep of abandoned sessions =====================

/** Session record from the first 4 KB of an observation file (null if absent). */
function readSessionRecord(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.type === 'session') return rec;
      } catch {}
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

function isAbandoned(file, now) {
  const st = fs.statSync(file);
  if (process.getuid && st.uid !== process.getuid()) return false; // another user's session (shared /tmp)
  if (now - st.mtimeMs > DAY_MS) return true;
  const rec = readSessionRecord(file);
  return !!rec && Number.isInteger(rec.pid) && rec.pid > 1 && !pidAlive(rec.pid);
}

function sweep(currentFile) {
  const tmpDir = os.tmpdir();
  const now = Date.now();
  let claimed = 0;
  for (const f of fs.readdirSync(tmpDir)) {
    const fp = path.join(tmpDir, f);
    try {
      // Legacy files (keyed by ppid + date, before session_id keys) and claims that never finished
      const stale = (f.startsWith('claude-learning-') && f.endsWith('.jsonl')) ||
        (f.startsWith(sessionMemory.OBS_PREFIX) && f.endsWith('.jsonl.processing'));
      if (stale) {
        if (now - fs.statSync(fp).mtimeMs > DAY_MS) fs.unlinkSync(fp);
        continue;
      }
      if (!f.startsWith(sessionMemory.OBS_PREFIX) || !f.endsWith('.jsonl')) continue;
      if (fp === currentFile || claimed >= MAX_SWEEP || !isAbandoned(fp, now)) continue;

      const claimedFile = `${fp}.processing`;
      fs.renameSync(fp, claimedFile); // whoever renames first owns the file
      fs.utimesSync(claimedFile, new Date(), new Date()); // fresh claim: not "stale" to others
      claimed++;
      spawn(process.execPath, [path.join(__dirname, 'session-end.js'), '--sweep', claimedFile], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [CHILD_ENV]: '1' },
        windowsHide: true,
      }).unref();
    } catch (err) {
      if (err.code !== 'ENOENT') logError('sweep', err);
    }
  }
}

// ===================== Context sections =====================

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function buildContext(root) {
  const sections = [];
  let shownHints = [];
  let ruleEngine = null;
  let activeRules = [];

  // --- Tier 1: Session memory index (recent history of this project) ---
  try {
    const indexLines = sessionMemory.readIndex(10, root);
    if (indexLines.length > 0) {
      sections.push('[Recent Sessions]');
      sections.push(indexLines.join('\n'));
    }
  } catch (err) { logError('index', err); }

  // --- Compact rule stats ---
  try {
    ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
    activeRules = ruleEngine.getActiveRules(root);
    if (activeRules.length > 0) {
      sections.push(`[claude-evolve] ${activeRules.length} active rules (see the auto-learned section of ${require(path.join(LEARNING_ROOT, 'claudeMdWriter')).RULES_FILENAME})`);
    }
  } catch (err) { logError('rules', err); }

  // --- Skill maturity hints (marked shown only after they are printed) ---
  try {
    const hints = readJson(HINTS_PATH, { hints: [] });
    shownHints = (hints.hints || []).filter(h => !h.shown);
    if (shownHints.length > 0) {
      sections.push('[claude-evolve] Skill Update');
      for (const hint of shownHints) sections.push(`  ${hint.message}`);
    }
  } catch (err) { logError('hints', err); }

  // --- Cross-project pattern suggestions (informational) ---
  try {
    const xpStore = readJson(path.join(DATA_DIR, 'cross_project_patterns.json'), { patterns: [] });
    const patterns = xpStore.patterns || [];
    if (patterns.length > 0 && ruleEngine) {
      // Project type from the most recent session log entry of this project
      const projectName = path.basename(root);
      let currentProjectType = 'general';
      const logEntries = readJsonLines(path.join(DATA_DIR, 'session_log.jsonl')).slice(-200).reverse();
      const own = logEntries.find(e => (e.root === root || (!e.root && e.project === projectName)) && e.project_type);
      if (own) currentProjectType = own.project_type;

      const suggestions = patterns.filter(xp =>
        xp.project_type === currentProjectType &&
        xp.source_project !== root &&
        !activeRules.some(r => ruleEngine.jaccardSimilarity(r.keywords || [], xp.keywords || []) > 0.5)
      );
      if (suggestions.length > 0) {
        sections.push(`[claude-evolve] Patterns learned in other ${currentProjectType} projects (informational):`);
        for (const s of suggestions.slice(0, 3)) {
          sections.push(`  From ${path.basename(s.source_project || '')}: "${(s.content || '').slice(0, 100)}"`);
        }
      }
    }
  } catch (err) { logError('cross-project', err); }

  // --- Recent rule changes of this project (compact, last 24h) ---
  try {
    const entries = readJsonLines(path.join(DATA_DIR, 'changelog.jsonl'));
    const oneDayAgo = Date.now() - DAY_MS;
    const recent = [];
    for (let i = entries.length - 1; i >= 0 && recent.length < 10; i--) {
      const entry = entries[i];
      if (new Date(entry.timestamp).getTime() < oneDayAgo) break;
      if (entry.project !== root) continue;
      if (['add_rule', 'born', 'prune_rule', 'dead', 'distill_rules'].includes(entry.action)) recent.push(entry);
    }

    if (recent.length > 0) {
      sections.push('[Rule Changes (24h)]');
      for (const r of recent.reverse()) {
        if (r.action === 'add_rule' || r.action === 'born') {
          const src = r.source === 'observation' ? 'obs' : r.source === 'anti_pattern' ? 'fix' : r.source === 'behavior' ? 'beh' : 'corr';
          sections.push(`+ [${src}] ${(r.content || '').slice(0, 80)}`);
        } else if (r.action === 'prune_rule' || r.action === 'dead') {
          sections.push(`- pruned: ${(r.content || '').slice(0, 60)}`);
        } else if (r.action === 'distill_rules') {
          sections.push(`~ distilled ${(r.distilled_from || []).length} → 1`);
        }
      }
    }
  } catch (err) { logError('changelog', err); }

  return { sections, shownHints };
}

function markHintsShown(shown) {
  const key = h => h.pattern_id || h.message;
  const ids = new Set(shown.map(key));
  withLock(HINTS_PATH, () => {
    const hints = readJson(HINTS_PATH, { hints: [] });
    for (const h of hints.hints || []) if (ids.has(key(h))) h.shown = true;
    writeJsonAtomic(HINTS_PATH, hints);
  });
}

// ===================== Main =====================

function handle(input) {
  const data = input.trim() ? JSON.parse(input) : {};
  const cwd = data.cwd || process.cwd();
  const currentFile = sessionMemory.observationFile(sessionMemory.sessionKey(data));

  try { sessionMemory.startObservationFile(currentFile, data.session_id || null, cwd); }
  catch (err) { logError('observation-file', err); }
  try { sweep(currentFile); } catch (err) { logError('sweep', err); }

  const { root } = resolveProjectRoot(cwd);
  if (!root) return; // no project root: no rules, no project history

  const { sections, shownHints } = buildContext(root);
  if (sections.length === 0) return;

  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sections.join('\n') },
  });
  process.stdout.write(out, err => {
    if (err || shownHints.length === 0) return;
    try { markHintsShown(shownHints); } catch (e) { logError('hints-mark', e); }
  });
}

function main() {
  // Child of the processor (its own `claude` calls): nothing to inject or sweep.
  if (process.env[CHILD_ENV] === '1') return;

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try { handle(input); } catch (err) { logError('main', err); }
  });

  // Safety net if stdin never closes. unref: it never keeps a finished hook alive.
  setTimeout(() => process.exit(0), 2000).unref();
}

main();
