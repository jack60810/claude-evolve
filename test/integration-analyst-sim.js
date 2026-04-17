#!/usr/bin/env node
// integration-analyst-sim.js — Simulate multiple analysts doing different analysis tasks
// Uses Claude (sonnet) to generate realistic session observations, then runs them
// through the full pipeline to test if skills emerge naturally.
//
// Run: node test/integration-analyst-sim.js
// Requires: claude CLI installed, ~10 LLM calls total

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const LEARNING_ROOT = path.join(__dirname, '..', 'learning');
const TEST_PROJECT = path.join(os.tmpdir(), 'ce-sim-' + Date.now().toString(36));

// ===================== Helpers =====================

function log(msg) { console.log(`[SIM] ${msg}`); }

function askClaude(prompt) {
  const claudePath = '/opt/homebrew/bin/claude';
  const result = spawnSync(claudePath, [
    '--print', '--model', 'sonnet',
    '--system-prompt', 'You are a JSON generator. Output ONLY raw JSON — no markdown fences, no explanation.',
    '--allowedTools', '', '--no-session-persistence', '--max-turns', '1',
  ], {
    input: prompt,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, EVOLVER_CHILD: '1' },
  });
  if (result.error) throw result.error;
  const text = (result.stdout || '').trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  try { return JSON.parse(jsonMatch[1].trim()); }
  catch { return null; }
}

function runPipeline(pendingPath) {
  const result = spawnSync('node', [path.join(LEARNING_ROOT, 'processRules.js'), pendingPath], {
    encoding: 'utf8',
    timeout: 300000,
    cwd: TEST_PROJECT,
    env: { ...process.env, EVOLVER_CHILD: '0' },
  });
  if (result.error) throw result.error;
  return result;
}

// ===================== Analyst Personas =====================

const analysts = [
  {
    name: 'Alice',
    style: 'Cost-conscious, always dry_runs first, iterates with LIMIT before full query. Validates metrics with python sanity checks.',
    tasks: [
      'Analyze D7 retention for Q1 2026 new users, broken down by acquisition source',
      'Build a registration-to-first-match conversion funnel for users created in March 2026',
    ]
  },
  {
    name: 'Bob',
    style: 'Methodical, starts with base population definition on prod_db_copy, then joins Amplitude events. Always checks MAU > DAU before presenting. Uses date filters on every CTE.',
    tasks: [
      'Segment analysis: compare feature adoption rates between male and female users in Q1 2026',
      'Weekly active users trend for the past 8 weeks, split by user tenure (0-30d, 31-90d, 90d+)',
    ]
  },
  {
    name: 'Carol',
    style: 'Efficient, combines multiple event types in single queries, profiles base distribution before expensive joins. Saves results to down-adhoc/ with methodology notes.',
    tasks: [
      'Churn analysis: identify users who were active in February but not in March 2026',
      'Revenue cohort analysis: ARPU by signup month for the past 6 months',
    ]
  },
];

// ===================== Generate Session Observations =====================

function generateSession(analyst, task, sessionNum) {
  log(`Generating session for ${analyst.name}: "${task.slice(0, 50)}..."`);

  const prompt = `Generate a realistic sequence of 8-12 tool observations for a data analyst session.

ANALYST STYLE: ${analyst.style}
TASK: ${task}

Available tools and their formats:
- Bash: bq query commands (with --dry_run variants), python3 -c for sanity checks
- Read: reading SQL files, CSV files, docs
- Edit: modifying SQL files
- Write: saving results/reports

Tables available:
- prod_db_copy.users (user_id, created_at, gender, acquisition_source, dob)
- prod_db_copy.settings (user_id, loc_lat_f, loc_lng_f)
- amp.EVENTS_161970 (user_id, event_type, event_time, user_properties, event_properties)

Generate REALISTIC tool observations. Each observation must have:
- tool: "Bash" | "Read" | "Edit" | "Write"
- input: the actual command or file path (use real-looking SQL for BQ queries)
- output: realistic truncated output
- type: "database_query" if it's a bq command (add tables array and isDryRun boolean)

The analyst should follow their style naturally — don't force all patterns in every session.

Reply JSON only:
{"observations": [{"tool": "Bash", "input": "...", "output": "...", "type": "database_query", "tables": [...], "isDryRun": true/false}, ...]}`;

  const result = askClaude(prompt);
  if (!result || !result.observations) {
    log(`  Failed to generate session for ${analyst.name}, using fallback`);
    return null;
  }

  // Add timestamps
  const baseTs = Date.now() + sessionNum * 100000;
  result.observations.forEach((obs, i) => {
    obs.ts = baseTs + i * 10000;
  });

  log(`  Generated ${result.observations.length} observations`);
  return result.observations;
}

function buildPending(observations, sessionNum) {
  const dbTables = [];
  let dryRuns = 0;
  const toolCounts = {};
  const toolSequence = [];

  for (const obs of observations) {
    toolCounts[obs.tool] = (toolCounts[obs.tool] || 0) + 1;
    toolSequence.push(obs.tool);
    if (obs.type === 'database_query') {
      for (const t of (obs.tables || [])) {
        if (!dbTables.includes(t)) dbTables.push(t);
      }
      if (obs.isDryRun) dryRuns++;
    }
  }

  return {
    project: TEST_PROJECT,
    timestamp: new Date().toISOString(),
    newMemories: [],
    observations,
    sessionBehavior: {
      toolCalls: observations.length,
      toolSequence,
      toolCounts,
      dbTables,
      dbDryRuns: dryRuns,
      mcpTools: [],
      mcpActionCount: 0,
      workflowPhases: toolSequence.map(t => {
        if (t === 'Read' || t === 'Glob' || t === 'Grep') return 'explore';
        if (t === 'Edit' || t === 'Write') return 'modify';
        return 'execute';
      }).filter((v, i, a) => i === 0 || v !== a[i - 1]),
    },
    projectType: 'analysis',
    recentSessions: [],
    existingActiveRules: [],
    handWrittenContent: 'Use BigQuery for data analysis.',
  };
}

// ===================== Main =====================

async function main() {
  log('=== Analyst Simulation Test ===');
  log(`Test project: ${TEST_PROJECT}`);

  // Setup
  fs.mkdirSync(TEST_PROJECT, { recursive: true });
  fs.writeFileSync(path.join(TEST_PROJECT, 'CLAUDE.md'), '# CLAUDE.md\n## Rules\n- Use BigQuery for data analysis\n');

  // Clean rules for this project
  const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
  const data = ruleEngine.loadPopulation();
  data.population = data.population.filter(r => r.project !== TEST_PROJECT);
  data.session_count = 0;
  ruleEngine.savePopulation(data);

  // Create fake memories to simulate analyst preferences
  const memDir = path.join(os.homedir(), '.claude', 'projects', TEST_PROJECT.replace(/\//g, '-'), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'feedback_cost.md'),
    '---\nname: cost-awareness\ndescription: Always check scan cost before running queries\ntype: feedback\n---\nDon\'t run full queries without dry_run. If scan > 5GB, suggest narrowing the date range.\n');
  fs.writeFileSync(path.join(memDir, 'user_style.md'),
    '---\nname: iterative-analysis\ndescription: User prefers iterative approach\ntype: user\n---\nI prefer to iterate: sample first (LIMIT 10 or one day), validate logic, then expand. Always provide comparison baselines.\n');

  let totalSessions = 0;

  // Run sessions for each analyst
  for (const analyst of analysts) {
    log(`\n--- ${analyst.name} ---`);

    for (let i = 0; i < analyst.tasks.length; i++) {
      const task = analyst.tasks[i];
      const obs = generateSession(analyst, task, totalSessions);
      if (!obs) continue;

      const pending = buildPending(obs, totalSessions);
      const pendingPath = path.join(TEST_PROJECT, `pending_${totalSessions}.json`);
      fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');

      log(`Running pipeline session ${totalSessions + 1}...`);
      runPipeline(pendingPath);
      totalSessions++;

      // Check state after each session
      const active = ruleEngine.getActiveRules(TEST_PROJECT);
      const stats = ruleEngine.getPopulationStats(TEST_PROJECT);
      log(`  → active=${stats.active} dormant=${stats.dormant} | rules: ${active.map(r => r.content.slice(0, 40)).join(' | ')}`);
    }
  }

  // After all sessions, check scores
  log('\n=== Post-simulation state ===');
  const finalActive = ruleEngine.getActiveRules(TEST_PROJECT);
  log(`${finalActive.length} active rules:`);
  for (const r of finalActive) {
    log(`  score=${r.score.toFixed(1)} rel=${r.relevance_count || 0} cplx=${r.complexity || 'simple'} | ${r.content.slice(0, 70)}`);
  }

  // Check if any skills were generated
  const skillDir = path.join(TEST_PROJECT, '.claude', 'skills');
  if (fs.existsSync(skillDir)) {
    const skills = fs.readdirSync(skillDir).filter(f => f.endsWith('.md'));
    log(`\n${skills.length} skill file(s) generated:`);
    for (const s of skills) {
      log(`  ${s}`);
      const content = fs.readFileSync(path.join(skillDir, s), 'utf8');
      log(content.split('\n').map(l => '    ' + l).join('\n'));
    }
  } else {
    log('\nNo skill files generated yet.');

    // If no skills yet, boost scores and run one more session to force skillify
    log('\nBoosting scores to simulate maturity...');
    const data2 = ruleEngine.loadPopulation();
    for (const r of data2.population.filter(r => r.project === TEST_PROJECT && r.status === 'active')) {
      r.score = 8.5;
      r.relevance_count = 8;
      r.sessions_evaluated = 8;
    }
    ruleEngine.savePopulation(data2);

    // Run one more quiet session to trigger skillify
    const quietPending = {
      project: TEST_PROJECT,
      timestamp: new Date().toISOString(),
      newMemories: [],
      observations: [
        { ts: Date.now(), tool: 'Read', input: 'README.md', output: 'data' },
        { ts: Date.now() + 1000, tool: 'Bash', input: 'echo ok', output: 'ok' },
      ],
      sessionBehavior: { toolCalls: 2, toolSequence: ['Read', 'Bash'], toolCounts: { Read: 1, Bash: 1 }, dbTables: [], dbDryRuns: 0, mcpTools: [], mcpActionCount: 0, workflowPhases: ['explore', 'execute'] },
      projectType: 'analysis',
      recentSessions: [],
      existingActiveRules: [],
      handWrittenContent: 'Use BigQuery for data analysis.',
    };
    const qPath = path.join(TEST_PROJECT, 'pending_boost.json');
    fs.writeFileSync(qPath, JSON.stringify(quietPending, null, 2), 'utf8');
    log('Running skillify session...');
    runPipeline(qPath);

    // Check again
    if (fs.existsSync(skillDir)) {
      const skills = fs.readdirSync(skillDir).filter(f => f.endsWith('.md'));
      log(`\n${skills.length} skill file(s) generated after boost:`);
      for (const s of skills) {
        log(`  ${s}`);
        const content = fs.readFileSync(path.join(skillDir, s), 'utf8');
        log(content.split('\n').map(l => '    ' + l).join('\n'));
      }
    }
  }

  // Final summary
  log('\n=== SUMMARY ===');
  const finalStats = ruleEngine.getPopulationStats(TEST_PROJECT);
  log(`Sessions: ${totalSessions + 1}`);
  log(`Rules: active=${finalStats.active} dormant=${finalStats.dormant} dead=${finalStats.dead}`);
  log(`Skills: ${fs.existsSync(skillDir) ? fs.readdirSync(skillDir).filter(f => f.endsWith('.md')).length : 0}`);

  // Check cross-project store
  const xpPath = path.join(LEARNING_ROOT, 'data', 'cross_project_patterns.json');
  if (fs.existsSync(xpPath)) {
    const xp = JSON.parse(fs.readFileSync(xpPath, 'utf8'));
    const simPatterns = xp.patterns.filter(p => p.source_project === TEST_PROJECT);
    log(`Cross-project patterns: ${simPatterns.length}`);
  }

  // Cleanup
  log(`\nTest project at: ${TEST_PROJECT}`);
  log('Done.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
