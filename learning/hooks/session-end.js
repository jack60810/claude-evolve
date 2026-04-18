#!/usr/bin/env node
// session-end.js — Stop hook
// 1. Aggregates session tool usage, runs analyzer, updates profile (existing)
// 2. Saves pending rule learning data + spawns background LLM processor

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const LEARNING_ROOT = path.join(__dirname, '..');
const ANALYZER_PATH = path.join(LEARNING_ROOT, 'analyzer.js');
const PROFILE_PATH = path.join(LEARNING_ROOT, 'data', 'user_profile.json');
const SESSION_LOG_PATH = path.join(LEARNING_ROOT, 'data', 'session_log.jsonl');
const PENDING_PATH = path.join(LEARNING_ROOT, 'data', 'pending.json');
const PROCESS_SCRIPT = path.join(LEARNING_ROOT, 'processRules.js');

// ===================== Tool aggregation (existing) =====================

function findSessionTempFile() {
  const prefix = `claude-learning-${process.ppid || 'unknown'}`;
  const tmpDir = os.tmpdir();
  try {
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('claude-learning-') && f.endsWith('.jsonl'))
      .map(f => path.join(tmpDir, f))
      .sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; }
        catch { return 0; }
      });
    const exact = files.find(f => path.basename(f).startsWith(prefix));
    if (exact) return exact;
    if (files.length > 0) return files[0];
  } catch {}
  return null;
}


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

function cleanupTempFiles() {
  const tmpDir = os.tmpdir();
  try {
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('claude-learning-') && f.endsWith('.jsonl'));
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(tmpDir, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
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
    }
    if (r.type === 'mcp_action') summary.mcpActionCount++;
    if (r.type === 'mcp_action') ;
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
 * Read recent session logs for cross-session pattern comparison.
 */
function readRecentSessionLogs(projectPath, maxSessions) {
  try {
    const lines = fs.readFileSync(SESSION_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const projectName = path.basename(projectPath);

    // Filter to this project's sessions, take last N
    const projectSessions = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.project === projectName || entry.project === projectPath) {
          projectSessions.push(entry);
        }
      } catch {}
    }

    return projectSessions.slice(-(maxSessions || 10));
  } catch { return []; }
}

// ===================== Rule learning: save pending + spawn background =====================

function savePendingAndSpawn(projectPath, tempFile, preReadRecords) {
  try {
    const memoryReader = require(path.join(LEARNING_ROOT, 'memoryReader'));
    const claudeMdWriter = require(path.join(LEARNING_ROOT, 'claudeMdWriter'));
    const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));

    // Determine session start time
    let sessionStartTime;
    if (tempFile) {
      try { sessionStartTime = fs.statSync(tempFile).ctimeMs; }
      catch { sessionStartTime = memoryReader.getSessionStartTime(); }
    } else {
      sessionStartTime = memoryReader.getSessionStartTime();
    }

    // Use pre-read records (already parsed once in main flow)
    const observations = preReadRecords || [];

    // Read new feedback memories
    const newMemories = memoryReader.getNewFeedbackMemories(projectPath, sessionStartTime);

    // Build session behavior summary from already-parsed observations
    const sessionBehavior = buildSessionBehaviorFromRecords(observations);

    // Read past session logs for cross-session pattern detection
    const recentSessions = readRecentSessionLogs(projectPath, 10);

    const hasMemories = newMemories.length > 0;
    const hasSignificantBehavior = sessionBehavior.toolCalls >= 5;
    const hasObservations = observations.length >= 3;

    if (!hasMemories && !hasSignificantBehavior && !hasObservations) {
      // No new memories and trivial session — just update fitness
      const activeRules = ruleEngine.getActiveRules(projectPath);
      if (activeRules.length > 0) {
        ruleEngine.evaluateFitness(projectPath, [], new Set());
        const updated = ruleEngine.getActiveRules(projectPath);
        claudeMdWriter.writeRulesToClaudeMd(projectPath, updated);
      }
      return { spawned: false, reason: 'no_new_data' };
    }

    // Read hand-written content
    const { content: claudeMdContent } = claudeMdWriter.readClaudeMd(projectPath);
    const handWrittenContent = claudeMdWriter.getHandWrittenContent(claudeMdContent);

    // Get existing active rules
    const existingActiveRules = ruleEngine.getActiveRules(projectPath);

    // Save pending data for background processor (now includes full observations)
    const pending = {
      project: projectPath,
      timestamp: new Date().toISOString(),
      newMemories,
      observations,
      sessionBehavior,
      projectType: sessionBehavior.projectType || 'general',
      recentSessions,
      existingActiveRules,
      handWrittenContent,
    };

    // Use session-specific pending file to avoid concurrent session clobber
    const sessionId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
    const pendingFile = path.join(path.dirname(PENDING_PATH), `pending_${sessionId}.json`);
    fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
    const tmp = pendingFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pending, null, 2), 'utf8');
    fs.renameSync(tmp, pendingFile);

    // Spawn background processor with the specific pending file
    const logPath = path.join(LEARNING_ROOT, 'data', 'process.log');
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [PROCESS_SCRIPT, pendingFile], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: projectPath,
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(logFd);

    return { spawned: true, memories: newMemories.length, observations: observations.length, pid: child.pid };
  } catch (err) {
    try {
      fs.mkdirSync(path.join(LEARNING_ROOT, 'data'), { recursive: true });
      fs.appendFileSync(
        path.join(LEARNING_ROOT, 'data', 'rule_errors.log'),
        new Date().toISOString() + ' [session-end] ' + (err.stack || err.message || err) + '\n',
        'utf8'
      );
    } catch {}
    return { spawned: false, error: err.message };
  }
}

// ===================== Main =====================

function main() {
  let input = '';
  let handled = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    if (handled) return;
    handled = true;

    try {
      // Guard: skip if this is a child process spawned by llmBrain
      if (process.env.EVOLVER_CHILD === '1') {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      // --- Read temp file ONCE, reuse everywhere ---
      const tempFile = findSessionTempFile();
      const sessionMemoryMod = require(path.join(LEARNING_ROOT, 'sessionMemory'));
      const records = sessionMemoryMod.readObservations(tempFile);

      if (records.length > 0) {
        const sessionData = aggregateSession(records);
        sessionData.cwd = process.cwd();

        const analyzer = require(ANALYZER_PATH);
        const analysis = analyzer.analyzeSession(sessionData);
        analyzer.updateProfile(PROFILE_PATH, analysis);

        // Classify project type for the session log
        const sessionBehaviorForLog = buildSessionBehaviorFromRecords(records);

        const logEntry = {
          timestamp: new Date().toISOString(),
          project: analysis.patterns.project || 'unknown',
          tool_calls: analysis.totalToolCalls,
          signals: analysis.signals,
          matched_genes: (analysis.matched || []).map(m => m.gene),
          db_queries: sessionData.dbQueries.length,
          mcp_queries: sessionData.mcpQueries.length,
          top_tools: Object.entries(sessionData.tools)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([t, c]) => `${t}:${c}`),
          project_type: sessionBehaviorForLog.projectType || 'general',
        };

        fs.mkdirSync(path.dirname(SESSION_LOG_PATH), { recursive: true });
        fs.appendFileSync(SESSION_LOG_PATH, JSON.stringify(logEntry) + '\n', 'utf8');
      }

      // --- NEW: Save pending data + spawn LLM background processor ---
      const projectPath = process.cwd();
      const spawnResult = savePendingAndSpawn(projectPath, tempFile, records);

      // Cleanup
      cleanupTempFiles();
      if (tempFile) {
        try { fs.unlinkSync(tempFile); } catch {}
      }

      // Output
      const parts = [];
      if (records.length > 0) parts.push(`tools=${records.length}`);
      if (spawnResult.spawned) {
        parts.push(`learning=processing(${spawnResult.memories} memories, ${spawnResult.observations || 0} obs)`);
      }

      const msg = parts.length > 0
        ? `[Learning] Session recorded: ${parts.join(', ')}`
        : '';

      process.stdout.write(JSON.stringify(msg ? { additionalContext: msg } : {}));
    } catch (e) {
      try {
        fs.mkdirSync(path.join(LEARNING_ROOT, 'data'), { recursive: true });
        fs.appendFileSync(
          path.join(LEARNING_ROOT, 'data', 'rule_errors.log'),
          new Date().toISOString() + ' [session-end main] ' + (e.stack || e.message || e) + '\n',
          'utf8'
        );
      } catch {}
      process.stdout.write(JSON.stringify({}));
    }
  });

  setTimeout(() => {
    if (handled) return;
    handled = true;
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }, 7000);
}

main();
