// paths.js — Shared locations: the data directory and the project a session belongs to.
//
// DATA_DIR defaults to learning/data. Set CLAUDE_EVOLVE_DATA_DIR to point the whole
// system (hooks, processor, tests, demo) at another directory.
//
// resolveProjectRoot(cwd) picks the folder whose rules file a session writes. Inside a git
// repo that is the repo's top level, so subfolders share one set of rules. Outside git it is
// the launch folder itself. Home and its ancestors never get rules, and neither does a folder
// that holds a .claude-evolve-ignore file (the opt-out for container folders, such as a
// directory of unrelated repos).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.CLAUDE_EVOLVE_DATA_DIR
  ? path.resolve(process.env.CLAUDE_EVOLVE_DATA_DIR)
  : path.join(__dirname, 'data');

// Set on every `claude` child process the processor spawns. Hooks that see it exit at once,
// so the processor's own LLM calls never record observations or spawn another processor.
const CHILD_ENV = 'CLAUDE_EVOLVE_CHILD';

const IGNORE_FILE = '.claude-evolve-ignore';

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isSameOrAncestor(dir, target) {
  return target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * Resolve the project root for a working directory.
 * Returns { root, reason }. root is null when rules must not be written anywhere.
 */
function resolveProjectRoot(cwd) {
  if (!cwd) return { root: null, reason: 'no-cwd' };
  const real = realpathOr(cwd);
  if (!fs.existsSync(real)) return { root: null, reason: 'missing' };

  let root = real;
  try {
    const top = execFileSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) root = realpathOr(top);
  } catch {}

  const home = realpathOr(os.homedir());
  if (isSameOrAncestor(root, home)) return { root: null, reason: 'home-or-ancestor' };
  if (fs.existsSync(path.join(root, IGNORE_FILE))) return { root: null, reason: 'ignored' };

  return { root, reason: null };
}

module.exports = { DATA_DIR, CHILD_ENV, IGNORE_FILE, resolveProjectRoot, realpathOr };
