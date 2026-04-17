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

// Minimum timeout per tier (CLI startup takes 5-10s)
const MIN_TIMEOUT = { fast: 30000, smart: 45000 };

/**
 * Call askClaude with retry and exponential backoff.
 * Enforces minimum timeout per tier to account for CLI startup overhead.
 */
function askClaudeWithRetry(prompt, timeoutMs, tier, retries) {
  const effectiveTier = tier || 'fast';
  const effectiveTimeout = Math.max(timeoutMs || 30000, MIN_TIMEOUT[effectiveTier] || 30000);
  const maxRetries = retries || 1;

  for (let i = 0; i <= maxRetries; i++) {
    const result = askClaude(prompt, effectiveTimeout, effectiveTier);
    if (result !== null) return result;
    if (i < maxRetries) {
      // Exponential backoff: 3s, 6s, 12s...
      const backoff = 3000 * Math.pow(2, i);
      const { spawnSync } = require('child_process');
      spawnSync('sleep', [String(backoff / 1000)], { timeout: backoff + 2000 });
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
 * Used for score evaluation.
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
    `[${r.id}] (score=${r.score || 5}) ${r.content}`
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
 * Triage: LLM determines what happened, which gene to run, and complexity.
 * One cheap haiku call replaces both signal extraction and gene selection.
 * Complexity determines which model handles the gene execution.
 *
 * @param {Array} observations - Session timeline
 * @param {Array} newMemories - Correction memories
 * @param {number} activeRuleCount - Current active rules
 * @param {number} sessionCount - Total sessions so far
 * @param {number} highScoreRelatedGroups - Number of groups of 3+ related high-score rules
 * @returns {{ gene: string, complexity: 'routine'|'complex', reason: string }}
 */
function triage(observations, newMemories, activeRuleCount, sessionCount, highScoreRelatedGroups) {
  const corrCount = (newMemories || []).length;
  const obsCount = (observations || []).length;

  const toolSummary = {};
  for (const obs of (observations || []).slice(-30)) {
    toolSummary[obs.tool] = (toolSummary[obs.tool] || 0) + 1;
  }

  const corrNames = (newMemories || []).map(m => m.name || m.description || '').join(', ');

  const prompt = `Session triage. Determine what happened and what to do.

SESSION:
- Tool calls: ${obsCount}
- Tools used: ${JSON.stringify(toolSummary)}
- Corrections: ${corrCount}${corrCount > 0 ? ' (' + corrNames.slice(0, 200) + ')' : ''}
- Active rules: ${activeRuleCount}
- Session number: ${sessionCount}
- High-score rule groups: ${highScoreRelatedGroups || 0}

Pick ONE gene (check in this priority order):
1. "repair": corrections exist → extract rules from what the user corrected
2. "skillify": High-score rule groups > 0 → ALWAYS prefer this when mature rule groups exist. These rules have proven themselves over many sessions and should be promoted to a higher output format (workflow block or skill file). This is high-value work even if the session itself was quiet.
3. "innovate": no corrections but significant work (5+ tool calls) → find patterns and anti-patterns from behavior
4. "optimize": periodic check (every ~3 sessions) → evaluate existing rules, score and demote bad ones
5. "cleanup": 8+ active rules → merge, simplify, remove redundant rules
6. "observe": trivial session (< 3 tool calls) AND no high-score groups → just record, do nothing

Pick complexity:
- "routine": simple correction, minor observation, standard cleanup
- "complex": fundamental methodology change, new workflow pattern, conflicting corrections, major rule restructuring

Reply JSON only:
{"gene": "repair|innovate|optimize|cleanup|skillify|observe", "complexity": "routine|complex", "reason": "<one sentence>"}`;

  return askClaudeWithRetry(prompt, 20000, 'fast');
}

// Legacy compat
function selectStrategy(sessionBehavior, newMemories, recentSessions, existingRules) {
  return triage([], newMemories, (existingRules || []).length, (recentSessions || []).length);
}

/**
 * Reflect on all active rules: what's working, what's failing, contradictions.
 * Called every N sessions for meta-learning.
 * Returns: { insights: [{ action: 'keep'|'revise'|'merge'|'remove', rule_ids: string[], reason: string, revised_content?: string }] }
 */
function reflectOnRules(activeRules, recentNarratives, recentChangelog) {
  if (!activeRules || activeRules.length === 0) return { insights: [] };

  const rulesDesc = activeRules.map(r =>
    `[${r.id}] score=${r.score || 5} sessions=${r.sessions_evaluated} src=${r.source} | ${r.content.slice(0, 120)}`
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
- "keep": rule is working well (high score, no issues)
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

// ===================== Signal-Gene Operators =====================

/**
 * Evaluate all active rules in one LLM call.
 * Scores each rule 0-10 based on relevance and usefulness to the session.
 * Also suggests dormant rules to revive if relevant.
 *
 * @param {Array} activeRules
 * @param {Array} observations - Session timeline
 * @param {Array} corrections - Feedback memories
 * @returns {{ evaluations: [{ rule_id, score: 0-10, reason }], revive: [rule_id] }}
 */
function evaluateRuleSet(activeRules, observations, corrections) {
  if (!activeRules || activeRules.length === 0) return { evaluations: [], revive: [] };

  const rulesDesc = activeRules.map(r =>
    `[${r.id}] (current score: ${r.score || 5}) ${r.content.slice(0, 150)}`
  ).join('\n');

  const timeline = (observations || []).slice(-20).map(obs => {
    const input = (obs.input || '').slice(0, 200);
    return `${obs.tool}: ${input}`;
  }).join('\n');

  const corrDesc = (corrections || []).map(c =>
    `- ${c.name || ''}: ${(c.description || c.content || '').slice(0, 100)}`
  ).join('\n') || '(none)';

  const prompt = `Rule evaluator. Score each rule 0-10 based on this session.

Scoring guide:
- 10: Rule was directly relevant and the user followed it perfectly
- 7-9: Rule was relevant and mostly followed
- 5: Rule was not relevant to this session (neutral, no evidence either way)
- 3-4: Rule was relevant but the user's behavior contradicted it
- 0-2: Rule was relevant AND the user was explicitly corrected on the same topic (rule failed)

RULES:
${rulesDesc}

SESSION (tool calls):
${timeline || '(empty)'}

CORRECTIONS:
${corrDesc}

Reply JSON only:
{"evaluations": [{"rule_id": "<id>", "score": N, "reason": "<one sentence>"}], "revive": []}`;

  return askClaudeWithRetry(prompt, 25000, 'fast');
}

/**
 * Classify the complexity level of a rule for output routing.
 * Determines whether a rule belongs in CLAUDE.md or a skill file.
 *
 * @param {{ content: string, keywords: string[], score: number }} rule - The rule to classify
 * @param {Array} existingRules - Currently active rules (for related-rule detection)
 * @param {string} projectType - Project type string (e.g., 'node', 'python')
 * @returns {'simple'|'compound'|'workflow'|'methodology'}
 */
function classifyComplexity(rule, existingRules, projectType) {
  // Count related existing rules (jaccard > 0.3 on keywords, score > 7)
  const ruleEngine = require('./ruleEngine');
  const relatedHighScore = (existingRules || []).filter(r =>
    r.id !== rule.id &&
    (r.score || 0) > 7 &&
    ruleEngine.jaccardSimilarity(r.keywords || [], rule.keywords || []) > 0.3
  );

  const relatedHint = relatedHighScore.length >= 3
    ? `\nNOTE: There are ${relatedHighScore.length} related existing rules (keyword overlap > 0.3, all score > 7). This is evidence for workflow or methodology level.`
    : '';

  const existingDesc = (existingRules || []).slice(0, 15).map(r =>
    `[${r.id}] (score=${r.score || 5}) ${r.content.slice(0, 100)}`
  ).join('\n');

  const prompt = `Classify the complexity level of this auto-learned rule.

RULE:
${rule.content}

Keywords: ${(rule.keywords || []).join(', ')}
Score: ${rule.score || 5}
Project type: ${projectType || 'unknown'}

EXISTING ACTIVE RULES:
${existingDesc || '(none)'}
${relatedHint}

Complexity levels (choose the HIGHEST level that fits):
- "simple": single actionable instruction (e.g., "Always Read before Edit")
- "compound": 2-3 related sub-instructions that belong together (e.g., "When doing BQ analysis: dry_run first, filter by partition, confirm time range")
- "workflow": ordered multi-step process with clear sequence (e.g., "1. Define base 2. Check sources 3. Write query 4. Validate")
- "methodology": 3+ related rules that together form a coherent practice for a specific domain. If the input contains multiple rules about the SAME topic (e.g., all about BQ analysis, all about testing, all about deployment), classify as methodology. A methodology doesn't need to span multiple workflows — it needs to capture HOW someone approaches a class of problems.

IMPORTANT: When classifying a GROUP of related rules (not a single rule), lean toward "workflow" or "methodology". Groups of 3+ related high-score rules are strong evidence of an emerging methodology.

Reply JSON only:
{"complexity": "simple|compound|workflow|methodology", "reason": "<one sentence>"}`;

  const result = askClaudeWithRetry(prompt, 20000, 'fast');

  if (result && result.complexity &&
      ['simple', 'compound', 'workflow', 'methodology'].includes(result.complexity)) {
    return result.complexity;
  }

  // Safe fallback on LLM failure
  return 'simple';
}

/**
 * Cleanup: merge, rewrite, or remove rules.
 * Called when there are too many active rules.
 *
 * @param {Array} activeRules
 * @returns {{ actions: [{ type: 'merge'|'rewrite'|'remove', ... }] }}
 */
function cleanupRules(activeRules) {
  if (!activeRules || activeRules.length < 5) return { actions: [] };

  const rulesDesc = activeRules.map(r =>
    `[${r.id}] (score: ${r.score || 5}, evals: ${r.relevance_count || 0}) ${r.content}`
  ).join('\n');

  const prompt = `Rule cleanup. This project has too many rules. Simplify.

RULES:
${rulesDesc}

Actions you can take:
- merge: combine 2+ overlapping rules into one clearer rule
- rewrite: improve a rule's wording without changing its meaning
- remove: drop a rule that's redundant, too vague, or unhelpful

Only suggest actions that genuinely improve the rule set. Don't force changes.

Reply JSON only:
{"actions": [
  {"type": "merge", "source_ids": ["<ids>"], "merged_rule": "<new text>", "keywords": ["<terms>"]},
  {"type": "rewrite", "rule_id": "<id>", "new_content": "<improved text>"},
  {"type": "remove", "rule_id": "<id>", "reason": "<why>"}
]}

No changes needed? Reply: {"actions": []}`;

  return askClaudeWithRetry(prompt, 25000, 'smart');
}

/**
 * Generate a complete Claude Code skill file from a group of related methodology rules.
 * Uses Claude's native understanding of the skill format to produce high-quality output.
 * Incorporates user memories (corrections, preferences, project context) to infer
 * the user's THINKING PATTERNS, not just the steps they follow.
 *
 * @param {Array} rules - Group of related rules forming a methodology
 * @param {string} projectType - Project type (e.g., 'analysis', 'backend')
 * @param {string} slug - Skill slug for the name field
 * @param {Array} [memories] - User/feedback/project memories for thinking pattern inference
 * @param {Array} [sessionNarratives] - Recent session summaries for context
 * @returns {{ content: string } | null} The full skill file content, or null on failure
 */
function generateSkillContent(rules, projectType, slug, memories, sessionNarratives) {
  if (!rules || rules.length === 0) return null;

  const rulesDesc = rules.map((r, i) =>
    `${i + 1}. ${r.content}`
  ).join('\n');

  const keywords = [...new Set(rules.flatMap(r => r.keywords || []))];
  const sessionsObserved = Math.max(...rules.map(r => r.sessions_evaluated || 0));

  // Build memory context for thinking pattern inference
  let memoryContext = '';
  if (memories && memories.length > 0) {
    const feedbacks = memories.filter(m => m.type === 'feedback').slice(-10);
    const userPrefs = memories.filter(m => m.type === 'user').slice(-5);
    const projectCtx = memories.filter(m => m.type === 'project').slice(-5);

    if (feedbacks.length > 0) {
      memoryContext += '\nUSER CORRECTIONS (things the user explicitly told Claude to do differently):\n';
      memoryContext += feedbacks.map(m => `- ${m.name}: ${m.content.slice(0, 200)}`).join('\n');
    }
    if (userPrefs.length > 0) {
      memoryContext += '\nUSER PREFERENCES (how this user likes to work):\n';
      memoryContext += userPrefs.map(m => `- ${m.name}: ${m.content.slice(0, 200)}`).join('\n');
    }
    if (projectCtx.length > 0) {
      memoryContext += '\nPROJECT CONTEXT (domain knowledge):\n';
      memoryContext += projectCtx.map(m => `- ${m.name}: ${m.content.slice(0, 200)}`).join('\n');
    }
  }

  let narrativeContext = '';
  if (sessionNarratives && sessionNarratives.length > 0) {
    narrativeContext = '\nRECENT SESSION STORIES (what happened in past sessions):\n';
    narrativeContext += sessionNarratives.slice(-5).map(n =>
      `- ${n.timestamp ? n.timestamp.slice(0, 10) : '?'}: ${(n.summary || n.narrative || '').slice(0, 200)}`
    ).join('\n');
  }

  const prompt = `You are generating a Claude Code skill file that captures a user's THINKING PATTERNS, not just steps.

This user has worked on a "${projectType}" project for ${sessionsObserved} sessions. From observing their behavior, these ${rules.length} rules emerged:

OBSERVED RULES (what the user consistently does):
${rulesDesc}
${memoryContext}
${narrativeContext}

YOUR JOB: Infer the user's underlying THINKING MODEL from these rules, corrections, and preferences. Don't just list the rules as steps. Figure out:
- WHY they do things in this order (what's the mental model?)
- What they care about MOST (cost? correctness? speed? safety?)
- What they do PROACTIVELY without being asked
- What mistakes they've corrected Claude on (these reveal values)
- Hidden assumptions they make that Claude should also make

Generate a Claude Code SKILL.md with:

1. YAML frontmatter:
   - name: "auto-${slug}"
   - description: 2-3 lines explaining the THINKING APPROACH (not just "this skill does X")
   - triggers: 3-5 natural trigger phrases

2. A "## Thinking Model" section:
   Instead of numbered steps, describe the user's DECISION-MAKING PATTERNS.
   Write as instructions to Claude: "When the user asks you to do X, here's how they think about it..."
   Use patterns like:
   - "This user prioritizes X over Y. Always check X first."
   - "Don't wait to be asked — proactively do Z because this user always wants it."
   - "When results look off, this user expects you to catch it yourself."

3. A "## Workflow" section:
   The concrete steps, but written as a natural workflow with decision points, not a rigid checklist.
   Include conditional branches: "If X, then do Y. Otherwise, Z."

4. A "## What NOT to do" section:
   Anti-patterns inferred from corrections and observations. Things Claude should avoid.

FORMAT RULES:
- Start with --- for YAML frontmatter
- Write in the same language as the rules
- Keep under 100 lines
- Sound like a mentor briefing a colleague, not a manual
- Be specific: use real table names, tool names, thresholds from the rules

Output ONLY the raw file content starting with ---. No explanation.`;

  const result = askClaudeWithRetry(prompt, 45000, 'smart');

  if (!result) return null;

  // The LLM should return raw content, but might wrap in { raw: "..." }
  let content = '';
  if (typeof result === 'string') {
    content = result;
  } else if (result.raw) {
    content = result.raw;
  } else {
    // Try to extract from JSON if LLM wrapped it
    content = JSON.stringify(result);
  }

  // Validate: must start with --- (YAML frontmatter)
  content = content.trim();
  if (!content.startsWith('---')) {
    // Try to find the --- in the content (LLM might have added explanation before)
    const idx = content.indexOf('---');
    if (idx !== -1) {
      content = content.slice(idx);
    } else {
      return null; // Can't salvage
    }
  }

  return { content };
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
  // Signal-gene operators
  triage,
  evaluateRuleSet,
  cleanupRules,
  // Continuum writer
  classifyComplexity,
  generateSkillContent,
};
