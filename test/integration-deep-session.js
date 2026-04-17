#!/usr/bin/env node
// integration-deep-session.js — Generate deep multi-turn sessions for any profession
// Tests whether claude-evolve can discover methodology patterns from realistic work.
//
// Usage:
//   node test/integration-deep-session.js                  # default: analyst
//   node test/integration-deep-session.js backend-engineer
//   node test/integration-deep-session.js devops
//   node test/integration-deep-session.js random           # LLM picks a random profession
//
// Each run simulates 4-6 deep sessions, each with 10-15 tool calls representing
// realistic multi-turn work. The system should extract rules and eventually form a skill.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const LEARNING_ROOT = path.join(__dirname, '..', 'learning');
const PROFESSION = process.argv[2] || 'analyst';

function log(msg) { console.log(`[${PROFESSION}] ${msg}`); }

// ===================== LLM Helpers =====================

function askClaude(prompt, model) {
  const claudePath = '/opt/homebrew/bin/claude';
  const result = spawnSync(claudePath, [
    '--print', '--model', model || 'sonnet',
    '--system-prompt', 'You are a JSON generator. Output ONLY raw JSON — no markdown fences, no explanation. No trailing text.',
    '--allowedTools', '', '--no-session-persistence', '--max-turns', '1',
  ], {
    input: prompt,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, EVOLVER_CHILD: '1' },
  });
  if (result.error) throw result.error;
  const text = (result.stdout || '').trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  try { return JSON.parse(jsonMatch[1].trim()); }
  catch { return null; }
}

function runPipeline(pendingPath, projectDir) {
  const result = spawnSync('node', [path.join(LEARNING_ROOT, 'processRules.js'), pendingPath], {
    encoding: 'utf8',
    timeout: 300000,
    cwd: projectDir,
    env: { ...process.env, EVOLVER_CHILD: '0' },
  });
  return result;
}

// ===================== Profession Definitions =====================

const PROFESSIONS = {
  'analyst': {
    title: 'Data Analyst',
    context: 'Works with BigQuery (bq CLI), Amplitude event data (amp.EVENTS_161970), and prod_db_copy tables. Analyzes user behavior, retention, funnels, segmentation. Uses Python for sanity checks.',
    tables: ['prod_db_copy.users', 'amp.EVENTS_161970', 'prod_db_copy.settings'],
    tools: ['Bash (bq query, python3)', 'Read (SQL files, CSV)', 'Edit (SQL files)', 'Write (results, reports)'],
    taskExamples: 'retention cohort analysis, funnel conversion, user segmentation, churn prediction, ARPU analysis, A/B test evaluation',
  },
  'backend-engineer': {
    title: 'Backend Engineer',
    context: 'Works with Node.js/Python APIs, PostgreSQL, Redis. Implements features, fixes bugs, writes tests. Uses git, npm/pip, curl for API testing.',
    tables: [],
    tools: ['Bash (git, npm, curl, docker)', 'Read (source code)', 'Edit (source code)', 'Write (new files)', 'Grep (search code)'],
    taskExamples: 'implement REST endpoint, fix authentication bug, add database migration, write integration tests, refactor service layer, optimize slow query',
  },
  'devops': {
    title: 'DevOps Engineer',
    context: 'Manages GCP infrastructure, Docker containers, Airflow DAGs, CI/CD pipelines. Monitors logs, deploys services, manages secrets.',
    tables: [],
    tools: ['Bash (gcloud, docker, kubectl, terraform)', 'Read (config files, logs)', 'Edit (YAML configs, Dockerfiles)', 'Write (scripts, manifests)'],
    taskExamples: 'deploy new service, investigate production incident, set up monitoring alert, migrate database, update CI pipeline, rotate secrets',
  },
  'frontend-engineer': {
    title: 'Frontend Engineer',
    context: 'Works with React/TypeScript, CSS, component libraries. Builds UI features, fixes layout bugs, optimizes performance.',
    tables: [],
    tools: ['Bash (npm, vitest, eslint)', 'Read (components, styles)', 'Edit (TSX, CSS)', 'Write (new components)', 'Grep (find usages)'],
    taskExamples: 'build new dashboard page, fix responsive layout, add form validation, optimize bundle size, implement dark mode, add accessibility',
  },
};

// ===================== Generate Profession (for random mode) =====================

function getProfession(name) {
  if (name === 'random') {
    log('Asking LLM to pick a random profession...');
    const result = askClaude(`Pick a random software-adjacent profession (not data analyst, not backend engineer, not devops, not frontend engineer). Something interesting and specific.

Reply JSON: {"name": "short-slug", "title": "Full Title", "context": "2-3 sentences about what they do daily, which tools they use, what data/systems they touch", "tools": ["Tool (examples)"], "taskExamples": "comma-separated list of 6 typical tasks"}`, 'haiku');
    if (result && result.name) {
      log(`Random profession: ${result.title}`);
      return result;
    }
    log('Failed to generate random profession, falling back to analyst');
    return PROFESSIONS['analyst'];
  }
  return PROFESSIONS[name] || PROFESSIONS['analyst'];
}

// ===================== Generate Deep Sessions =====================

function generateDeepSession(profession, taskNum, totalTasks) {
  const prompt = `You are simulating a realistic work session for a ${profession.title}.

CONTEXT: ${profession.context}
AVAILABLE TOOLS: ${profession.tools.join(', ')}
${profession.tables.length > 0 ? 'TABLES: ' + profession.tables.join(', ') : ''}

Generate a DEEP, realistic session with 10-15 tool observations. This is task ${taskNum} of ${totalTasks}.

IMPORTANT — make it realistic:
- The session should feel like a real multi-step investigation, not a checklist
- Include BACK-AND-FORTH patterns: try something → check result → adjust → retry
- Include at least one MISTAKE or CORRECTION (edit something wrong, then fix it)
- Include at least one VALIDATION step (checking output is correct)
- Tool calls should have REALISTIC input/output (real-looking commands, real-looking data)
- Vary the task each time — pick from: ${profession.taskExamples}

Each observation needs:
- tool: one of "Bash", "Read", "Edit", "Write", "Grep", "Glob"
- input: the actual command or file path (realistic, specific)
- output: realistic truncated output (include numbers, errors, data)
${profession.tables.length > 0 ? '- type: "database_query" for any bq/SQL command (add tables array and isDryRun boolean)' : ''}

Reply JSON only:
{"task_description": "<one line: what this session is about>", "observations": [...]}`;

  log(`  Generating deep session ${taskNum}/${totalTasks}...`);
  const result = askClaude(prompt, 'sonnet');

  if (!result || !result.observations) {
    log(`  Failed to generate session, skipping`);
    return null;
  }

  // Add timestamps
  const baseTs = Date.now() + taskNum * 1000000;
  result.observations.forEach((obs, i) => { obs.ts = baseTs + i * 10000; });

  log(`  "${result.task_description || 'unnamed'}" — ${result.observations.length} tool calls`);
  return result;
}

function buildPending(project, observations, profession) {
  const dbTables = [];
  let dryRuns = 0;
  const toolCounts = {};
  const toolSequence = [];

  for (const obs of observations) {
    const tool = obs.tool || 'Bash';
    toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    toolSequence.push(tool);
    if (obs.type === 'database_query') {
      for (const t of (obs.tables || [])) { if (!dbTables.includes(t)) dbTables.push(t); }
      if (obs.isDryRun) dryRuns++;
    }
  }

  // Infer project type
  let projectType = 'general';
  if (dbTables.length > 0) projectType = 'analysis';
  else if (toolCounts['Edit'] > 3 && toolCounts['Bash'] > 3) projectType = 'backend';
  else if (toolCounts['Bash'] > 6) projectType = 'infra';

  return {
    project,
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
        if (['Read', 'Glob', 'Grep'].includes(t)) return 'explore';
        if (['Edit', 'Write'].includes(t)) return 'modify';
        return 'execute';
      }).filter((v, i, a) => i === 0 || v !== a[i - 1]),
    },
    projectType,
    recentSessions: [],
    existingActiveRules: [],
    handWrittenContent: '',
  };
}

// ===================== Main =====================

async function main() {
  const profession = getProfession(PROFESSION);
  const TEST_PROJECT = path.join(os.tmpdir(), `ce-deep-${PROFESSION}-${Date.now().toString(36)}`);
  const NUM_SESSIONS = 6;

  log(`=== Deep Session Test: ${profession.title} ===`);
  log(`Project: ${TEST_PROJECT}`);
  log(`Sessions: ${NUM_SESSIONS}`);

  // Setup
  fs.mkdirSync(TEST_PROJECT, { recursive: true });
  fs.writeFileSync(path.join(TEST_PROJECT, 'CLAUDE.md'), `# CLAUDE.md\n## Project\n${profession.title} workspace\n`);

  // Clean rules
  const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
  const data = ruleEngine.loadPopulation();
  data.population = data.population.filter(r => r.project !== TEST_PROJECT);
  data.session_count = 0;
  ruleEngine.savePopulation(data);

  // Run sessions
  for (let i = 1; i <= NUM_SESSIONS; i++) {
    const session = generateDeepSession(profession, i, NUM_SESSIONS);
    if (!session) continue;

    const pending = buildPending(TEST_PROJECT, session.observations, profession);
    const pendingPath = path.join(TEST_PROJECT, `pending_${i}.json`);
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');

    log(`  Running pipeline...`);
    runPipeline(pendingPath, TEST_PROJECT);

    // Report
    const active = ruleEngine.getActiveRules(TEST_PROJECT);
    const stats = ruleEngine.getPopulationStats(TEST_PROJECT);
    log(`  → session ${i}: active=${stats.active} dormant=${stats.dormant}`);
    if (active.length > 0 && active.length <= 5) {
      for (const r of active) log(`    score=${r.score.toFixed(1)} | ${r.content.slice(0, 60)}`);
    }
  }

  // Post-simulation report
  log('\n=== Post-simulation ===');
  const finalActive = ruleEngine.getActiveRules(TEST_PROJECT);
  log(`${finalActive.length} active rules:`);
  for (const r of finalActive) {
    log(`  score=${r.score.toFixed(1)} eval=${r.sessions_evaluated || 0} cplx=${r.complexity || 'simple'} | ${r.content.slice(0, 70)}`);
  }

  // Check for natural skill emergence (score > 7 after heuristic scoring)
  const matureRules = finalActive.filter(r => (r.score || 0) > 7 && (r.relevance_count || 0) >= 5);
  log(`\nMature rules (score > 7, 5+ evals): ${matureRules.length}`);

  // If not enough mature rules, boost and skillify
  const skillDir = path.join(TEST_PROJECT, '.claude', 'skills');
  if (matureRules.length < 3 && finalActive.length >= 3) {
    log('\nBoosting scores to test skill generation...');
    const d2 = ruleEngine.loadPopulation();
    for (const r of d2.population.filter(r => r.project === TEST_PROJECT && r.status === 'active')) {
      r.score = 8.5; r.relevance_count = 8; r.sessions_evaluated = 8;
    }
    ruleEngine.savePopulation(d2);

    const boostPending = buildPending(TEST_PROJECT, [
      { ts: Date.now(), tool: 'Read', input: 'README.md', output: '...' },
      { ts: Date.now() + 1000, tool: 'Bash', input: 'echo done', output: 'done' },
    ], profession);
    const bp = path.join(TEST_PROJECT, 'pending_boost.json');
    fs.writeFileSync(bp, JSON.stringify(boostPending, null, 2), 'utf8');
    log('Running skillify...');
    runPipeline(bp, TEST_PROJECT);
  }

  // Show skill
  if (fs.existsSync(skillDir)) {
    const skills = fs.readdirSync(skillDir).filter(f => f.endsWith('.md'));
    log(`\n=== ${skills.length} SKILL FILE(S) GENERATED ===`);
    for (const s of skills) {
      const content = fs.readFileSync(path.join(skillDir, s), 'utf8');
      log(`\n--- ${s} ---`);
      log(content);

      // Validate
      const checks = {
        hasFrontmatter: content.includes('---'),
        hasName: /name:/.test(content),
        hasDescription: /description:/.test(content),
        hasTriggers: /triggers:/.test(content),
        hasThinkingOrWorkflow: /## (Thinking|Workflow|Steps)/.test(content),
        hasWhatNotToDo: /## What NOT/i.test(content),
      };
      const failed = Object.entries(checks).filter(([, v]) => !v);
      log(`Validation: ${failed.length === 0 ? 'ALL PASS ✓' : 'FAILED: ' + failed.map(([k]) => k).join(', ')}`);
    }
  } else {
    log('\nNo skill files generated.');
  }

  // Summary
  const finalStats = ruleEngine.getPopulationStats(TEST_PROJECT);
  log('\n=== FINAL SUMMARY ===');
  log(`Profession: ${profession.title}`);
  log(`Sessions: ${NUM_SESSIONS}`);
  log(`Rules: active=${finalStats.active} dormant=${finalStats.dormant}`);
  log(`Skills: ${fs.existsSync(skillDir) ? fs.readdirSync(skillDir).filter(f => f.endsWith('.md')).length : 0}`);

  const xpPath = path.join(LEARNING_ROOT, 'data', 'cross_project_patterns.json');
  if (fs.existsSync(xpPath)) {
    const xp = JSON.parse(fs.readFileSync(xpPath, 'utf8'));
    log(`Cross-project patterns: ${xp.patterns.filter(p => p.source_project === TEST_PROJECT).length}`);
  }

  log(`\nProject: ${TEST_PROJECT}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
