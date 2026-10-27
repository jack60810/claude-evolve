#!/usr/bin/env node
// session-end.js — SessionEnd hook (runs once per session)
// 1. Claims this session's observation file by renaming it to <file>.processing
// 2. Aggregates tool usage, updates the user profile, appends to session_log.jsonl
// 3. For non-trivial sessions in a project root: writes DATA_DIR/pending_<sessionId>.json and
//    spawns the background processor (processRules.js), the single writer of rules,
//    CLAUDE.md and skills. This file never touches any of those.
//
// `node session-end.js --sweep <claimedFile>` runs steps 2-3 on a file that session-start
// claimed from a session that never fired SessionEnd.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LEARNING_ROOT = path.join(__dirname, '..');
const { DATA_DIR, CHILD_ENV, resolveProjectRoot } = require(path.join(LEARNING_ROOT, 'paths'));
const { writeJsonAtomic, appendBounded } = require(path.join(LEARNING_ROOT, 'fsutil'));
const { redact } = require(path.join(LEARNING_ROOT, 'redact'));
const sessionMemory = require(path.join(LEARNING_ROOT, 'sessionMemory'));

const PROFILE_PATH = path.join(DATA_DIR, 'user_profile.json');
const SESSION_LOG_PATH = path.join(DATA_DIR, 'session_log.jsonl');
const PROCESS_LOG = path.join(DATA_DIR, 'process.log');
const ERROR_LOG = path.join(DATA_DIR, 'hook_errors.log');
const PROCESS_SCRIPT = path.join(LEARNING_ROOT, 'processRules.js');
const MAX_LOG_BYTES = 1024 * 1024;

function logError(where, err) {
  try { appendBounded(ERROR_LOG, `${new Date().toISOString()} [session-end ${where}] ${err && err.stack || err}`); } catch {}
}

// ===================== Tool aggregation =====================

function aggregateSession(records) {
  const tools = {};
  const dbQueries = [];
  const mcpQueries = [];
  for (const r of records) {
    tools[r.tool] = (tools[r.tool] || 0) + 1;
    if (r.type === 'database_query') {
      dbQueries.push({ tables: r.tables || [], isDryRun: r.isDryRun || false, bytesScanned: r.bytesScanned || null });
    }
    if (r.type === 'mcp_action') {
      mcpQueries.push({ tool: r.mcpTool || r.tool });
    }
  }
  return { tools, dbQueries, mcpQueries };
}

// ===================== Behavior observation helpers =====================

/**
 * Build session behavior from already-parsed records.
 */
function buildSessionBehaviorFromRecords(records) {
  const summary = {
    toolCalls: 0,
    toolSequence: [],
    toolCounts: {},
    dbTables: [],
    dbDryRuns: 0,
    mcpTools: [],
    mcpActionCount: 0,
    workflowPhases: [],
  };

  if (!records || records.length === 0) return summary;

  summary.toolCalls = records.length;

  for (const r of records) {
    const tool = r.tool || 'unknown';
    summary.toolSequence.push(tool);
    summary.toolCounts[tool] = (summary.toolCounts[tool] || 0) + 1;

    if (r.type === 'database_query') {
      for (const t of (r.tables || [])) {
        if (!summary.dbTables.includes(t)) summary.dbTables.push(t);
      }
      if (r.isDryRun) summary.dbDryRuns++;
    }
    if (r.type === 'mcp_action') {
      const mcpTool = r.mcpTool || r.tool;
      if (!summary.mcpTools.includes(mcpTool)) summary.mcpTools.push(mcpTool);
      summary.mcpActionCount++;
    }
  }

  // Detect workflow phases from tool sequence
  summary.workflowPhases = detectWorkflowPhases(summary.toolSequence);

  // Classify project type from tool patterns
  const analyzer = require(path.join(LEARNING_ROOT, 'analyzer'));
  summary.projectType = analyzer.classifyProjectType(summary);

  return summary;
}

/**
 * Classify tool sequence into high-level workflow phases.
 * e.g., [Read, Read, Bash, Edit, Bash] → ['explore', 'execute', 'modify', 'test']
 */
function detectWorkflowPhases(sequence) {
  const phases = [];
  const phaseMap = {
    'Read': 'explore', 'Glob': 'explore', 'Grep': 'explore',
    'Bash': 'execute', 'Edit': 'modify', 'Write': 'modify',
    'TaskCreate': 'plan', 'TaskUpdate': 'plan',
  };

  let lastPhase = null;
  for (const tool of sequence) {
    // Handle MCP tools
    let phase;
    // Check specific MCP tools first (longer prefixes), then generic mcp__
    if (tool.includes('slack')) phase = 'communicate';
    else if (tool.includes('Notion') || tool.includes('notion')) phase = 'document';
    else if (tool.startsWith('mcp__')) phase = 'integrate';
    else phase = phaseMap[tool] || 'other';

    if (phase !== lastPhase) {
      phases.push(phase);
      lastPhase = phase;
    }
  }

  return phases;
}

/**
 * Read recent session logs of this project root for cross-session pattern comparison.
 * Entries written before roots were logged match on the project's basename.
 */
function readRecentSessionLogs(projectRoot, maxSessions) {
  try {
    const lines = fs.readFileSync(SESSION_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const projectName = path.basename(projectRoot);
    const projectSessions = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.root === projectRoot || (!entry.root && entry.project === projectName)) {
          projectSessions.push(entry);
        }
      } catch {}
    }
    return projectSessions.slice(-(maxSessions || 10));
  } catch { return []; }
}

// ===================== Pending data + background processor =====================

function spawnProcessor(pendingFile, projectRoot) {
  try {
    if (fs.statSync(PROCESS_LOG).size > MAX_LOG_BYTES) fs.renameSync(PROCESS_LOG, `${PROCESS_LOG}.1`);
  } catch {}
  const logFd = fs.openSync(PROCESS_LOG, 'a');
  try {
    const child = spawn(process.execPath, [PROCESS_SCRIPT, pendingFile], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: projectRoot,
      env: { ...process.env, [CHILD_ENV]: '1' },
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

/**
 * Process one claimed observation file. Returns a short summary for session_log.jsonl.
 */
function processSession(claimedFile, payload) {
  const records = sessionMemory.readObservations(claimedFile);
  const { header, observations } = sessionMemory.splitObservations(records);
  const sessionId = (header && header.sessionId) || payload.session_id ||
    path.basename(claimedFile).replace(sessionMemory.OBS_PREFIX, '').replace(/\.jsonl\.processing$/, '');
  const cwd = (header && header.cwd) || payload.cwd || process.cwd();
  // Start time comes from the session record; without one, the first observation is the best bound
  const sessionStartMs = (header && Number.isFinite(header.startMs)) ? header.startMs
    : observations.length > 0 ? observations[0].ts : Date.now();
  const { root } = resolveProjectRoot(cwd);
  const sessionBehavior = buildSessionBehaviorFromRecords(observations);

  const logEntry = { sessionId, root, tool_calls: observations.length };

  if (observations.length > 0) {
    const sessionData = aggregateSession(observations);
    sessionData.cwd = root || cwd;

    const analyzer = require(path.join(LEARNING_ROOT, 'analyzer'));
    const analysis = analyzer.analyzeSession(sessionData);
    try { analyzer.updateProfile(PROFILE_PATH, analysis); } catch (err) { logError('profile', err); }

    Object.assign(logEntry, {
      project: analysis.patterns.project || 'unknown',
      signals: analysis.signals,
      db_queries: sessionData.dbQueries.length,
      mcp_queries: sessionData.mcpQueries.length,
      top_tools: Object.entries(sessionData.tools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t, c]) => `${t}:${c}`),
      project_type: sessionBehavior.projectType || 'general',
    });
  }

  if (!root) return { ...logEntry, learning: 'skipped: no project root' };

  const memoryReader = require(path.join(LEARNING_ROOT, 'memoryReader'));
  const newMemories = memoryReader.getNewFeedbackMemories(cwd, sessionStartMs).map(m => ({
    ...m, name: redact(m.name), description: redact(m.description), content: redact(m.content),
  }));
  logEntry.memories = newMemories.length;

  // Trivial session: nothing to learn, nothing spawned
  if (newMemories.length === 0 && sessionBehavior.toolCalls < 5 && observations.length < 3) {
    return { ...logEntry, learning: 'skipped: trivial session' };
  }

  // Read recent sessions before this one is logged
  const recentSessions = readRecentSessionLogs(root, 10);
  const pendingFile = path.join(DATA_DIR, `pending_${sessionMemory.sessionKey({ session_id: sessionId })}.json`);
  writeJsonAtomic(pendingFile, {
    project: root,
    cwd,
    sessionId,
    sessionStartMs,
    timestamp: new Date().toISOString(),
    newMemories,
    observations,
    sessionBehavior,
    projectType: sessionBehavior.projectType || 'general',
    recentSessions,
  });
  const pid = spawnProcessor(pendingFile, root);
  return { ...logEntry, learning: `processing (pid ${pid})` };
}

function run(claimedFile, payload) {
  try {
    const entry = processSession(claimedFile, payload);
    appendBounded(SESSION_LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  } catch (err) {
    logError('process', err);
  } finally {
    try { fs.unlinkSync(claimedFile); } catch {}
  }
}

// ===================== Main =====================

function main() {
  const sweepAt = process.argv.indexOf('--sweep');
  if (sweepAt !== -1) {
    // Spawned by session-start for an abandoned session (already claimed). Runs even though
    // CLAUDE_EVOLVE_CHILD is set: that guard is for hook invocations only.
    if (process.argv[sweepAt + 1]) run(process.argv[sweepAt + 1], {});
    return;
  }

  // Child of the processor (its own `claude` calls): nothing to record.
  if (process.env[CHILD_ENV] === '1') return;

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const payload = input.trim() ? JSON.parse(input) : {};
      // Still registered as a Stop hook by an older setup.js: Stop fires every turn, and
      // processing runs once per session. The session-start sweep covers such installs.
      if (payload.hook_event_name && payload.hook_event_name !== 'SessionEnd') return;
      const file = sessionMemory.observationFile(sessionMemory.sessionKey(payload));
      const claimedFile = `${file}.processing`;
      try {
        fs.renameSync(file, claimedFile); // whoever renames first owns the file
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return; // no observations for this session, or a sweep already claimed them
      }
      run(claimedFile, payload);
    } catch (err) {
      logError('main', err);
    }
  });

  // Safety net if stdin never closes. unref: it never keeps a finished hook alive.
  setTimeout(() => process.exit(0), 7000).unref();
}

main();
