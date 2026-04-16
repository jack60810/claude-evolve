#!/usr/bin/env node
// exploration.js — Idle exploration: proactively scans projects for learning opportunities.
// Can run as a standalone script (cron/manual) or be called from the daemon loop.
//
// What it does:
//   1. Checks if CLAUDE.md rules match actual recent behavior (drift detection)
//   2. Scans git log for new patterns worth learning
//   3. Detects stale rules that haven't been evaluated in a while
//   4. Outputs findings to data/exploration.jsonl

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LEARNING_ROOT = path.join(__dirname);
const DATA_DIR = path.join(LEARNING_ROOT, 'data');
const EXPLORATION_LOG = path.join(DATA_DIR, 'exploration.jsonl');
const NARRATIVE_LOG = path.join(DATA_DIR, 'narrative.jsonl');

function log(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(EXPLORATION_LOG, line, 'utf8');
}

/**
 * Detect stale rules — active rules not evaluated in 14+ days.
 */
function findStaleRules(project) {
  const ruleEngine = require('./ruleEngine');
  const active = ruleEngine.getActiveRules(project);
  const now = Date.now();
  const staleThreshold = 14 * 24 * 60 * 60 * 1000; // 14 days

  return active.filter(r => {
    const lastEval = r.last_evaluated ? new Date(r.last_evaluated).getTime() : 0;
    return (now - lastEval) > staleThreshold;
  });
}

/**
 * Check git log for recent commit patterns.
 * Returns a summary of recent work themes.
 */
function getRecentGitActivity(projectPath, days) {
  try {
    const since = `${days || 7} days ago`;
    const log = execSync(
      `git log --since="${since}" --oneline --no-merges -20`,
      { cwd: projectPath, encoding: 'utf8', timeout: 10000 }
    ).trim();
    return log || '(no recent commits)';
  } catch {
    return '(not a git repo or git error)';
  }
}

/**
 * Compare active rules against recent session narratives to detect drift.
 * Drift = rules say one thing but actual behavior shows another.
 */
function detectDrift(project) {
  const ruleEngine = require('./ruleEngine');
  const active = ruleEngine.getActiveRules(project);
  if (active.length === 0) return [];

  // Read recent narratives
  let narratives = [];
  try {
    const lines = fs.readFileSync(NARRATIVE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    narratives = lines.slice(-10).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}

  if (narratives.length < 3) return []; // Not enough data

  const llmBrain = require('./llmBrain');
  const rulesDesc = active.map(r => `- [${r.id}] ${r.content.slice(0, 100)}`).join('\n');
  const narrativeDesc = narratives.map(n => `${n.timestamp ? n.timestamp.slice(0, 10) : '?'}: ${n.narrative}`).join('\n');

  const result = llmBrain.askClaude(`Drift detector. Compare rules vs actual behavior from session narratives.

ACTIVE RULES:
${rulesDesc}

RECENT SESSION NARRATIVES:
${narrativeDesc}

Does any rule NOT match what the user actually does? Is there behavior in narratives that should be a rule but isn't?

Reply JSON:
{"drifts": [{"type": "rule_ignored|missing_rule|outdated_rule", "detail": "<what's wrong>", "rule_id": "<if applicable, empty otherwise>"}]}

No drift? Reply: {"drifts": []}`, 25000);

  return (result && result.drifts) ? result.drifts : [];
}

/**
 * Run a full exploration cycle for a project.
 */
function explore(projectPath) {
  const findings = {
    project: projectPath,
    staleRules: [],
    gitThemes: '',
    drifts: [],
  };

  // 1. Stale rules
  findings.staleRules = findStaleRules(projectPath).map(r => ({
    id: r.id, content: r.content.slice(0, 100),
    last_evaluated: r.last_evaluated, fitness: r.fitness,
  }));

  // 2. Git activity
  findings.gitThemes = getRecentGitActivity(projectPath, 7);

  // 3. Drift detection (only if we have narrative history)
  findings.drifts = detectDrift(projectPath);

  // Log findings
  log({
    action: 'exploration_complete',
    project: projectPath,
    stale_rules: findings.staleRules.length,
    drifts: findings.drifts.length,
    has_git: findings.gitThemes !== '(not a git repo or git error)',
  });

  return findings;
}

// CLI entry point
if (require.main === module) {
  const projectPath = process.argv[2] || process.cwd();
  console.log(`[Exploration] Scanning ${projectPath}...`);

  const findings = explore(projectPath);

  if (findings.staleRules.length > 0) {
    console.log(`\n[Stale Rules] ${findings.staleRules.length} rules not evaluated in 14+ days:`);
    for (const r of findings.staleRules) {
      console.log(`  ${r.id}: ${r.content} (fitness=${r.fitness}, last=${r.last_evaluated})`);
    }
  }

  if (findings.drifts.length > 0) {
    console.log(`\n[Drift Detected] ${findings.drifts.length} issues:`);
    for (const d of findings.drifts) {
      console.log(`  [${d.type}] ${d.detail}`);
    }
  }

  if (findings.gitThemes && findings.gitThemes !== '(not a git repo or git error)') {
    console.log(`\n[Git Activity]\n${findings.gitThemes}`);
  }

  if (findings.staleRules.length === 0 && findings.drifts.length === 0) {
    console.log('\n[OK] No issues found.');
  }
}

module.exports = { explore, findStaleRules, getRecentGitActivity, detectDrift };
