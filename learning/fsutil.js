// fsutil.js — Safe file I/O for data that several Claude Code sessions share.
//
// writeFileAtomic: unique temp name + rename, so concurrent writers never collide on one
//   .tmp file and a crash never leaves a half-written target. Writes through symlinks.
// readJson: a missing file returns the fallback. A corrupt file throws, so a caller can
//   never load "empty" and then save that emptiness over real data.
// withLock: a cross-process lock (O_EXCL lockfile) around a synchronous read-modify-write.
//   Never hold it across an LLM call: do the slow work first, then reload and apply
//   the change inside the lock.

const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, data) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : fallback;
    throw e;
  }
  return JSON.parse(raw);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(file, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.unlinkSync(lock); continue; }
      } catch {}
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      sleepSync(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

// Append to a log file. When it passes maxBytes, the file moves to <file>.1 (replacing the
// previous .1), so each log keeps at most about 2 × maxBytes on disk.
function appendBounded(file, text, maxBytes = 1024 * 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch {}
  fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
}

module.exports = { writeFileAtomic, writeJsonAtomic, readJson, withLock, appendBounded };
