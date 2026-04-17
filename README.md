# claude-evolve

Claude Code watches what you do. This watches what Claude Code does, and makes it better at working with you.

Most "memory" tools for AI assistants just store and retrieve. claude-evolve **evolves** — it spots your mistakes before you correct them, learns patterns you never explicitly teach, prunes rules that stop helping, and gets sharper every session. After enough sessions, it graduates from rules to full **Claude Code skills** that capture how you think.

## The thing that matters most: anti-pattern detection

Other tools wait for you to say "don't do that." claude-evolve watches the full session timeline — every Read, Edit, Bash, every MCP call — and spots suboptimal behaviors on its own.

Edit without Read first? It notices. Query without dry-run? It notices. Same file opened 4 times because grep wasn't used? It notices.

These become corrective rules automatically. You don't have to say anything.

```markdown
<!-- evolver:rule id=r_ghi score=7 created=2026-04-16 source=anti_pattern -->
- Always Read a file before Edit — blind edits cause errors
<!-- /evolver:rule -->
```

This is the difference between a memory system and a learning system.

## From rules to skills: the Continuum

claude-evolve doesn't just write rules. It outputs at the right level of abstraction based on how mature a pattern is:

```
Session 1-5:    simple rules      →  "Always dry_run before BQ queries"
Session 5-10:   compound rules    →  Multi-step checklist in CLAUDE.md
Session 10+:    methodology       →  Full .claude/skills/ file
```

When enough related rules accumulate high scores, the system promotes them into a Claude Code skill file. The skill isn't a copy of the rules — Claude (sonnet) synthesizes them with your memories (corrections, preferences, project context) to produce a **thinking model**:

```markdown
## Thinking Model

This user's thinking order is: cheap → correct → complete.

Cost is the first gate, not an afterthought.
Don't wait to be told — if scan exceeds 5GB, proactively suggest narrowing.

Iteration is the default, not the backup.
LIMIT 10 first, confirm logic, then expand. Never run the full query on first try.

## What NOT to do
- Don't run full queries without dry_run
- Don't give absolute numbers without a comparison baseline
```

Skills live in `.claude/skills/auto-*.md`. They follow the standard Claude Code skill format with triggers, so Claude loads them automatically. Skills that stop being useful get demoted back to rules, and eventually pruned. The whole lifecycle is bidirectional.

Cross-project transfer: when you start a new project of the same type (e.g., another analysis project), the system suggests patterns it learned from your other projects.

### Validated with real simulation

We tested this by simulating 3 different analysts (Alice, Bob, Carol) doing 6 different analysis tasks (retention, funnel, segmentation, trends, churn, ARPU). Each analyst had a different style, but the system found their shared methodology automatically:

```
3 analysts × 2 tasks each = 6 sessions
→ 10 rules extracted from observed behavior
→ 1 skill generated capturing the common thinking model:
  "Progressive commitment: spend minimum cost to validate at each stage
   before committing to a larger, more expensive step."
```

No analyst explicitly taught these patterns. The system inferred them from tool usage sequences across sessions.

## When this helps / When it doesn't

**This is for you if:**
- You use Claude Code daily across multiple projects
- You find yourself correcting Claude on the same things repeatedly
- You have project-specific conventions that Claude keeps forgetting
- You want Claude to learn your workflow, not just your words

**This is NOT for you if:**
- You use Claude Code once a week or less (not enough sessions for patterns to emerge)
- Your sessions are short and simple (< 5 tool calls, nothing to learn from)
- You don't want any background LLM calls (each session end makes 2-3 haiku/sonnet calls)
- You want a vector database for semantic search (use [claude-mem](https://github.com/thedotmack/claude-mem) instead)

The system needs ~5 sessions before it starts producing useful rules. ~10 sessions before skills start emerging. If you're not going to give it that runway, it's overhead.

## Origin story

This project was inspired by [Evolver](https://github.com/EvoMap/evolver) by the EvoMap team — a GEP (Gene Expression Programming) engine that enables AI agents to self-evolve their own code.

I originally wanted to use Evolver as-is, but realized I didn't need a full autonomous self-evolution agent. What I needed was simpler: **I wanted Claude Code to get better at working with me, session after session.**

So I took the core ideas — signal detection, gene-based actions, LLM evaluation, solidification — and applied them not to code evolution, but to **learning how a human works**. Every session is observed. Rules that help stay; rules that don't get demoted. The "genome" isn't source code — it's each project's `CLAUDE.md`.

Huge thanks to the Evolver / EvoMap team for the original vision. This project wouldn't exist without their work.

## How it works

```
You use Claude Code normally
        ↓
Hooks observe every session:
  - Full tool input/output (what you read, edit, run)
  - When you correct Claude's behavior
  - What patterns repeat across sessions
        ↓
Session ends → background pipeline:

  Triage (haiku):
    "What happened? Which gene? How complex?"
    → { gene: "repair", complexity: "routine" }
        ↓
  Gene execute (haiku for routine, sonnet for complex):
    repair:   extract rules from corrections
    innovate: detect patterns + anti-patterns from observations
    optimize: LLM scores all active rules 0-10, demotes low scorers
    cleanup:  merge / rewrite / remove redundant rules
    skillify: promote mature rule groups → .claude/skills/ files
    observe:  quiet session, just record
        ↓
  Validate: check for conflicts with hand-written rules
        ↓
  Classify complexity: simple / compound / workflow / methodology
        ↓
  Solidify: route output by complexity level
    simple/compound/workflow → CLAUDE.md
    methodology → .claude/skills/auto-*.md (via Claude sonnet)
        ↓
Next session: Claude follows learned rules + has session history
```

## Key features

### Anti-pattern detection
Watches the full session timeline and spots suboptimal behaviors — editing without reading, querying without dry-run, repetitive file opens. Creates corrective rules without you saying a word.

### LLM triage + model routing
Each session is triaged by a fast haiku call that determines what action to take and how complex it is. Routine work (simple correction, minor observation) stays on haiku. Complex work (methodology changes, conflicting patterns, major restructuring) escalates to sonnet. You pay for intelligence only when it matters.

### Observation-based learning
Records full tool input/output (not just tool names). The LLM sees what you actually did and extracts actionable rules from real behavior.

### LLM-driven scoring
Rules are scored 0-10 by the LLM based on relevance and usefulness to each session. Scores use exponential moving average (30% new, 70% history) to smooth out noise. No hardcoded formulas — the LLM judges directly.

### Evolver-style pipeline
Inspired by [Evolver](https://github.com/EvoMap/evolver)'s architecture: Signal → Gene → Execute → Validate → Solidify. Simple, predictable, each step has a clear purpose.

### Population lifecycle
Rules live in three states: **active** (in CLAUDE.md), **dormant** (demoted but preserved — environment changes might make them useful again), **dead** (dormant too long). Nothing is deleted immediately.

### Session memory
Every session is compressed into a structured `.md` file with summary, key decisions, and full observation timeline. A compact index is injected at session start.

### Skill generation
When 3+ related rules accumulate high scores over multiple sessions, the system promotes them to a `.claude/skills/` file. Claude (sonnet) generates the skill content, incorporating your feedback memories to produce a "thinking model" — not just steps, but how you approach a class of problems. Skills are scored and can be demoted back to rules if they stop being useful.

### Cross-project learning
Mature patterns are saved to a shared store keyed by project type (analysis, backend, infra). When you start a new project of the same type, the system suggests patterns from your other projects. Transfer is opt-in — you confirm before applying.

### Conflict detection
New auto-learned rules are checked against your hand-written `CLAUDE.md`. Conflicts become alerts — your rules are never overwritten.

## Installation

### Quick setup (recommended)

```bash
git clone https://github.com/jack60810/claude-evolve.git
cd claude-evolve
node setup.js
```

That's it. The setup script automatically:
- Detects your install path
- Adds hooks to `~/.claude/settings.json` (merges with existing settings, never overwrites)
- Creates the data directory
- Verifies claude CLI and Node.js are available

### Verify

```bash
node setup.js --check
```

### Uninstall

```bash
node setup.js --remove
```

Removes hooks from settings. Your learned rules in `CLAUDE.md` and data in `learning/data/` are preserved.

<details>
<summary>Manual setup (if you prefer editing JSON)</summary>

Add these hooks to `~/.claude/settings.json`. If you already have hooks, merge the entries into the existing arrays.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /FULL/PATH/TO/claude-evolve/learning/hooks/session-start.js",
            "timeout": 3
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /FULL/PATH/TO/claude-evolve/learning/hooks/post-tool.js",
            "timeout": 2
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /FULL/PATH/TO/claude-evolve/learning/hooks/session-end.js",
            "timeout": 8
          }
        ]
      }
    ]
  }
}
```

Replace `/FULL/PATH/TO/claude-evolve` with the actual absolute path.

</details>

## What gets written to CLAUDE.md

Auto-learned rules are placed in a fenced section. Your hand-written rules are never touched.

```markdown
## Your Hand-Written Rules

These are yours. claude-evolve will never modify them.

## Auto-learned Rules

<!-- evolver:managed-start -->

<!-- evolver:rule id=r_abc score=8 created=2026-04-17 source=correction -->
- Always check existing definitions before writing new queries
<!-- /evolver:rule -->

<!-- evolver:rule id=r_def score=7 created=2026-04-15 source=observation -->
- After each Edit, run a validation step before moving to the next modification
<!-- /evolver:rule -->

<!-- evolver:rule id=r_ghi score=6 created=2026-04-16 source=anti_pattern -->
- Always Read a file before Edit — blind edits cause errors
<!-- /evolver:rule -->

<!-- evolver:managed-end -->
```

## Pipeline: Signal → Gene → Execute → Validate → Solidify

| Step | Model | What it does |
|------|-------|-------------|
| **Triage** | haiku | Determines gene + complexity from session data |
| **Gene execute** | haiku or sonnet | Runs the selected gene's action |
| **Validate** | keyword | Checks for conflicts with hand-written rules |
| **Classify** | — | Determines output complexity level |
| **Solidify** | — | Routes to CLAUDE.md or .claude/skills/ |
| **Memory** | sonnet | Compresses session into persistent memory |

### Genes

| Gene | Trigger | Action |
|------|---------|--------|
| `repair` | Corrections detected | Extract rules from feedback |
| `innovate` | Significant observations, no corrections | Detect patterns + anti-patterns from timeline |
| `optimize` | Periodic (every ~3 sessions) | LLM scores all rules 0-10, demotes low scorers |
| `cleanup` | 8+ active rules | LLM merges, rewrites, or removes redundant rules |
| `skillify` | 3+ related high-score rules | Promote rule group to .claude/skills/ file |
| `observe` | Trivial session | Just record, no action |

## How scoring works

| Mechanism | Details |
|-----------|---------|
| **Scale** | 0-10, scored by LLM per session |
| **Smoothing** | Exponential moving average (α=0.3) |
| **New rules** | Start at 5 (neutral / untested) |
| **Demotion** | Score < 3 after 3+ evaluations → dormant |
| **Death** | 15 sessions in dormant → dead |

## Three-tier session memory

| Tier | Content | When used |
|------|---------|-----------|
| **1. Index** | One line per session in `index.md` | Injected at every session-start |
| **2. Summary** | Bullet points + key decisions | On-demand (search/recall) |
| **3. Full** | Complete tool observation timeline | Debugging / deep analysis |

## Architecture

```
learning/
├── hooks/
│   ├── session-start.js   — Inject index + conflict alerts + skill hints + cross-project suggestions
│   ├── session-end.js     — Collect observations + classify project type + spawn background
│   └── post-tool.js       — Record full tool input/output
├── processRules.js        — Signal → Gene → Execute → Classify → Route → Solidify
├── llmBrain.js            — All LLM calls (triage, extraction, scoring, complexity, skill generation)
├── ruleEngine.js          — Population lifecycle (active/dormant/dead) + complexity tracking
├── claudeMdWriter.js      — CLAUDE.md managed section (simple/compound/workflow formats)
├── skillWriter.js         — .claude/skills/ auto-generation via Claude sonnet
├── memoryReader.js        — Read Claude Code memories (feedback/user/project/reference)
├── sessionMemory.js       — Three-tier session memory (index/summary/full)
├── exploration.js         — Manual: stale rule and drift detection
├── analyzer.js            — Session statistics + project type classification
├── genes.json             — Gene definitions (repair/innovate/optimize/cleanup/skillify/observe)
└── setup.js               — One-command install/check/uninstall
```

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI
- Node.js >= 18
- No npm dependencies (zero install, just clone and run)

## Acknowledgments

- [Evolver / EvoMap](https://github.com/EvoMap/evolver) — the original evolver engine that inspired this project's signal-gene-solidify architecture
- [Claude Code](https://claude.com/claude-code) by Anthropic — the AI coding assistant this system is built for

## License

MIT
