#!/usr/bin/env node
// demo.js — See claude-evolve learn a profession's thinking model
//
// Pick any profession. The system:
//   1. Generates N realistic deep work sessions for that profession
//   2. Observes tool usage, extracts patterns, scores them
//   3. Promotes mature patterns to a .claude/skills/ methodology file
//   4. Writes a Skill Routing block into CLAUDE.md
//
// Usage:
//   node demo.js analyst                      # defaults: 3 sessions, 8 tool calls each, parallel
//   node demo.js ios-engineer --sessions=5    # more sessions = richer learning (slower)
//   node demo.js game-dev --depth=12          # deeper sessions = more detail per task
//   node demo.js random                       # LLM picks a profession
//   node demo.js devops --sequential          # one at a time (slower but easier to follow)
//
// Flags:
//   --sessions=N   Number of sessions to simulate (default 3, max 10)
//   --depth=N      Tool calls per session (default 8, range 5-20)
//   --sequential   Run sessions one at a time instead of parallel
//   --model=X      "haiku" (fast, default) or "sonnet" (richer, slower)

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const LEARNING_ROOT = path.join(__dirname, 'learning');

// ===================== Args =====================

const args = process.argv.slice(2);
const PROFESSION = args.find(a => !a.startsWith('--')) || 'analyst';
function getFlag(name, def) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
}
function hasFlag(name) { return args.includes(`--${name}`); }

const NUM_SESSIONS = Math.min(10, Math.max(1, parseInt(getFlag('sessions', '3'), 10)));
const DEPTH = Math.min(20, Math.max(5, parseInt(getFlag('depth', '8'), 10)));
const SEQUENTIAL = hasFlag('sequential');
const MODEL = getFlag('model', 'haiku');
const DEMO_ROOT = path.join(__dirname, 'demo-output', `${PROFESSION}-${Date.now().toString(36)}`);

// ===================== Pretty printing =====================

const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m',
};

function header(msg) { console.log(`\n${colors.bold}${colors.cyan}━━━ ${msg} ━━━${colors.reset}\n`); }
function log(msg) { console.log(`${colors.dim}  │${colors.reset} ${msg}`); }
function ok(msg) { console.log(`${colors.green}  ✓${colors.reset} ${msg}`); }
function warn(msg) { console.log(`${colors.yellow}  !${colors.reset} ${msg}`); }
function info(msg) { console.log(`${colors.dim}${msg}${colors.reset}`); }

// ===================== LLM helpers =====================

function findClaude() {
  const candidates = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'claude';
}

/** Sync ask (blocking). Has retry + longer timeout. */
function askClaude(prompt, model, retries) {
  const maxRetries = retries || 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = spawnSync(findClaude(), [
      '--print', '--model', model || MODEL,
      '--system-prompt', 'You are a JSON generator. Output ONLY raw JSON — no markdown fences, no explanation.',
      '--allowedTools', '', '--no-session-persistence', '--max-turns', '1',
    ], {
      input: prompt, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, EVOLVER_CHILD: '1' },
    });
    if (result.error) {
      if (attempt < maxRetries) continue;
      throw result.error;
    }
    const text = (result.stdout || '').trim();
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    try { return JSON.parse(match[1].trim()); }
    catch {
      if (attempt < maxRetries) continue;
      return null;
    }
  }
  return null;
}

/** Async ask — returns a Promise. Used for parallel session generation. */
function askClaudeAsync(prompt, model) {
  return new Promise((resolve) => {
    const child = spawn(findClaude(), [
      '--print', '--model', model || MODEL,
      '--system-prompt', 'You are a JSON generator. Output ONLY raw JSON — no markdown fences, no explanation.',
      '--allowedTools', '', '--no-session-persistence', '--max-turns', '1',
    ], { env: { ...process.env, EVOLVER_CHILD: '1' } });

    let stdout = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 180000);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stdin.write(prompt); child.stdin.end();
    child.on('close', () => {
      clearTimeout(timer);
      if (killed) return resolve(null);
      const text = stdout.trim();
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      try { resolve(JSON.parse(match[1].trim())); } catch { resolve(null); }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function runPipeline(pendingPath, cwd) {
  return spawnSync('node', [path.join(LEARNING_ROOT, 'processRules.js'), pendingPath], {
    encoding: 'utf8', timeout: 300000, cwd,
    env: { ...process.env, EVOLVER_CHILD: '0' },
  });
}

/** Stream process.log so user sees pipeline activity live. */
function tailProcessLog(sinceMtime) {
  const logPath = path.join(LEARNING_ROOT, 'data', 'process.log');
  if (!fs.existsSync(logPath)) return { stop: () => {} };

  let lastSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > lastSize) {
        const buf = Buffer.alloc(stat.size - lastSize);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const newLines = buf.toString('utf8').trim().split('\n').filter(Boolean);
        for (const line of newLines) {
          // Strip timestamp prefix and show interesting lines
          const m = line.match(/^\[[^\]]+\]\s*(.+)$/);
          const msg = m ? m[1] : line;
          if (/Triage|Skillify|Promoted|Skill file|Added|Merged|Heuristic-score|Cross-project|Done/.test(msg)) {
            console.log(`${colors.dim}       ${colors.magenta}↳${colors.dim} ${msg.slice(0, 100)}${colors.reset}`);
          }
        }
      }
    } catch {}
    setTimeout(tick, 500);
  };
  tick();

  return { stop: () => { stopped = true; } };
}

// ===================== Profession profile =====================

function getProfession(name) {
  const promptName = name === 'random'
    ? 'a random software-adjacent profession — something interesting and specific'
    : `a "${name}"`;

  log(`Asking LLM to define the profile for ${promptName}...`);
  const result = askClaude(`Define the profile for ${promptName}.

Use only generic/public technology names. Keep it concise.

Reply JSON only:
{"name":"short-slug","title":"Full Title","context":"2 sentences about daily work","tools":["Tool (examples)","..."],"taskExamples":"5 typical tasks, comma-separated"}`, 'haiku');

  if (result && result.name) {
    ok(`Profile: ${result.title}`);
    return { ...result, tables: [] };
  }
  warn('Using generic fallback profile');
  return {
    name, title: name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    context: 'A software professional working in their domain.',
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep'],
    taskExamples: 'implement feature, fix bug, write tests, refactor, optimize',
    tables: [],
  };
}

// ===================== Session generation =====================

function sessionPrompt(profession, num, total) {
  return `Simulate a work session for a ${profession.title}.

CONTEXT: ${profession.context}
TOOLS: ${profession.tools.join(', ')}

Generate ${DEPTH} tool observations. Task ${num}/${total}. Vary the task: ${profession.taskExamples}.

Each observation: {tool, input (realistic command or file path), output (realistic short output)}
Include some real-world patterns: try → check → adjust → retry.

Reply JSON only:
{"task_description":"<one line>","observations":[{"tool":"Bash","input":"...","output":"..."},...]}`;
}

async function generateSessionAsync(profession, num, total) {
  const result = await askClaudeAsync(sessionPrompt(profession, num, total), MODEL);
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

  console.log(`\n${colors.dim}Profession:${colors.reset} ${colors.bold}${PROFESSION}${colors.reset}`);
  console.log(`${colors.dim}Config:${colors.reset} ${NUM_SESSIONS} sessions × ${DEPTH} tool calls, ${SEQUENTIAL ? 'sequential' : 'parallel'} generation, model=${MODEL}`);
  console.log(`${colors.dim}Output: ${DEMO_ROOT}${colors.reset}`);
  const est = SEQUENTIAL ? NUM_SESSIONS * 3 : Math.ceil(NUM_SESSIONS / 2) + 2;
  console.log(`${colors.dim}Estimated: ~${est} minutes${colors.reset}\n`);

  fs.mkdirSync(DEMO_ROOT, { recursive: true });
  fs.writeFileSync(path.join(DEMO_ROOT, 'CLAUDE.md'),
    `# CLAUDE.md\n## Project\n${PROFESSION} workspace (demo)\n`);

  const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
  const data = ruleEngine.loadPopulation();
  data.population = data.population.filter(r => !r.project.includes('/demo-output/'));
  ruleEngine.savePopulation(data);

  // Step 1: Profession
  header('Step 1 — Define the profession');
  const profession = getProfession(PROFESSION);
  log(profession.context);
  log(`Typical tasks: ${profession.taskExamples.slice(0, 100)}${profession.taskExamples.length > 100 ? '...' : ''}`);

  // Step 2: Generate sessions
  header(`Step 2 — Simulate ${NUM_SESSIONS} work sessions (${SEQUENTIAL ? 'sequential' : 'parallel'})`);

  let sessions = [];
  const t0 = Date.now();

  if (SEQUENTIAL) {
    for (let i = 1; i <= NUM_SESSIONS; i++) {
      log(`Session ${i}/${NUM_SESSIONS}: generating (model=${MODEL})...`);
      const sT0 = Date.now();
      const s = await generateSessionAsync(profession, i, NUM_SESSIONS);
      const dt = ((Date.now() - sT0) / 1000).toFixed(0);
      if (s) { sessions.push({ num: i, ...s }); ok(`  [${dt}s] ${s.task_description || 'session'} (${s.observations.length} calls)`); }
      else warn(`  [${dt}s] session ${i} failed — will skip`);
    }
  } else {
    log(`Launching ${NUM_SESSIONS} sessions in parallel (model=${MODEL}, ~${DEPTH} calls each)...`);
    let completed = 0;
    const promises = [];
    for (let i = 1; i <= NUM_SESSIONS; i++) {
      const sT0 = Date.now();
      const p = generateSessionAsync(profession, i, NUM_SESSIONS).then(s => {
        completed++;
        const dt = ((Date.now() - sT0) / 1000).toFixed(0);
        if (s && s.observations) {
          ok(`[${dt}s] (${completed}/${NUM_SESSIONS}) Session ${i}: ${(s.task_description || 'session').slice(0, 70)}`);
          return { num: i, ...s };
        } else {
          warn(`[${dt}s] (${completed}/${NUM_SESSIONS}) Session ${i} failed`);
          return { num: i };
        }
      });
      promises.push(p);
    }
    // Heartbeat while waiting
    const heartbeat = setInterval(() => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      if (completed < NUM_SESSIONS) {
        process.stdout.write(`${colors.dim}       ${colors.magenta}∙${colors.dim} waiting... ${completed}/${NUM_SESSIONS} done, ${elapsed}s elapsed${colors.reset}\r`);
      }
    }, 3000);
    const results = await Promise.all(promises);
    clearInterval(heartbeat);
    process.stdout.write('\r' + ' '.repeat(80) + '\r'); // clear heartbeat line
    for (const r of results) {
      if (r && r.observations) sessions.push(r);
    }
  }
  const genTime = ((Date.now() - t0) / 1000).toFixed(0);
  log(`Generation phase done in ${genTime}s — ${sessions.length} sessions ready`);

  if (sessions.length === 0) {
    warn('No sessions generated. Check Claude CLI is installed and authenticated.');
    process.exit(1);
  }

  // Step 3: Run pipeline on each session (must be sequential — shared state)
  header(`Step 3 — Feed sessions through the learning pipeline`);
  info(`  (pipeline output shown inline — watch what the system decides)`);

  let prevRuleCount = 0;
  for (const s of sessions) {
    const pT0 = Date.now();
    log(`Session ${s.num}: feeding ${s.observations.length} observations to pipeline...`);
    const pending = buildPending(DEMO_ROOT, s.observations);
    const pendingPath = path.join(DEMO_ROOT, `pending_${s.num}.json`);
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');

    // Tail process.log live during this pipeline run
    const tail = tailProcessLog();
    runPipeline(pendingPath, DEMO_ROOT);
    tail.stop();

    const dt = ((Date.now() - pT0) / 1000).toFixed(0);
    const stats = ruleEngine.getPopulationStats(DEMO_ROOT);
    const activeRules = ruleEngine.getActiveRules(DEMO_ROOT);
    const newRules = activeRules.slice(prevRuleCount);
    prevRuleCount = activeRules.length;

    ok(`  [${dt}s] session ${s.num} done — ${stats.active} active rules (${newRules.length > 0 ? '+' + newRules.length : 'no new'})`);
    for (const r of newRules.slice(0, 3)) {
      console.log(`${colors.dim}       ${colors.green}+${colors.reset} ${colors.dim}${r.content.slice(0, 90)}${colors.reset}`);
    }
    if (newRules.length > 3) console.log(`${colors.dim}       ${colors.green}+${colors.reset} ${colors.dim}...and ${newRules.length - 3} more${colors.reset}`);
  }

  // Step 4: Mature + skillify
  header('Step 4 — Promote mature patterns to a skill');
  const active = ruleEngine.getActiveRules(DEMO_ROOT);
  const mature = active.filter(r => (r.score || 0) > 7 && (r.relevance_count || 0) >= 5);

  if (mature.length < 3 && active.length >= 3) {
    log(`Boosting ${active.length} rules (simulating extended real-world usage)`);
    const d = ruleEngine.loadPopulation();
    for (const r of d.population.filter(r => r.project === DEMO_ROOT && r.status === 'active')) {
      r.score = 8.5; r.relevance_count = 8; r.sessions_evaluated = 8;
    }
    ruleEngine.savePopulation(d);

    const bp = path.join(DEMO_ROOT, 'pending_boost.json');
    fs.writeFileSync(bp, JSON.stringify(buildPending(DEMO_ROOT, [
      { ts: Date.now(), tool: 'Read', input: 'README.md', output: '...' },
      { ts: Date.now() + 1, tool: 'Bash', input: 'echo', output: 'ok' },
    ]), null, 2), 'utf8');
    log('Running skillify gene (this includes a sonnet call to generate the skill — takes ~60s)...');
    const skT0 = Date.now();
    const tail = tailProcessLog();
    runPipeline(bp, DEMO_ROOT);
    tail.stop();
    const skDt = ((Date.now() - skT0) / 1000).toFixed(0);
    ok(`  skillify done in ${skDt}s`);
  } else if (active.length < 3) {
    warn(`Only ${active.length} rules extracted — need more sessions for a skill to form.`);
  }

  // Step 5: Show outputs
  header('Step 5 — What the system learned');

  const claudeMdPath = path.join(DEMO_ROOT, 'CLAUDE.md');
  const skillDir = path.join(DEMO_ROOT, '.claude', 'skills');

  console.log(`${colors.bold}${colors.green}▶ CLAUDE.md${colors.reset}`);
  console.log(`${colors.dim}${'─'.repeat(64)}${colors.reset}`);
  console.log(fs.readFileSync(claudeMdPath, 'utf8'));

  if (fs.existsSync(skillDir)) {
    for (const s of fs.readdirSync(skillDir).filter(f => f.endsWith('.md'))) {
      console.log(`\n${colors.bold}${colors.green}▶ .claude/skills/${s}${colors.reset}`);
      console.log(`${colors.dim}${'─'.repeat(64)}${colors.reset}`);
      console.log(fs.readFileSync(path.join(skillDir, s), 'utf8'));
    }
  }

  // Summary
  header('Summary');
  const finalStats = ruleEngine.getPopulationStats(DEMO_ROOT);
  const totalTime = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`  Profession:        ${profession.title}`);
  console.log(`  Sessions:          ${sessions.length}/${NUM_SESSIONS} succeeded, ${DEPTH} tool calls each`);
  console.log(`  Rules:             ${finalStats.active} active, ${finalStats.dormant} dormant`);
  console.log(`  Skills:            ${fs.existsSync(skillDir) ? fs.readdirSync(skillDir).filter(f => f.endsWith('.md')).length : 0}`);
  console.log(`  Total time:        ${totalTime}s`);
  console.log(`\n  Output: ${colors.blue}${DEMO_ROOT}${colors.reset}`);

  // Clean up demo rules
  const d2 = ruleEngine.loadPopulation();
  d2.population = d2.population.filter(r => r.project !== DEMO_ROOT);
  ruleEngine.savePopulation(d2);
  console.log(`  ${colors.green}✓${colors.reset} Demo rules removed — your real learning is untouched\n`);
}

main().catch(err => {
  console.error(`\n${colors.yellow}✗ Demo failed:${colors.reset}`, err.message || err);
  console.error(`${colors.dim}Output preserved: ${DEMO_ROOT}${colors.reset}\n`);
  process.exit(1);
});
