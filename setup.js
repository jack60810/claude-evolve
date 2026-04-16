#!/usr/bin/env node
// setup.js — Install or uninstall claude-evolve hooks into Claude Code settings.
//
// Usage:
//   node setup.js           # Install hooks
//   node setup.js --check   # Check if hooks are installed
//   node setup.js --remove  # Uninstall hooks

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const LEARNING_DIR = path.join(__dirname, 'learning');
const HOOKS_DIR = path.join(LEARNING_DIR, 'hooks');

const HOOK_DEFS = [
  {
    event: 'SessionStart',
    script: path.join(HOOKS_DIR, 'session-start.js'),
    timeout: 3,
  },
  {
    event: 'PostToolUse',
    script: path.join(HOOKS_DIR, 'post-tool.js'),
    timeout: 2,
  },
  {
    event: 'Stop',
    script: path.join(HOOKS_DIR, 'session-end.js'),
    timeout: 8,
  },
];

// Marker to identify our hooks
const MARKER = 'claude-evolve';

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function isOurHook(hookEntry) {
  return hookEntry && hookEntry.command && hookEntry.command.includes(MARKER);
}

function install() {
  // Verify hook scripts exist
  for (const def of HOOK_DEFS) {
    if (!fs.existsSync(def.script)) {
      console.error(`ERROR: Hook script not found: ${def.script}`);
      console.error('Make sure you are running setup.js from the claude-evolve directory.');
      process.exit(1);
    }
  }

  // Verify claude CLI is available
  try {
    require('child_process').execSync('which claude', { encoding: 'utf8', timeout: 3000 });
  } catch {
    console.warn('WARNING: claude CLI not found in PATH. Hooks will not work without it.');
    console.warn('Install Claude Code: https://claude.com/claude-code');
  }

  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  let skipped = 0;

  for (const def of HOOK_DEFS) {
    if (!settings.hooks[def.event]) {
      settings.hooks[def.event] = [];
    }

    // Check if our hook is already installed
    const existing = settings.hooks[def.event].find(entry =>
      entry.hooks && entry.hooks.some(h => isOurHook(h))
    );

    if (existing) {
      // Update the path in case it changed
      const hook = existing.hooks.find(h => isOurHook(h));
      const newCommand = `node ${def.script}`;
      if (hook.command !== newCommand) {
        hook.command = newCommand;
        hook.timeout = def.timeout;
        console.log(`  Updated ${def.event} hook path`);
        added++;
      } else {
        console.log(`  ${def.event} hook already installed ✓`);
        skipped++;
      }
      continue;
    }

    // Add new hook entry
    settings.hooks[def.event].push({
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: `node ${def.script}`,
          timeout: def.timeout,
        },
      ],
    });
    console.log(`  Added ${def.event} hook`);
    added++;
  }

  if (added > 0) {
    writeSettings(settings);
    console.log(`\nInstalled ${added} hook(s) to ${SETTINGS_PATH}`);
  } else {
    console.log('\nAll hooks already installed. No changes made.');
  }

  // Create data directory
  fs.mkdirSync(path.join(LEARNING_DIR, 'data'), { recursive: true });

  console.log('\nclaude-evolve is ready. Start a Claude Code session to begin learning.\n');
  console.log('Verify with: node setup.js --check');
}

function check() {
  const settings = readSettings();
  const hooks = settings.hooks || {};
  let ok = true;

  console.log('Checking claude-evolve installation:\n');

  for (const def of HOOK_DEFS) {
    const entries = hooks[def.event] || [];
    const found = entries.find(entry =>
      entry.hooks && entry.hooks.some(h => isOurHook(h))
    );

    if (found) {
      const hook = found.hooks.find(h => isOurHook(h));
      const scriptExists = fs.existsSync(def.script);
      if (scriptExists) {
        console.log(`  ✓ ${def.event} → ${hook.command}`);
      } else {
        console.log(`  ✗ ${def.event} → ${hook.command} (SCRIPT NOT FOUND)`);
        ok = false;
      }
    } else {
      console.log(`  ✗ ${def.event} — not installed`);
      ok = false;
    }
  }

  // Check claude CLI
  try {
    const claudePath = require('child_process').execSync('which claude', { encoding: 'utf8', timeout: 3000 }).trim();
    console.log(`  ✓ claude CLI → ${claudePath}`);
  } catch {
    console.log('  ✗ claude CLI — not found in PATH');
    ok = false;
  }

  // Check Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1));
  if (major >= 18) {
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
  if (!settings.hooks) {
    console.log('No hooks found. Nothing to remove.');
    return;
  }

  let removed = 0;

  for (const def of HOOK_DEFS) {
    if (!settings.hooks[def.event]) continue;

    const before = settings.hooks[def.event].length;
    settings.hooks[def.event] = settings.hooks[def.event].filter(entry =>
      !(entry.hooks && entry.hooks.some(h => isOurHook(h)))
    );
    const after = settings.hooks[def.event].length;

    if (before > after) {
      console.log(`  Removed ${def.event} hook`);
      removed++;
    }

    // Clean up empty arrays
    if (settings.hooks[def.event].length === 0) {
      delete settings.hooks[def.event];
    }
  }

  if (removed > 0) {
    writeSettings(settings);
    console.log(`\nRemoved ${removed} hook(s) from ${SETTINGS_PATH}`);
  } else {
    console.log('No claude-evolve hooks found. Nothing to remove.');
  }
}

// --- CLI ---

const args = process.argv.slice(2);

if (args.includes('--check') || args.includes('check')) {
  check();
} else if (args.includes('--remove') || args.includes('uninstall') || args.includes('--uninstall')) {
  remove();
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`claude-evolve setup

Usage:
  node setup.js           Install hooks into Claude Code settings
  node setup.js --check   Verify installation
  node setup.js --remove  Uninstall hooks
  node setup.js --help    Show this help`);
} else {
  install();
}
