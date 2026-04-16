#!/usr/bin/env node
// llmBrain.js — LLM-powered decision engine for rule learning
// Uses `claude --print` to make semantic decisions instead of hardcoded thresholds.
// All functions return structured JSON from the LLM.

const { execSync } = require('child_process');

// Model tiers: haiku for simple tasks, sonnet for complex reasoning
const MODELS = {
  fast: 'haiku',   // Classification, extraction, simple decisions
  smart: 'sonnet', // Reflection, distillation, complex analysis
};
const SYSTEM_PROMPT = 'You are a JSON classification engine for a rule learning system. Output ONLY raw JSON — no markdown fences, no code blocks, no backticks, no explanation. Just the JSON object.';

// Cache claude path — works on macOS (homebrew ARM/Intel), Linux, and custom installs
let _claudePath = null;
function getClaudePath() {
  if (_claudePath) return _claudePath;
  const searchPaths = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/snap/bin:'
    + (process.env.HOME ? process.env.HOME + '/.npm-global/bin:' : '')
    + (process.env.PATH || '');
  try {
    _claudePath = execSync('which claude', { encoding: 'utf8', timeout: 3000,
      env: { ...process.env, PATH: searchPaths }
    }).trim();
  } catch {
    // Fallback: try common locations directly
    const fs = require('fs');
    const candidates = [
      '/opt/homebrew/bin/claude',     // macOS ARM
      '/usr/local/bin/claude',        // macOS Intel / Linux
      '/usr/bin/claude',              // Linux system
      '/snap/bin/claude',             // Linux snap
    ];
    _claudePath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'claude';
  }
  return _claudePath;
}

/**
 * Call Claude CLI and return parsed JSON response.
 * @param {string} prompt - The prompt text
 * @param {number} timeoutMs - Timeout in ms
 * @param {string} tier - 'fast' (haiku) or 'smart' (sonnet)
 */
function askClaude(prompt, timeoutMs, tier) {
  const timeout = timeoutMs || 30000;
  const model = MODELS[tier || 'fast'] || MODELS.fast;

  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync(getClaudePath(), [
      '--print',
      '--model', model,
      '--system-prompt', SYSTEM_PROMPT,
      '--allowedTools', '',
      '--no-session-persistence',
      '--max-turns', '1',
    ], {
      input: prompt,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
        EVOLVER_CHILD: '1',
      },
    });

    if (result.error) throw result.error;
    if (result.status !== 0 && !result.stdout) {
      const stderr = (result.stderr || '').slice(0, 200);
      throw new Error(`claude exited with status ${result.status}: ${stderr}`);
    }
    const stdout = result.stdout || '';

    // Try to parse as JSON
    const trimmed = stdout.trim();
    if (!trimmed) return null;

    // Extract JSON from potential markdown code blocks
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, trimmed];
    const jsonStr = jsonMatch[1].trim();

    try {
      return JSON.parse(jsonStr);
    } catch {
      return { raw: trimmed };
    }
  } catch (err) {
    // Log error for debugging
    try {
      const fs = require('fs');
      const logPath = require('path').join(__dirname, 'data', 'llm_errors.log');
      fs.appendFileSync(logPath,
        `[${new Date().toISOString()}] ${err.message || err}\n`, 'utf8');
    } catch {}
    return null;
  }
}

/**
 * Call askClaude with a retry (some calls fail due to rate limits).
 * @param {string} prompt
 * @param {number} timeoutMs
 * @param {string} tier - 'fast' or 'smart'
 * @param {number} retries - number of retries (default 1)
 */
function askClaudeWithRetry(prompt, timeoutMs, tier, retries) {
  const maxRetries = retries || 1;
  for (let i = 0; i <= maxRetries; i++) {
    const result = askClaude(prompt, timeoutMs, tier);
    if (result !== null) return result;
    if (i < maxRetries) {
      const { spawnSync } = require('child_process');
      spawnSync('sleep', ['2'], { timeout: 5000 });
    }
  }
  return null;
}

// ===================== Core Decision Functions =====================

/**
 * Extract a concise, actionable rule from a feedback memory.
 * Returns: { rule: string, type: 'rule' | 'skill', keywords: string[] }
 */
function extractRule(memory) {
  const prompt = `You are a rule extraction engine. Given a feedback memory from a user's Claude Code session, extract ONE concise, actionable rule.

FEEDBACK MEMORY:
Name: ${memory.name}
Description: ${memory.description}
Content: ${memory.content}

Reply with ONLY this JSON (no markdown, no explanation):
{
  "rule": "<one-sentence actionable rule in the same language as the input>",
  "type": "rule",
  "keywords": ["<3-6 key domain terms for matching>"]
}`;

  return askClaudeWithRetry(prompt, 20000);
}

/**
 * Check if a new rule conflicts with or duplicates existing hand-written CLAUDE.md rules.
 * Returns: { decision: 'new' | 'conflict' | 'duplicate', reason: string, conflicts_with?: string }
 */
function checkConflict(newRule, handWrittenContent) {
  const prompt = `You are a conflict detector. Compare a NEW auto-learned rule against EXISTING hand-written rules in CLAUDE.md.

NEW RULE:
${newRule}

EXISTING HAND-WRITTEN RULES:
${handWrittenContent.slice(0, 3000)}

Decide:
- "duplicate" if the new rule says essentially the same thing as an existing rule (even in a different language)
- "conflict" if the new rule contradicts an existing rule
- "new" if the new rule covers a genuinely different topic

Reply with ONLY this JSON (no markdown, no explanation):
{
  "decision": "new|conflict|duplicate",
  "reason": "<one sentence explaining why>",
  "conflicts_with": "<the specific existing rule text it conflicts/duplicates with, or empty string>"
}`;

  return askClaudeWithRetry(prompt, 20000);
}

/**
 * Batch conflict check: check multiple rules at once against hand-written CLAUDE.md.
 * Returns: { results: [{ rule: string, decision: 'new'|'conflict'|'duplicate', reason: string, conflicts_with: string }] }
 */
function checkConflictBatch(newRules, handWrittenContent) {
  if (!newRules || newRules.length === 0) return { results: [] };
  // Single rule: use existing single check
  if (newRules.length === 1) {
    const result = checkConflict(newRules[0], handWrittenContent);
    return { results: [{ index: 0, rule: newRules[0], ...(result || { decision: 'new', reason: 'check failed' }) }] };
  }

  const rulesDesc = newRules.map((r, i) => `[${i}] ${r}`).join('\n');

  const prompt = `You are a conflict detector. Compare each NEW rule against EXISTING hand-written rules in CLAUDE.md.

NEW RULES:
${rulesDesc.slice(0, 4000)}

EXISTING HAND-WRITTEN RULES:
${(handWrittenContent || '').slice(0, 3000)}

For each new rule, decide:
- "duplicate" if it says essentially the same thing as an existing rule (even in a different language)
- "conflict" if it contradicts an existing rule
- "new" if it covers a genuinely different topic

Reply with ONLY this JSON (no markdown, no explanation):
{
  "results": [
    {"index": 0, "decision": "new|conflict|duplicate", "reason": "<one sentence>", "conflicts_with": "<existing rule text or empty>"}
  ]
}`;

  return askClaudeWithRetry(prompt, 30000, 'fast');
}

/**
 * Check if a new user correction is about the same topic as an existing auto-learned rule.
 * Used for fitness evaluation.
 * Returns: { matches: [{ rule_id: string, confidence: 'high' | 'medium' | 'none' }] }
 */
function matchCorrections(correctionTexts, existingRules) {
  if (!correctionTexts.length || !existingRules.length) {
    return { matches: [] };
  }

  const rulesDesc = existingRules.map(r =>
    `[${r.id}] ${r.content}`
  ).join('\n');

  const correctionsDesc = correctionTexts.map((t, i) =>
    `[corr_${i}] ${t.slice(0, 200)}`
  ).join('\n');

  const prompt = `You are a topic matcher. Determine if any NEW CORRECTIONS are about the same topic as any EXISTING RULES.

A match means the user is correcting the SAME behavior that the rule was supposed to fix — the rule failed.

EXISTING AUTO-LEARNED RULES:
${rulesDesc}

NEW CORRECTIONS THIS SESSION:
${correctionsDesc}

For each existing rule, determine if any correction matches it.
Reply with ONLY this JSON (no markdown, no explanation):
{
  "matches": [
    {"rule_id": "<id>", "correction_index": <index or -1 if no match>, "confidence": "high|medium|none"}
  ]
}`;

  return askClaudeWithRetry(prompt, 25000, 'fast');
}

/**
 * Attempt to distill/merge similar rules into a consolidated version.
 * Returns: { should_distill: boolean, merged_rule?: string, merged_keywords?: string[], source_ids?: string[] }
 */
function tryDistill(rules) {
  if (rules.length < 3) return { should_distill: false };

  const rulesDesc = rules.map(r =>
    `[${r.id}] (fitness=${r.fitness}) ${r.content}`
  ).join('\n');

  const prompt = `You are a rule consolidation engine. Given these auto-learned rules, determine if any group of 3+ rules can be merged into a single, more concise rule.

RULES:
${rulesDesc}

Only merge rules that cover genuinely overlapping topics. Don't force merges.

Reply with ONLY this JSON (no markdown, no explanation):
{
  "should_distill": true|false,
  "groups": [
    {
      "source_ids": ["<rule_ids to merge>"],
      "merged_rule": "<the consolidated rule text>",
      "merged_keywords": ["<key terms>"]
    }
  ]
}

If no merge is warranted, reply: {"should_distill": false, "groups": []}`;

  return askClaudeWithRetry(prompt, 30000, 'smart');
}

/**
 * Check if a pending conflict should be auto-resolved.
 * Used when the user hasn't explicitly resolved a conflict after N sessions.
 */
function suggestConflictResolution(conflict, handWrittenContent) {
  const prompt = `A conflict was detected between an auto-learned rule and existing hand-written rules.

AUTO-LEARNED RULE: ${conflict.new_content}
HAND-WRITTEN RULE IT CONFLICTS WITH: ${conflict.conflicts_with}

FULL HAND-WRITTEN CLAUDE.MD:
${handWrittenContent.slice(0, 2000)}

What should the user do?
Reply with ONLY this JSON:
{
  "suggestion": "keep_existing|update_handwritten|accept_both",
  "reason": "<one sentence>",
  "proposed_update": "<if update_handwritten, what should the hand-written rule say instead; empty otherwise>"
}`;

  return askClaudeWithRetry(prompt, 20000);
}

/**
 * Analyze session behavior patterns and cross-session consistency.
 * Identifies repeated workflows worth promoting to rules.
 * Returns: { patterns: [{ rule: string, keywords: string[], confidence: 'high'|'medium', evidence: string }] }
 */
function analyzeSessionPatterns(sessionBehavior, recentSessions, existingRules) {
  if (!sessionBehavior || sessionBehavior.toolCalls < 3) {
    return { patterns: [] };
  }

  const currentSession = `
Tool calls: ${sessionBehavior.toolCalls}
Tool counts: ${JSON.stringify(sessionBehavior.toolCounts)}
Tool sequence: ${sessionBehavior.toolSequence.slice(0, 30).join(' → ')}
Workflow phases: ${sessionBehavior.workflowPhases.join(' → ')}
DB tables: ${sessionBehavior.dbTables.join(', ') || 'none'}
DB dry runs: ${sessionBehavior.dbDryRuns}
MCP tools: ${sessionBehavior.mcpTools.join(', ') || 'none'}`.trim();

  const pastSessions = (recentSessions || []).slice(-8).map((s, i) => {
    return `Session ${i + 1} (${s.timestamp ? s.timestamp.slice(0, 10) : '?'}): tools=${s.tool_calls}, top=${(s.top_tools || []).join(', ')}, bq=${s.db_queries || 0}, amp=${s.mcp_queries || 0}`;
  }).join('\n');

  const existingRulesDesc = (existingRules || []).map(r =>
    `- ${r.content.slice(0, 100)}`
  ).join('\n') || '(none)';

  const prompt = `Behavior pattern analyzer. Find ACTIONABLE patterns from session data that should become rules.

A good rule is an instruction that changes behavior: "always do X before Y", "use A instead of B", "check C when doing D".
Bad rules: observations about tool usage stats ("Bash is 40%"), obvious facts, or non-actionable descriptions.
Max 3 rules. Only report patterns repeated across sessions. Skip existing rules.

CURRENT SESSION:
${currentSession}

PAST SESSIONS:
${pastSessions || '(none)'}

EXISTING RULES:
${existingRulesDesc}

Reply JSON only:
{"patterns": [{"rule": "<actionable instruction>", "keywords": ["<terms>"], "confidence": "high|medium", "evidence": "<what you observed>"}]}

No patterns? Reply: {"patterns": []}`;

  return askClaudeWithRetry(prompt, 30000, 'smart');
}

/**
 * Select a processing strategy based on session characteristics.
 * Returns: { strategy: 'repair'|'reinforce'|'explore'|'distill', reason: string, params: {} }
 */
function selectStrategy(sessionBehavior, newMemories, recentSessions, existingRules) {
  const memCount = (newMemories || []).length;
  const ruleCount = (existingRules || []).length;
  const sessionCount = (recentSessions || []).length;
  const toolCalls = sessionBehavior ? sessionBehavior.toolCalls : 0;

  const prompt = `Strategy selector for a learning system. Pick ONE strategy for this session.

Strategies:
- "repair": User made corrections this session. Focus on fixing/adding rules from corrections. Be aggressive with new rules.
- "reinforce": No corrections, user iterated productively. Strengthen existing rules (+fitness). Cautiously observe behavior patterns.
- "explore": Session looks different from recent history (new tools, new workflow). Observe only, don't create rules yet — wait for patterns to repeat.
- "distill": Many active rules accumulated, system is stable. Focus on merging and simplifying rules.

SESSION DATA:
- Corrections this session: ${memCount}
- Tool calls: ${toolCalls}
- Active rules: ${ruleCount}
- Past sessions in history: ${sessionCount}
- Workflow phases: ${sessionBehavior ? sessionBehavior.workflowPhases.join('→') : 'unknown'}
- DB tables: ${sessionBehavior ? (sessionBehavior.dbTables || []).join(', ') || 'none' : 'unknown'}

Reply JSON only:
{"strategy": "<one of: repair|reinforce|explore|distill>", "reason": "<one sentence>"}`;

  return askClaudeWithRetry(prompt, 25000);
}

/**
 * Reflect on all active rules: what's working, what's failing, contradictions.
 * Called every N sessions for meta-learning.
 * Returns: { insights: [{ action: 'keep'|'revise'|'merge'|'remove', rule_ids: string[], reason: string, revised_content?: string }] }
 */
function reflectOnRules(activeRules, recentNarratives, recentChangelog) {
  if (!activeRules || activeRules.length === 0) return { insights: [] };

  const rulesDesc = activeRules.map(r =>
    `[${r.id}] fitness=${r.fitness} sessions=${r.sessions_evaluated} src=${r.source} | ${r.content.slice(0, 120)}`
  ).join('\n');

  const narrativeDesc = (recentNarratives || []).slice(-5).map(n =>
    `${n.timestamp ? n.timestamp.slice(0, 10) : '?'}: ${n.narrative}`
  ).join('\n') || '(no narrative history)';

  const changeDesc = (recentChangelog || []).slice(-10).map(c =>
    `${c.action}: ${(c.content || c.reason || '').slice(0, 60)}`
  ).join('\n') || '(no recent changes)';

  const prompt = `Rule reflection engine. Review all active auto-learned rules and provide meta-insights.

ACTIVE RULES:
${rulesDesc}

RECENT SESSION NARRATIVES:
${narrativeDesc}

RECENT CHANGES:
${changeDesc}

For each insight, suggest one action:
- "keep": rule is working well (high fitness, no issues)
- "revise": rule is partially right but needs rewording (explain how)
- "merge": two+ rules overlap and should be combined
- "remove": rule is not useful or contradicts reality

Only suggest actions that improve the rule set. Don't force changes.

Reply JSON only:
{"insights": [{"action": "keep|revise|merge|remove", "rule_ids": ["<ids>"], "reason": "<why>", "revised_content": "<new text if revise, empty otherwise>"}]}`;

  return askClaudeWithRetry(prompt, 30000, 'smart');
}

/**
 * Generate a narrative summary of the session (2-3 sentences).
 * Not stats — a story of what happened.
 * Returns: { narrative: string }
 */
function narrateSession(sessionBehavior, newMemories, existingRules) {
  const tools = sessionBehavior ? JSON.stringify(sessionBehavior.toolCounts) : '{}';
  const phases = sessionBehavior ? sessionBehavior.workflowPhases.join('→') : 'unknown';
  const bq = sessionBehavior ? (sessionBehavior.dbTables || []).join(', ') : 'none';
  const corrections = (newMemories || []).map(m => m.name).join(', ') || 'none';

  const prompt = `Write a 2-3 sentence narrative summary of this coding session. Write like a brief journal entry — what the user worked on, what tools they used, what they achieved or learned. Not stats.

Tool usage: ${tools}
Workflow: ${phases}
DB tables: ${bq || 'none'}
Corrections made: ${corrections}
Total tool calls: ${sessionBehavior ? sessionBehavior.toolCalls : 0}

Reply JSON only:
{"narrative": "<2-3 sentence summary>"}`;

  return askClaudeWithRetry(prompt, 25000);
}

// ===================== Observation-based Learning =====================

/**
 * Analyze full session observations to extract behavior patterns and learnable rules.
 * This is the core of "learn from everything, not just corrections".
 *
 * @param {Array} observations - Full observation records from post-tool.js temp file
 * @param {Array} existingRules - Current active rules (to avoid duplicates)
 * @param {string} handWrittenContent - Hand-written CLAUDE.md content
 * @returns {{ patterns: Array, anti_patterns: Array, summary: string, index_line: string }}
 */
function analyzeObservations(observations, existingRules, handWrittenContent) {
  if (!observations || observations.length < 3) {
    return { patterns: [], anti_patterns: [], summary: '', index_line: '' };
  }

  // Build a readable timeline from observations
  const timeline = observations.map(obs => {
    const time = new Date(obs.ts).toTimeString().slice(0, 5);
    const input = (obs.input || '').slice(0, 300);
    const output = (obs.output || '').slice(0, 200);
    const tag = obs.type ? ` [${obs.type}]` : '';
    return `[${time}] ${obs.tool}${tag}: ${input}${output ? ' → ' + output : ''}`;
  }).join('\n');

  const existingRulesDesc = (existingRules || []).map(r =>
    `- ${r.content.slice(0, 100)}`
  ).join('\n') || '(none)';

  const handWrittenDesc = (handWrittenContent || '').slice(0, 1500);

  const prompt = `You are a behavior analysis engine. Analyze a full session timeline to extract learnable patterns.

SESSION TIMELINE (${observations.length} tool calls):
${timeline.slice(0, 8000)}

EXISTING AUTO-LEARNED RULES:
${existingRulesDesc}

HAND-WRITTEN CLAUDE.MD RULES:
${handWrittenDesc.slice(0, 1500)}

Analyze the timeline and extract:

1. **patterns**: Repeated positive behaviors worth reinforcing as rules (e.g., "always dry_run before database query", "Read file before Edit"). Must be actionable instructions, NOT observations. Skip anything already covered by existing rules or CLAUDE.md.

2. **anti_patterns**: Mistakes or suboptimal behaviors (e.g., "Edit without Read first", "database query without date filter", "large query without dry_run"). These are candidates for corrective rules.

3. **summary**: 3-5 bullet point summary of what happened this session (for persistent memory).

4. **index_line**: One-line session summary under 100 chars (for the memory index).

Reply JSON only:
{
  "patterns": [{"rule": "<actionable instruction>", "keywords": ["<terms>"], "confidence": "high|medium|low", "evidence": "<what in the timeline supports this>"}],
  "anti_patterns": [{"rule": "<corrective instruction>", "keywords": ["<terms>"], "confidence": "high|medium|low", "evidence": "<what went wrong>"}],
  "summary": "<3-5 bullet points>",
  "index_line": "<one-line summary>"
}

No patterns found? Return empty arrays. Be conservative — only report clear, repeated, actionable patterns.`;

  return askClaudeWithRetry(prompt, 45000, 'smart');
}

/**
 * Compress full observations into a session summary .md for persistent storage.
 * The raw observations are deleted after this.
 *
 * @param {Array} observations - Full observation records
 * @param {Array} newMemories - Feedback memories from this session
 * @param {Array} rulesChanged - Rules added/pruned/distilled this session
 * @returns {{ summary: string, key_decisions: string, index_line: string }}
 */
function compressSession(observations, newMemories, rulesChanged) {
  if (!observations || observations.length === 0) {
    return { summary: '', key_decisions: '', index_line: '' };
  }

  const timeline = observations.map(obs => {
    const time = new Date(obs.ts).toTimeString().slice(0, 5);
    const input = (obs.input || '').slice(0, 300);
    const output = (obs.output || '').slice(0, 150);
    const tag = obs.type ? ` [${obs.type}]` : '';
    return `[${time}] ${obs.tool}${tag}: ${input}${output ? ' → ' + output : ''}`;
  }).join('\n');

  const memoriesDesc = (newMemories || []).map(m =>
    `- ${m.name}: ${(m.content || '').slice(0, 100)}`
  ).join('\n') || '(none)';

  const rulesDesc = (rulesChanged || []).map(r =>
    `- [${r.action}] ${(r.content || '').slice(0, 80)}`
  ).join('\n') || '(none)';

  const prompt = `Compress a coding session into a structured summary for long-term memory.

SESSION TIMELINE (${observations.length} tool calls):
${timeline.slice(0, 10000)}

USER CORRECTIONS THIS SESSION:
${memoriesDesc}

RULE CHANGES THIS SESSION:
${rulesDesc}

Generate a structured summary:

1. **summary**: 3-5 bullet points of what happened (tasks worked on, tools used, outcomes).
2. **key_decisions**: Any decisions made, approaches chosen, or trade-offs discussed. Empty if none.
3. **index_line**: One-line summary under 100 chars for the session index.

Write in the same language the user used in the session.

Reply JSON only:
{
  "summary": "- bullet 1\\n- bullet 2\\n- bullet 3",
  "key_decisions": "- decision 1\\n- decision 2",
  "index_line": "<one-line summary>"
}`;

  return askClaudeWithRetry(prompt, 35000, 'smart');
}

// ===================== GA Operators =====================

/**
 * Evaluate relevance of each active rule to a session.
 * For each rule, determines: relevant? followed? corrected?
 * This is the core fitness signal — only relevant rules get scored.
 *
 * @param {Array} activeRules - Current active rules
 * @param {Array} observations - Session observation timeline
 * @param {Array} corrections - New correction memories from this session
 * @returns {{ evaluations: [{ rule_id, relevant, followed, corrected }] }}
 */
function evaluateRelevance(activeRules, observations, corrections) {
  if (!activeRules || activeRules.length === 0) return { evaluations: [] };

  const rulesDesc = activeRules.map(r =>
    `[${r.id}] ${r.content.slice(0, 150)}`
  ).join('\n');

  const timeline = (observations || []).slice(-20).map(obs => {
    const input = (obs.input || '').slice(0, 200);
    return `${obs.tool}: ${input}`;
  }).join('\n');

  const corrDesc = (corrections || []).map(c =>
    `- ${c.name || ''}: ${(c.description || c.content || '').slice(0, 100)}`
  ).join('\n') || '(none)';

  const prompt = `GA fitness evaluator. For each rule, determine if it was RELEVANT to this session, and if so, whether the user's behavior FOLLOWED it.

RULES:
${rulesDesc}

SESSION BEHAVIOR (tool calls):
${timeline || '(empty session)'}

USER CORRECTIONS THIS SESSION:
${corrDesc}

For each rule:
- "relevant": was the rule's topic active in this session? (e.g., a rule about "Read before Edit" is relevant if Edit was used)
- "followed": did the user's behavior match the rule? (e.g., did they actually Read before Edit?)
- "corrected": did any correction explicitly address the same topic as this rule?

Reply JSON only:
{"evaluations": [{"rule_id": "<id>", "relevant": true/false, "followed": true/false, "corrected": false}]}`;

  return askClaudeWithRetry(prompt, 25000, 'fast');
}

/**
 * Crossover: combine two high-fitness rules into a new offspring rule.
 * The LLM synthesizes the best parts of both parents.
 *
 * @param {object} parentA - First parent rule
 * @param {object} parentB - Second parent rule
 * @returns {{ offspring: string, keywords: string[] } | null}
 */
function crossover(parentA, parentB) {
  const prompt = `GA crossover operator. Combine two successful rules into ONE new rule that captures the essence of both.

PARENT A (fitness=${parentA.fitness}): ${parentA.content}
PARENT B (fitness=${parentB.fitness}): ${parentB.content}

Create ONE offspring rule that:
- Combines the key insights from both parents
- Is more specific or more complete than either parent alone
- Is a single actionable instruction

Reply JSON only:
{"offspring": "<the new combined rule>", "keywords": ["<key terms>"]}

If the parents are too different to meaningfully combine, reply: {"offspring": "", "keywords": []}`;

  return askClaudeWithRetry(prompt, 20000, 'smart');
}

/**
 * Mutation: create a variant of an existing rule.
 * The LLM rewrites it slightly differently — maybe more specific, broader, or rephrased.
 *
 * @param {object} rule - The rule to mutate
 * @returns {{ mutant: string, keywords: string[], mutation_type: string } | null}
 */
function mutate(rule) {
  const prompt = `GA mutation operator. Create a VARIANT of this rule. Change it in ONE of these ways:
- Specialize: make it more specific (add a condition or context)
- Generalize: make it broader (remove unnecessary constraints)
- Rephrase: say the same thing differently (might be clearer)
- Strengthen: add consequences or emphasis

ORIGINAL RULE (fitness=${rule.fitness}): ${rule.content}

Reply JSON only:
{"mutant": "<the modified rule>", "keywords": ["<key terms>"], "mutation_type": "specialize|generalize|rephrase|strengthen"}`;

  return askClaudeWithRetry(prompt, 20000, 'fast');
}

/**
 * Batch evaluation: determine relevance + compliance for all active rules in one call.
 * More efficient than calling evaluateRelevance per-rule.
 */
function evaluateGeneration(activeRules, recentSessionSummaries) {
  if (!activeRules || activeRules.length === 0) return { rankings: [] };

  const rulesDesc = activeRules.map(r =>
    `[${r.id}] fitness=${r.fitness} relevance=${r.relevance_count || 0} conf=${(r.fitness / Math.sqrt(Math.max(r.relevance_count || 1, 1))).toFixed(1)} | ${r.content.slice(0, 120)}`
  ).join('\n');

  const sessionsDesc = (recentSessionSummaries || []).slice(-5).map(s =>
    `- ${s}`
  ).join('\n') || '(no session data)';

  const prompt = `GA generation evaluator. Rank these rules by how useful they've been across recent sessions.

ACTIVE RULES:
${rulesDesc}

RECENT SESSION SUMMARIES:
${sessionsDesc}

For each rule, assign a rank from 1 (best) to N (worst) based on:
- Is it relevant to the user's actual work?
- Does it address a real, recurring need?
- Is its fitness justified by real evidence, or just untested?

Reply JSON only:
{"rankings": [{"rule_id": "<id>", "rank": N, "verdict": "strong|adequate|weak|untested"}]}`;

  return askClaudeWithRetry(prompt, 25000, 'smart');
}

module.exports = {
  askClaude,
  extractRule,
  checkConflict,
  matchCorrections,
  tryDistill,
  suggestConflictResolution,
  analyzeSessionPatterns,
  selectStrategy,
  reflectOnRules,
  analyzeObservations,
  compressSession,
  checkConflictBatch,
  // GA operators
  evaluateRelevance,
  crossover,
  mutate,
  evaluateGeneration,
};
