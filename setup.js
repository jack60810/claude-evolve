#!/usr/bin/env node
// setup.js — Install or uninstall claude-evolve hooks into Claude Code settings.
//
// Usage:
//   node setup.js           # Install hooks
//   node setup.js --check   # Check if hooks are installed
//   node setup.js --remove  # Uninstall hooks
//   node setup.js --clean-stale [--yes]  # Show (or apply) cleanup of misplaced rule blocks

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { DATA_DIR } = require('./learning/paths');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOKS_DIR = path.join(__dirname, 'learning', 'hooks');

// session-end.js runs once per session (SessionEnd). Earlier versions registered it on Stop,
// which fires after every response, so `legacy` lists the events to migrate it away from.
const HOOK_DEFS = [
  { event: 'SessionStart', file: 'session-start.js', timeout: 3 },
  { event: 'PostToolUse', file: 'post-tool.js', timeout: 2 },
  { event: 'SessionEnd', file: 'session-end.js', timeout: 8, legacy: ['Stop'] },
].map(def => ({ ...def, script: path.join(HOOKS_DIR, def.file) }));

const SCAN_EVENTS = ['SessionStart', 'PostToolUse', 'SessionEnd', 'Stop'];

const USAGE = `claude-evolve setup

Usage:
  node setup.js           Install hooks into Claude Code settings
  node setup.js --check   Verify installation
  node setup.js --remove  Uninstall hooks
  node setup.js --clean-stale        Show what cleaning misplaced rule blocks would do (writes nothing)
  node setup.js --clean-stale --yes  Apply it (backs up every touched file first)
  node setup.js --help    Show this help`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// --- Hook commands ---

const WIN = process.platform === 'win32';

function hookCommand(script) {
  return `node "${WIN ? script : script.replace(/(["\\$`])/g, '\\$1')}"`;
}

// Script path inside a hook command. Accepts quoted and old unquoted forms.
function hookScript(command) {
  const m = /^\s*node\s+(.+?)\s*$/.exec(command || '');
  if (!m) return null;
  const arg = m[1];
  if (/^".*"$/.test(arg) || /^'.*'$/.test(arg)) {
    const inner = arg.slice(1, -1);
    return WIN ? inner : inner.replace(/\\(["\\$`])/g, '$1');
  }
  return arg;
}

// A hook is ours when its script is learning/hooks/<name>.js, wherever the checkout lives.
function ourHook(h, file) {
  const script = h && hookScript(h.command);
  const m = script && /[\\/]learning[\\/]hooks[\\/](post-tool|session-start|session-end)\.js$/.exec(script);
  return !!m && (!file || m[1] + '.js' === file);
}

// --- Settings file ---

function readSettings() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    fail(`ERROR: Cannot read ${SETTINGS_PATH}: ${e.message}`);
  }
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`ERROR: ${SETTINGS_PATH} is not valid JSON (${e.message}).\nNothing was changed. Fix the file (no comments or trailing commas), then run again.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`ERROR: ${SETTINGS_PATH} must contain a JSON object. Nothing was changed.`);
  }
  return parsed;
}

function writeSettings(settings) {
  // Write through a symlink (dotfile managers) instead of replacing it.
  const target = fs.existsSync(SETTINGS_PATH) ? fs.realpathSync(SETTINGS_PATH) : SETTINGS_PATH;
  let mode = 0o644;
  if (fs.existsSync(target)) {
    mode = fs.statSync(target).mode & 0o777;
    const backup = `${SETTINGS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(target, backup);
    console.log(`  Backed up settings to ${backup}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

function getEntries(settings, event) {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    fail(`ERROR: "hooks" in ${SETTINGS_PATH} is not an object. Nothing was changed.`);
  }
  if (hooks[event] === undefined) return [];
  if (!Array.isArray(hooks[event])) {
    fail(`ERROR: "hooks.${event}" in ${SETTINGS_PATH} is not an array. Nothing was changed.`);
  }
  return hooks[event];
}

function findOurs(entries, file) {
  for (const entry of entries) {
    const hook = entry && Array.isArray(entry.hooks) && entry.hooks.find(h => ourHook(h, file));
    if (hook) return hook;
  }
  return null;
}

// Remove our hooks from an event. Other hooks, even in the same entry, are kept.
// Returns how many were removed.
function stripOurs(settings, event, file) {
  const entries = getEntries(settings, event);
  const kept = [];
  let removed = 0;
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
    const rest = entry.hooks.filter(h => !ourHook(h, file));
    removed += entry.hooks.length - rest.length;
    if (rest.length === entry.hooks.length) kept.push(entry);
    else if (rest.length) kept.push({ ...entry, hooks: rest });
  }
  if (removed > 0) {
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  return removed;
}

function findClaude() {
  try {
    return execSync(WIN ? 'where claude' : 'which claude', {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

// --- Commands ---

function install() {
  // Verify hook scripts exist
  for (const def of HOOK_DEFS) {
    if (!fs.existsSync(def.script)) {
      console.error(`ERROR: Hook script not found: ${def.script}`);
      console.error('Make sure you are running setup.js from the claude-evolve directory.');
      process.exit(1);
    }
  }

  if (!findClaude()) {
    console.warn('WARNING: claude CLI not found in PATH. Hooks will not work without it.');
    console.warn('Install Claude Code: https://claude.com/claude-code');
  }

  const settings = readSettings();
  let changed = 0;

  for (const def of HOOK_DEFS) {
    const command = hookCommand(def.script);
    const existing = findOurs(getEntries(settings, def.event), def.file);
    let did = false;

    if (existing) {
      if (existing.command !== command || existing.timeout !== def.timeout) {
        existing.command = command;
        existing.timeout = def.timeout;
        console.log(`  Updated ${def.event} hook`);
        did = true;
      }
    } else {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks[def.event]) settings.hooks[def.event] = [];
      settings.hooks[def.event].push({
        matcher: '',
        hooks: [{ type: 'command', command, timeout: def.timeout }],
      });
      console.log(`  Added ${def.event} hook`);
      did = true;
    }

    for (const legacy of def.legacy || []) {
      if (stripOurs(settings, legacy, def.file) > 0) {
        console.log(`  Moved ${def.file} from ${legacy} to ${def.event}`);
        did = true;
      }
    }

    if (did) changed++;
    else console.log(`  ${def.event} hook already installed ✓`);
  }

  if (changed > 0) {
    writeSettings(settings);
    console.log(`\nUpdated ${SETTINGS_PATH}`);
  } else {
    console.log('\nAll hooks already installed. No changes made.');
  }

  // Create data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('\nclaude-evolve is ready. Start a Claude Code session to begin learning.\n');
  console.log('Verify with: node setup.js --check');
}

function check() {
  const settings = readSettings();
  let ok = true;

  console.log('Checking claude-evolve installation:\n');

  for (const def of HOOK_DEFS) {
    const found = findOurs(getEntries(settings, def.event), def.file);
    if (found) {
      const script = hookScript(found.command);
      if (script && fs.existsSync(script)) {
        console.log(`  ✓ ${def.event} → ${found.command}`);
      } else {
        console.log(`  ✗ ${def.event} → ${found.command} (SCRIPT NOT FOUND)`);
        ok = false;
      }
    } else {
      console.log(`  ✗ ${def.event} — not installed`);
      ok = false;
    }

    for (const legacy of def.legacy || []) {
      const old = findOurs(getEntries(settings, legacy), def.file);
      if (old) {
        console.log(`  ! ${def.file} is still registered on ${legacy} (${old.command}).`);
        console.log(`    ${legacy} runs after every response. Run \`node setup.js\` to move it to ${def.event}.`);
        ok = false;
      }
    }
  }

  const claudePath = findClaude();
  if (claudePath) {
    console.log(`  ✓ claude CLI → ${claudePath}`);
  } else {
    console.log('  ✗ claude CLI — not found in PATH');
    ok = false;
  }

  const nodeVersion = process.version;
  if (parseInt(nodeVersion.slice(1)) >= 18) {
    console.log(`  ✓ Node.js ${nodeVersion}`);
  } else {
    console.log(`  ✗ Node.js ${nodeVersion} (requires >= 18)`);
    ok = false;
  }

  console.log(ok ? '\nAll checks passed. ✓' : '\nSome checks failed. Run `node setup.js` to fix.');
  process.exit(ok ? 0 : 1);
}

function remove() {
  const settings = readSettings();
  let removed = 0;

  for (const event of SCAN_EVENTS) {
    const n = stripOurs(settings, event);
    if (n > 0) {
      console.log(`  Removed ${n} ${event} hook${n > 1 ? 's' : ''}`);
      removed += n;
    }
  }

  if (removed > 0) {
    writeSettings(settings);
    console.log(`\nRemoved ${removed} hook(s) from ${SETTINGS_PATH}`);
  } else {
    console.log('No claude-evolve hooks found. Nothing to remove.');
  }
}

function cleanStale(yes) {
  const cleaner = require('./learning/cleanStale');
  if (!yes) {
    const result = cleaner.plan();
    console.log('claude-evolve --clean-stale (dry run, nothing is written)\n');
    console.log(result.items.length ? cleaner.formatPlan(result) : 'No misplaced rule blocks found.');
    if (result.items.length) console.log('\nRun `node setup.js --clean-stale --yes` to apply. Every touched file is backed up first.');
    return;
  }
  const { backupDir, done, skipped, result } = cleaner.apply();
  console.log(cleaner.formatPlan(result));
  console.log(`\nApplied ${done.length} change(s). Backup: ${backupDir}`);
  for (const s of skipped) console.log(`  Skipped ${s.path}: ${s.error}`);
  if (skipped.length) process.exitCode = 1;
}

// --- CLI ---

const COMMANDS = {
  '--check': check, check,
  '--remove': remove, '--uninstall': remove, uninstall: remove,
};
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
} else if (args.length === 0) {
  install();
} else if (args.length === 1 && Object.hasOwn(COMMANDS, args[0])) {
  COMMANDS[args[0]]();
} else if (args[0] === '--clean-stale' && (args.length === 1 || (args.length === 2 && args[1] === '--yes'))) {
  cleanStale(args[1] === '--yes');
} else {
  console.error(`Unknown option: ${args.join(' ')}\n\n${USAGE}`);
  process.exit(1);
}
