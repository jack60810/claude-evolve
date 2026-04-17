#!/usr/bin/env node
// demo.js — See claude-evolve learn a profession's thinking model
//
// Pick any profession. The system will:
//   1. Generate 6 realistic deep work sessions for that profession
//   2. Observe the tool usage, extract patterns, score them
//   3. Promote mature patterns to a .claude/skills/ methodology file
//   4. Write a Skill Routing block into CLAUDE.md
//
// You'll see both files at the end — this is exactly what claude-evolve
// would produce for a real user working in that profession.
//
// Usage:
//   node demo.js                    # defaults to analyst
//   node demo.js ios-engineer
//   node demo.js game-developer
//   node demo.js random             # LLM picks a profession
//
// Cost: ~10-15 LLM calls (claude CLI) per run. Takes 10-15 minutes.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const LEARNING_ROOT = path.join(__dirname, 'learning');
const PROFESSION = process.argv[2] || 'analyst';
const DEMO_ROOT = path.join(__dirname, 'demo-output', `${PROFESSION}-${Date.now().toString(36)}`);

// ===================== Pretty printing =====================

const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
};

function header(msg) {
  console.log(`\n${colors.bold}${colors.cyan}━━━ ${msg} ━━━${colors.reset}\n`);
}
function log(msg) { console.log(`${colors.dim}  │${colors.reset} ${msg}`); }
function ok(msg) { console.log(`${colors.green}  ✓${colors.reset} ${msg}`); }
function warn(msg) { console.log(`${colors.yellow}  !${colors.reset} ${msg}`); }

// ===================== LLM helpers =====================

function findClaude() {
  const candidates = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'claude';
}

function askClaude(prompt, model) {
  const result = spawnSync(findClaude(), [
    '--print', '--model', model || 'sonnet',
    '--system-prompt', 'You are a JSON generator. Output ONLY raw JSON — no markdown fences, no explanation.',
    '--allowedTools', '', '--no-session-persistence', '--max-turns', '1',
  ], {
    input: prompt, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, EVOLVER_CHILD: '1' },
  });
  if (result.error) throw result.error;
  const text = (result.stdout || '').trim();
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  try { return JSON.parse(match[1].trim()); }
  catch { return null; }
}

function runPipeline(pendingPath, cwd) {
  return spawnSync('node', [path.join(LEARNING_ROOT, 'processRules.js'), pendingPath], {
    encoding: 'utf8', timeout: 300000, cwd,
    env: { ...process.env, EVOLVER_CHILD: '0' },
  });
}

// ===================== Profession profile =====================

function getProfession(name) {
  const promptName = name === 'random'
    ? 'a random software-adjacent profession — something interesting and specific'
    : `a "${name}"`;

  log(`Asking LLM to define the profile for ${promptName}...`);
  const result = askClaude(`Define the profile for ${promptName}.

Use only generic/public technology names (e.g., Swift, Xcode, Kubernetes, Postgres).
Do NOT invent company-specific table names, proprietary systems, or internal codenames.

Reply JSON only:
{"name":"short-slug","title":"Full Title","context":"2-3 sentences about daily work","tools":["Tool (examples)"],"taskExamples":"6+ typical tasks"}`, 'sonnet');

  if (result && result.name) {
    ok(`Profile: ${result.title}`);
    return { ...result, tables: [] };
  }
  warn('Using generic fallback profile');
  return {
    name, title: name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    context: 'A software professional working in their domain.',
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep'],
    taskExamples: 'implement feature, fix bug, write tests, refactor, optimize, review',
    tables: [],
  };
}

// ===================== Session generation =====================

function generateSession(profession, num, total) {
  const prompt = `Simulate a realistic work session for a ${profession.title}.

CONTEXT: ${profession.context}
TOOLS: ${profession.tools.join(', ')}

Generate 10-15 tool observations representing a deep multi-step work session.
Task ${num}/${total}. Vary the task: ${profession.taskExamples}.

Include realistic patterns: investigation → mistakes → corrections → validation.
Each observation: {tool, input (realistic command/file), output (realistic result), type?, tables?, isDryRun?}

Reply JSON only:
{"task_description":"<what this session is about>","observations":[...]}`;

  const result = askClaude(prompt, 'sonnet');
  if (!result || !result.observations) return null;
  const baseTs = Date.now() + num * 1000000;
  result.observations.forEach((obs, i) => { obs.ts = baseTs + i * 10000; });
  return result;
}

function buildPending(project, observations) {
  const dbTables = [];
  let dryRuns = 0;
  const toolCounts = {};
  const toolSequence = [];

  for (const obs of observations) {
    const t = obs.tool || 'Bash';
    toolCounts[t] = (toolCounts[t] || 0) + 1;
    toolSequence.push(t);
    if (obs.type === 'database_query') {
      for (const x of (obs.tables || [])) if (!dbTables.includes(x)) dbTables.push(x);
      if (obs.isDryRun) dryRuns++;
    }
  }

  let projectType = 'general';
  if (dbTables.length > 0) projectType = 'analysis';
  else if (toolCounts['Edit'] > 3 && toolCounts['Bash'] > 3) projectType = 'backend';
  else if (toolCounts['Bash'] > 6) projectType = 'infra';

  return {
    project, timestamp: new Date().toISOString(),
    newMemories: [], observations,
    sessionBehavior: {
      toolCalls: observations.length, toolSequence, toolCounts,
      dbTables, dbDryRuns: dryRuns, mcpTools: [], mcpActionCount: 0,
      workflowPhases: toolSequence.map(t =>
        ['Read','Glob','Grep'].includes(t) ? 'explore' :
        ['Edit','Write'].includes(t) ? 'modify' : 'execute'
      ).filter((v, i, a) => i === 0 || v !== a[i - 1]),
    },
    projectType, recentSessions: [], existingActiveRules: [], handWrittenContent: '',
  };
}

// ===================== Main =====================

async function main() {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════════════════════════════╗
║   claude-evolve demo — watch the system learn a profession   ║
╚══════════════════════════════════════════════════════════════╝${colors.reset}`);

  console.log(`\n${colors.dim}Profession: ${colors.reset}${colors.bold}${PROFESSION}${colors.reset}`);
  console.log(`${colors.dim}Output dir: ${DEMO_ROOT}${colors.reset}`);
  console.log(`${colors.dim}Note: this makes ~10-15 Claude CLI calls. Takes 10-15 minutes.${colors.reset}\n`);

  // Setup
  fs.mkdirSync(DEMO_ROOT, { recursive: true });
  fs.writeFileSync(path.join(DEMO_ROOT, 'CLAUDE.md'),
    `# CLAUDE.md\n## Project\n${PROFESSION} workspace (demo)\n`);

  // Clean any prior demo data for this project path
  const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
  const data = ruleEngine.loadPopulation();
  data.population = data.population.filter(r => !r.project.includes('/demo-output/'));
  ruleEngine.savePopulation(data);

  // Step 1: Profession profile
  header('Step 1 — Define the profession');
  const profession = getProfession(PROFESSION);
  log(`${profession.context}`);
  log(`Typical tasks: ${profession.taskExamples.slice(0, 100)}...`);

  // Step 2: Generate deep sessions
  header('Step 2 — Simulate 6 deep work sessions');
  const NUM = 6;
  let succeeded = 0;

  for (let i = 1; i <= NUM; i++) {
    log(`Session ${i}/${NUM}: generating observations...`);
    const session = generateSession(profession, i, NUM);
    if (!session) { warn(`Session ${i} generation failed, skipping`); continue; }

    log(`  task: ${session.task_description}`);
    log(`  ${session.observations.length} tool calls — running pipeline...`);

    const pending = buildPending(DEMO_ROOT, session.observations);
    const pendingPath = path.join(DEMO_ROOT, `pending_${i}.json`);
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');
    runPipeline(pendingPath, DEMO_ROOT);

    const stats = ruleEngine.getPopulationStats(DEMO_ROOT);
    ok(`session ${i} done — active=${stats.active}, dormant=${stats.dormant}`);
    succeeded++;
  }

  // Step 3: Boost scores if needed, run skillify
  header('Step 3 — Promote mature patterns to a skill');
  const active = ruleEngine.getActiveRules(DEMO_ROOT);
  const mature = active.filter(r => (r.score || 0) > 7 && (r.relevance_count || 0) >= 5);

  if (mature.length < 3 && active.length >= 3) {
    log(`Boosting ${active.length} rules to mature score (simulating extended use)`);
    const d = ruleEngine.loadPopulation();
    for (const r of d.population.filter(r => r.project === DEMO_ROOT && r.status === 'active')) {
      r.score = 8.5; r.relevance_count = 8; r.sessions_evaluated = 8;
    }
    ruleEngine.savePopulation(d);

    const boostPending = buildPending(DEMO_ROOT, [
      { ts: Date.now(), tool: 'Read', input: 'README.md', output: '...' },
      { ts: Date.now() + 1, tool: 'Bash', input: 'echo done', output: 'done' },
    ]);
    const bp = path.join(DEMO_ROOT, 'pending_boost.json');
    fs.writeFileSync(bp, JSON.stringify(boostPending, null, 2), 'utf8');
    log('Running skillify gene...');
    runPipeline(bp, DEMO_ROOT);
  }

  // Step 4: Show the outputs
  header('Step 4 — What the system learned');

  const claudeMdPath = path.join(DEMO_ROOT, 'CLAUDE.md');
  const skillDir = path.join(DEMO_ROOT, '.claude', 'skills');

  console.log(`${colors.bold}${colors.green}▶ CLAUDE.md${colors.reset} ${colors.dim}(${claudeMdPath})${colors.reset}`);
  console.log(`${colors.dim}${'─'.repeat(64)}${colors.reset}`);
  console.log(fs.readFileSync(claudeMdPath, 'utf8'));
  console.log();

  if (fs.existsSync(skillDir)) {
    const skills = fs.readdirSync(skillDir).filter(f => f.endsWith('.md'));
    for (const s of skills) {
      const skillPath = path.join(skillDir, s);
      console.log(`${colors.bold}${colors.green}▶ .claude/skills/${s}${colors.reset} ${colors.dim}(${skillPath})${colors.reset}`);
      console.log(`${colors.dim}${'─'.repeat(64)}${colors.reset}`);
      console.log(fs.readFileSync(skillPath, 'utf8'));
      console.log();
    }
  } else {
    warn('No skill file was generated. Try running again — LLM generation can fail.');
  }

  // Summary
  header('Summary');
  const finalStats = ruleEngine.getPopulationStats(DEMO_ROOT);
  console.log(`  Profession:       ${profession.title}`);
  console.log(`  Sessions run:     ${succeeded}/${NUM}`);
  console.log(`  Rules extracted:  ${finalStats.active} active, ${finalStats.dormant} dormant`);
  console.log(`  Skills generated: ${fs.existsSync(skillDir) ? fs.readdirSync(skillDir).filter(f => f.endsWith('.md')).length : 0}`);
  console.log(`\n  Output kept at:   ${colors.blue}${DEMO_ROOT}${colors.reset}`);
  console.log(`  ${colors.dim}(delete this directory when done — it's just for the demo)${colors.reset}`);

  // Clean up rules from learning/data/rules.json so demo doesn't pollute real learning
  const d2 = ruleEngine.loadPopulation();
  d2.population = d2.population.filter(r => r.project !== DEMO_ROOT);
  ruleEngine.savePopulation(d2);
  console.log(`\n  ${colors.green}✓${colors.reset} Demo rules removed from learning/data/rules.json`);
  console.log(`  ${colors.dim}(your real project learning is untouched)${colors.reset}\n`);
}

main().catch(err => {
  console.error(`\n${colors.yellow}✗ Demo failed:${colors.reset}`, err.message || err);
  console.error(`${colors.dim}Output dir preserved for inspection: ${DEMO_ROOT}${colors.reset}\n`);
  process.exit(1);
});
