# claude-evolve

Claude Code watches what you do. claude-evolve watches what Claude Code does. It finds the mistakes and habits that repeat, and writes them back as rules for your next session. A rule that keeps paying off can grow into a full Claude Code skill. A rule nobody uses fades out.

Before you install it, here's what it needs and what it does to your machine.

- Needs: the `claude` CLI on your PATH, Node 18 or newer, and macOS or Linux.
- Costs: one background run when a session ends, usually 3 to 8 `claude --print` calls. Haiku does triage and classification. Sonnet writes the session summary, handles complex sessions and writes skills. A failed call is retried once. Sessions with fewer than 3 tool calls and no new memory are skipped. The calls use your own `claude` login. `runs.jsonl` logs the exact count of every run.
- Writes: `CLAUDE.local.md` and `.claude/skills/auto-*/` in your project folder: the git top level inside a repo, the launch folder outside one. It also writes a data directory (`learning/data/` by default) and three hook entries in `~/.claude/settings.json`, which it backs up first.
- Sends: redacted excerpts of your tool calls, plus your rules, memories and instruction files, to Anthropic through `claude --print`. [Details below](#what-it-reads-sends-and-writes).

## Install

```bash
git clone https://github.com/jack60810/claude-evolve.git
cd claude-evolve
node setup.js
node setup.js --check
```

It isn't on npm. The `claude-evolve` package there is a different project, so install from git.

`setup.js` adds three hooks to `~/.claude/settings.json`: SessionStart, PostToolUse and SessionEnd. Your other settings and hooks stay as they are. Before it writes, it saves a copy next to the file as `settings.json.bak-<timestamp>`. If the file isn't valid JSON, it stops and changes nothing. Running it twice is safe. `--check` lists each hook with its event and exits 1 when something is missing.

Keep the clone where it is, because the hooks point at its path. If you move it, run `node setup.js` again to rewrite the paths. To update, run `git pull`. Then start a new Claude Code session.

Each hook takes about 50 ms. The slow work happens in a detached process after the session ends.

### Uninstall

```bash
node setup.js --remove
```

This takes the hooks out of settings and leaves everything else. To wipe the rest, delete `CLAUDE.local.md` and `.claude/skills/auto-*` in your projects, and the data directory.

### Upgrading from an older version

Older versions put the end-of-session hook on Stop, which fires after every response. They also wrote rule blocks into the CLAUDE.md of whatever folder you started in. `node setup.js` moves the hook to SessionEnd. For the leftover blocks:

```bash
node setup.js --clean-stale          # dry run, writes nothing
node setup.js --clean-stale --yes    # applies it
```

It removes the blocks in your home folder, in its parents, in ignored folders and in subfolders of a git repo. For every other block, it rebuilds the block in `CLAUDE.local.md` from the rules that are active in the store right now. Rules that are dormant there don't come along, so an old block can shrink or vanish. Every file it touches is copied to `<data dir>/backups/clean-stale-<timestamp>/` first.

The first run after an upgrade also does some housekeeping:

- It migrates the rule store and keeps the old file as `rules.v2.bak.json`.
- It archives retired rules and candidates older than 30 days to `rules_archive.jsonl`.
- It drops pending files older than 7 days.
- It prunes session summaries beyond 90 days or the newest 500.
- The first time it edits an existing CLAUDE.md, it copies the original to `<data dir>/backups/writer/`. Then it moves the auto block to `CLAUDE.local.md`.

<details>
<summary>Manual setup, if you'd rather edit the JSON</summary>

Add these to `~/.claude/settings.json` and merge them into any hooks you already have. Use the absolute path to your clone.

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 3,
      "command": "node \"/FULL/PATH/TO/claude-evolve/learning/hooks/session-start.js\"" }] }],
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 2,
      "command": "node \"/FULL/PATH/TO/claude-evolve/learning/hooks/post-tool.js\"" }] }],
    "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 8,
      "command": "node \"/FULL/PATH/TO/claude-evolve/learning/hooks/session-end.js\"" }] }]
  }
}
```

</details>

## What it reads, sends and writes

What it reads on your machine:

- Every tool call in a session. That's the tool name, the input (cut at 2,000 characters) and the output (cut at 4,000).
- Your Claude Code memories for the project, from `~/.claude/projects/<project>/memory`. New feedback memories are the source of corrections.
- Your instruction files: CLAUDE.md and CLAUDE.local.md from the project folder up to `/`, and `~/.claude/CLAUDE.md`. They feed the contradiction check.
- Only when you run `eval/events.js`: your Claude Code transcripts in `~/.claude/projects`. Nothing from them is sent anywhere.

What it sends:

- Short excerpts of the session's tool calls go to Anthropic through `claude --print`, under your own login. So do the project's rules, your memories and your instruction text.
- Each call runs with tools off, in an empty temp folder. With `--safe-mode`, the child sees no CLAUDE.md, skills, plugins, hooks or MCP servers. It uses that flag when your CLI has it, and `--strict-mcp-config` when it doesn't. It also sets `CLAUDE_EVOLVE_CHILD=1`, so these runs are not recorded.
- Tool calls are redacted before they reach disk. `learning/redact.js` replaces private keys, `sk-` API keys, JWTs, and GitHub, GitLab, AWS, Slack, Notion and Google tokens. It also replaces Slack webhook URLs, passwords inside URLs, Bearer tokens and values stored under names like token, secret, password, api key or authorization. It's pattern matching, so an unusual secret can slip through. Instruction files and memories that existed before the session are sent as written, so keep secrets out of them.

What it writes:

- During a session: `claude-evolve-<session>.jsonl` in your temp folder, mode 0600. It's deleted when the session ends.
- In the project folder: `CLAUDE.local.md` and `.claude/skills/auto-<name>/SKILL.md`. Your home folder and its parents never get rules. Inside a git repo, both files go into `.git/info/exclude`, so git ignores them. Outside git, nothing is excluded. In `CLAUDE.local.md`, only the block between the claude-evolve markers is ours. To share rules with your team, set `RULES_FILENAME` to `'CLAUDE.md'` in `learning/claudeMdWriter.js`. That file is not excluded, and the rules come from your own sessions, so read them before you commit.
- In the data directory: the rule store (`rules.json` and a `.bak` copy), `rules_archive.jsonl` for pruned rules, and `changelog.jsonl`. `runs.jsonl` has one line per run with its LLM call and failure counts. `memory/` holds session summaries and a per-project index. Smaller files cover cross-project patterns, skill notices, your tool-usage profile and the logs.
- Limits: logs rotate to a `.1` file at around 1 MB. Session memories are pruned after 90 days or past the newest 500.
- In `~/.claude/settings.json`: the three hooks, nothing else.

How to turn it off:

- `node setup.js --remove` stops it everywhere.
- An empty `.claude-evolve-ignore` file in a folder skips that folder: no rules, no LLM calls. Subfolders don't inherit it, so it suits a container folder like `~/code` that you sometimes launch from. In a git repo, put it at the top level to skip the whole repo.
- `CLAUDE_EVOLVE_CHILD=1 claude` runs one session unobserved. The hooks exit at once when that variable is set.
- `CLAUDE_EVOLVE_DATA_DIR=/some/dir` moves the data directory. Set it in the environment Claude Code starts from, so every hook sees the same value. The demo and the tests use it too.

## See it in action

You can watch the loop learn a profession without using it for real:

```bash
node demo.js analyst      # or ios-engineer, game-developer, ml-ops, chef, random...
```

This one uses the real pipeline, so it needs the `claude` CLI and makes real calls, roughly 20 to 30 of them. It prints a time estimate, about 4 minutes with the defaults.

1. Claude (haiku by default) invents a profile for the profession and 3 work sessions of 8 tool calls each.
2. Each session goes through the same pipeline a real one would.
3. A real skill needs rules that came up in 5 or more sessions. If fewer than 3 rules are mature, the demo sets their scores by hand to stand in for that. Then the skillify step runs.
4. It prints `CLAUDE.local.md` and any `.claude/skills/auto-*/SKILL.md` it produced.

Flags: `--sessions=N` (default 3, up to 10), `--depth=N` (tool calls per session, 5 to 20, default 8), `--sequential`, and `--model=sonnet` for richer sessions.

The demo gets its own git repo and its own data directory under `demo-output/`, so your real learning data stays untouched. Delete `demo-output/` when you're done.

### Two example outputs (not for programmers)

Here are two skills the system produced from 3 simulated sessions each. Nobody wrote a template or a starter rule. Different jobs gave different thinking models.

<details>
<summary>Example 1: Kindergarten Principal (admin work: scheduling, classroom observations, budgets)</summary>

```markdown
---
name: auto-kindergarten-ops-discipline
description: >
  This user thinks in terms of "verify before commit" — never finalize anything
  without cross-checking all dependencies first. They prioritize correctness and
  accountability over speed, and expect proactive conflict detection, not reactive fixes.
triggers:
  - schedule parent conferences
  - staff duty assignments
  - classroom observation
  - field trip budget
  - enrollment tracker
---

## Thinking Model

This user's core mental model: **incomplete information = don't commit**. Every
scheduling, assignment, or financial decision must be fully verified before it's
treated as final.

**Proactive behaviors — don't wait to be asked:**
- When scheduling anything involving multiple people, cross-check availability,
  preferences, AND form data in parallel — not sequentially. Assume conflicts
  exist until proven otherwise.
- When a staff member hasn't responded, flag them explicitly. Never assume
  silence = agreement.
- When reviewing any tracker with status flags (e.g., "inactive"), always
  cross-check against the actual source of truth (e.g., payment records).

**Corrections this user makes to Claude:**
- Generic templates are wrong — observation rubrics must be tailored per
  teacher/classroom.
- Attaching lesson plans to substitute coverage isn't optional — it's part of
  the confirmation step.
- Feedback documents aren't complete without a specific strength, a growth
  item, AND a follow-up date.

## What NOT to Do

- Don't finalize a schedule with unconfirmed participants — always flag who
  hasn't replied.
- Don't use a generic observation rubric across teachers — always customize.
- Don't send substitute confirmation without lesson plan materials attached.
- Don't approve a budget as a lump sum — itemization is required before any
  approval.
```

</details>

<details>
<summary>Example 2: Bus Driver (safety ops: pre-trip checks, fault diagnosis, route changes)</summary>

```markdown
---
name: auto-safety-first-ops
description: >
  Captures the user's safety-before-action thinking model: always diagnose before fixing,
  always verify after repairing, and always communicate before acting on safety-blocking issues.
  The mental model is "sequence integrity" — doing things out of order creates compounding risk.
triggers:
  - pre-trip check
  - system diagnostic
  - route disruption
  - maintenance action
  - boarding passengers
---

## Thinking Model

This user runs a **safety-gated operations loop**. Every action must pass through:
Diagnose → Communicate → Act → Verify. Skipping any step — even for a "quick fix"
— is the error they correct most often.

**What they care about most: sequence integrity and root cause, not speed.**

- Never assume a surface fix resolves the underlying problem. Low tire pressure
  isn't "inflated and done" — it's "why was it low?" until proven otherwise.
- Safety-blocking issues broadcast first, fix second. Communication isn't a
  follow-up; it's the first action.
- Pre-trip and system checks are a gate, not a formality. Passengers never
  board before all checks clear — no exceptions, no reversals.
- Graceful degradation matters: fare failures need a fallback path ready
  *before* a passenger is at the scanner, not after they're blocking the queue.

## What NOT to Do

- **Don't inflate and proceed.** Restoring tire pressure without diagnosing
  the root cause is a false fix. It may warrant a maintenance hold.
- **Don't mark pre-trip PASS after a patch.** A fix without root cause
  confirmation doesn't clear the check.
- **Don't fix before communicating.** Safety-blocking issues require
  notification first, always.
- **Don't board before all checks clear.** No scenario where loading precedes
  system verification.
- **Don't assume payment will succeed.** Design for failure at the scanner,
  not after it.
```

</details>

The principal's skill is about correctness. The driver's is about sequence. Both were inferred from behavior alone.

## Anti-pattern detection

You don't have to say "don't do that" for a rule to appear. claude-evolve reads the whole timeline of a session: every Read, Edit, Bash and MCP call. It asks the model for two lists, habits worth keeping and mistakes. The prompt's own examples are editing without reading first, and running a database query with no dry run or date filter. The mistakes become corrective rules without you saying anything.

```markdown
<!-- claude-evolve:rule id=r_mo4aod2m_8ogc -->
- Always Read a file before Edit, because blind edits cause errors
<!-- /claude-evolve:rule -->
```

This needs at least 3 tool calls in the session. The model is told to be conservative and to report only clear, repeated patterns.

## From rules to skills

A new rule starts as a single instruction. A haiku call classifies it as simple, compound, workflow or methodology. The first three render in `CLAUDE.local.md`. A methodology rule goes into a skill instead.

A rule counts as mature when its score is above 7 across at least 5 sessions where it came up. When 3 or more rules are mature, the skillify gene marks them as methodology. Sonnet then writes one skill for the project. It draws on your feedback memories to describe how you think, not only which steps you take. That covers what you check first, what you do without being asked, and what Claude should avoid.

The skill lives in `.claude/skills/auto-<name>/SKILL.md`, and a Skill Routing block in `CLAUDE.local.md` tells Claude when to load it:

```markdown
<!-- claude-evolve:managed-start -->
## Auto-learned Rules

<!-- claude-evolve:skill-routing -->
### Skill Routing

The following skills were auto-generated from observed work patterns. Use them when the trigger matches:

- **auto-bq-safe-analysis** (.claude/skills/auto-bq-safe-analysis/SKILL.md): Cost-aware, correctness-first BigQuery analytics thinking model
  Triggers: run a BigQuery query, analyze experiment results, write a funnel query

When any of these triggers match, load and follow the corresponding skill before proceeding.
<!-- /claude-evolve:skill-routing -->

<!-- claude-evolve:managed-end -->
```

If you edit a skill file, claude-evolve notices (it keeps a content hash) and stops touching it. If a skill's rules stop earning their score, they're demoted and the skill file goes away, unless you've edited it.

Mature patterns that aren't simple rules are also saved to a shared store, keyed by project type (analysis, backend, infra, documentation or general). When you open another project of the same type, session start lists up to 3 of them as information. Nothing is applied for you.

## When this helps

Use it if you work in Claude Code most days, across projects, and keep correcting Claude on the same things. It also suits you if your projects have conventions Claude keeps forgetting. And it's for you if you want Claude to learn how you work, not only what you type.

Skip it if you use Claude Code about once a week, or your sessions are short (under 3 tool calls teach it nothing). Skip it if you don't want background LLM calls. If you want semantic search over past sessions, try [claude-mem](https://github.com/thedotmack/claude-mem).

Expect little from the first few sessions. A skill needs at least 5 sessions behind each of 3 rules, so it takes a while.

## Is it helping?

The rule store scores its own rules, so it can't tell you whether they work. `eval/events.js` reads your raw transcripts instead. For each session it counts the messages you typed, the ones that look like corrections, interrupts, tool calls you rejected, permission denials and tool errors. A forked or resumed session repeats its parent's lines, and each line is counted once.

```bash
node eval/events.js               # writes events.jsonl and sessions.jsonl to learning/data/eval
node eval/events.js --sample 100  # a blind sheet of 100 of your messages to label y or n
node eval/events.js --score       # how often the correction flag is right, and what it misses
```

The correction flag is a keyword match, so label a sheet before you trust it. Half the sheet comes from flagged messages and half from the rest, and the sheet doesn't say which. Everything stays in the data folder with mode 0600. Text goes through the same redaction as tool calls, so the same limits apply. Claude Code deletes transcripts after 30 days by default. For a longer history, set `"cleanupPeriodDays"` in `~/.claude/settings.json`.

## How it works

```
You use Claude Code normally
        ↓
Hooks (about 50 ms each):
  SessionStart  inject this project's recent history, rule count and notices
  PostToolUse   append a redacted record of each tool call to a temp file
  SessionEnd    hand the session to a detached processor (once per session)
        ↓
Processor, in the background:
  Triage (haiku)      which gene, and is it routine or complex?
  Gene (haiku, or     repair:   rules from new corrections
   sonnet if complex) innovate: patterns and anti-patterns from the timeline
                      optimize: LLM scores the active rules
                      cleanup:  merge, rewrite or remove rules
                      skillify: promote mature rules to a skill
                      observe:  quiet session, record only
  Check               contradictions against every instruction layer and memory
  Apply               add rules, score, decay, demote, promote, prune (no LLM)
  Solidify            rules to CLAUDE.local.md, methodology to a skill
  Summarize (sonnet)  session summary into session memory
        ↓
Next session: Claude Code loads CLAUDE.local.md and the skills like any other instruction file
```

If Claude Code dies without firing SessionEnd, the next SessionStart finds the leftover observation file and processes it.

Triage picks the gene. If the triage call fails, a heuristic picks it instead, checking these in order:

1. New memories: repair.
2. 3 or more tool calls: innovate.
3. Mature rules: skillify.
4. 8 or more active rules: cleanup.
5. Every third session: optimize.
6. Anything else: observe.

### Rules and their lifecycle

| Status | Meaning |
|--------|---------|
| active | Written to `CLAUDE.local.md`. At most 10 per project. |
| candidate | Over the cap, waiting for a free slot. Pruned after 30 days. |
| dormant | Demoted, duplicated, merged away or contradicted. Can be revived. Pruned after 60 days. |

Pruned rules are appended to `rules_archive.jsonl`.

| Scoring | Details |
|---------|---------|
| Scale | 0 to 10. A new rule starts at 5. |
| Every session (no LLM) | Keyword hits in the session's tool calls move the score as a moving average. A strong hit pulls toward 8 and a partial hit toward 6, both with weight 0.3. No hit pulls toward 2 with weight 0.1, so unused rules decay slowly. |
| Optimize gene | The LLM scores each active rule 0 to 10. The result joins the same moving average with weight 0.3. |
| Demotion | Score under 3 after 3 or more evaluations: the rule goes dormant and drops one complexity level. |

### Conflicts

Every new, merged, rewritten or revived rule is checked against your instructions and memories. The instructions are the CLAUDE.md and CLAUDE.local.md files from the project folder upward, plus `~/.claude/CLAUDE.md`. If a rule contradicts them, your text wins and the rule is not applied. A new rule is stored as dormant, and the changelog records why. There's nothing for you to answer.

### Session memory

Each processed session becomes a markdown file in `<data dir>/memory/sessions/`: a summary, the key decisions, and the tool-call timeline. Each project has a short index, and session start injects its last 10 lines. The files are plain text, so open them when you want the detail.

## What the rules file looks like

Your hand-written text stays where it is. Only the block between the markers is claude-evolve's:

```markdown
## Your hand-written rules

<!-- claude-evolve:managed-start -->
## Auto-learned Rules

<!-- claude-evolve:rule id=r_abc -->
- Always check existing definitions before writing new queries
<!-- /claude-evolve:rule -->

<!-- claude-evolve:managed-end -->
```

The tag holds only the rule's id. Scores and everything else live in `rules.json`, so a score change never rewrites the file.

## Tests

```bash
npm test
```

This runs `node --test test/*.test.js`. The tests mock the `claude` CLI and use temp folders, so they cost nothing and need no login. GitHub Actions runs them on Node 18, 20 and 22.

## Architecture

```
setup.js                   install, check, remove, clean-stale
demo.js                    the demo above
eval/
└── events.js              outcome events from raw transcripts, labeling sheet, scoring
learning/
├── hooks/
│   ├── session-start.js   sweep abandoned sessions, inject context
│   ├── post-tool.js       record redacted tool calls
│   └── session-end.js     claim the session, spawn the processor
├── processRules.js        the pipeline: triage, gene, check, apply, solidify
├── llmBrain.js            every claude --print call, with tiers and retry
├── ruleEngine.js          rule store, scoring, lifecycle
├── claudeMdWriter.js      the managed block in CLAUDE.local.md
├── skillWriter.js         .claude/skills/auto-*/SKILL.md
├── sessionMemory.js       session files, per-project index, temp observation files
├── memoryReader.js        reads your Claude Code memories
├── crossProjectStore.js   patterns shared between projects of one type
├── skillHints.js          one-time "a skill was created" notices
├── cleanStale.js          behind setup.js --clean-stale
├── analyzer.js            session stats and project type
├── redact.js              secret redaction
├── paths.js               data dir and project-folder resolution
├── fsutil.js              atomic writes, locks, bounded logs
├── exploration.js         manual: node learning/exploration.js [path] reports stale rules and drift
├── bootstrap.js           manual: node learning/bootstrap.js seeds a profile from your memories
└── genes.json             gene definitions
```

## Origin story

This project was inspired by [Evolver](https://github.com/EvoMap/evolver) by the EvoMap team. Evolver is a GEP (Gene Expression Programming) engine that lets AI agents evolve their own code.

I wanted to use Evolver as it is, then realized I didn't need a full autonomous self-evolution agent. I needed something simpler: Claude Code that gets better at working with me, session after session. So I took the core ideas (signal detection, gene-based actions, LLM evaluation, solidification) and pointed them at how a human works instead of at code. The "genome" isn't source code. It's each project's rules file.

## Acknowledgments

- [Evolver / EvoMap](https://github.com/EvoMap/evolver) for the signal, gene and solidify architecture this project borrows from.
- [Claude Code](https://claude.com/claude-code) by Anthropic, the assistant this is built for.

## License

MIT
