# claude-evolve

Claude Code watches what you do. This watches what Claude Code does, and makes it better at working with you.

Most "memory" tools for AI assistants just store and retrieve. claude-evolve **evolves** — it spots your mistakes before you correct them, learns patterns you never explicitly teach, prunes rules that stop helping, and gets sharper every session.

## The thing that matters most: anti-pattern detection

Other tools wait for you to say "don't do that." claude-evolve watches the full session timeline — every Read, Edit, Bash, every MCP call — and spots suboptimal behaviors on its own.

Edit without Read first? It notices. Query without dry-run? It notices. Same file opened 4 times because grep wasn't used? It notices.

These become corrective rules automatically. You don't have to say anything.

```markdown
<!-- evolver:rule id=r_ghi fitness=3 created=2026-04-16 source=anti_pattern -->
- Always Read a file before Edit — blind edits cause errors
<!-- /evolver:rule -->
```

This is the difference between a memory system and a learning system.

## When this helps / When it doesn't

**This is for you if:**
- You use Claude Code daily across multiple projects
- You find yourself correcting Claude on the same things repeatedly
- You have project-specific conventions that Claude keeps forgetting
- You want Claude to learn your workflow, not just your words

**This is NOT for you if:**
- You use Claude Code once a week or less (not enough sessions for patterns to emerge)
- Your sessions are short and simple (< 5 tool calls, nothing to learn from)
- You don't want any background LLM calls (each session end makes 3-8 haiku/sonnet calls)
- You want a vector database for semantic search (use [claude-mem](https://github.com/thedotmack/claude-mem) instead)

The system needs ~5 sessions of data before it starts producing useful rules. It gets meaningfully better after ~20 sessions. If you're not going to give it that runway, it's overhead.

## Origin story

This project was inspired by [Evolver](https://github.com/EvoMap/evolver) by the EvoMap team — a GEP (Gene Expression Programming) engine that enables AI agents to self-evolve their own code.

I originally wanted to use Evolver as-is, but realized I didn't need a full autonomous self-evolution agent. What I needed was simpler: **I wanted Claude Code to get better at working with me, session after session.**

So I took the core ideas — genetic algorithms, fitness scoring, selection pressure, distillation — and applied them not to code evolution, but to **learning how a human works**. Every session becomes a selection event. Rules that help survive; rules that don't get pruned. The "genome" isn't source code — it's each project's `CLAUDE.md`.

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
Background LLM analysis (haiku for fast, sonnet for complex):
  - Detect anti-patterns from the session timeline
  - Extract rules from explicit corrections
  - Learn behavior patterns across sessions
  - Check for conflicts with your hand-written rules
  - Prune rules that don't help
        ↓
Auto-writes to your project's CLAUDE.md
Session compressed into persistent memory
        ↓
Next session: Claude follows learned rules + has session history
```

## Key features

### Anti-pattern detection
Watches the full session timeline and spots suboptimal behaviors — editing without reading, querying without dry-run, repetitive file opens. Creates corrective rules without you saying a word.

### Observation-based learning
Records full tool input/output (not just tool names). The LLM sees what you actually did and extracts actionable rules from real behavior.

### Darwinian rule evolution
Rules have fitness scores. Clean sessions = +1. Re-corrections on the same topic = -2. Low-fitness rules get pruned. Strong rules survive.

### Strategy selection
Each session is classified (repair / reinforce / explore / distill) and processed accordingly — not every session gets the same treatment.

### Session memory
Every session is compressed into a structured `.md` file with summary, key decisions, and full observation timeline. A compact index is injected at session start.

### Conflict detection
New auto-learned rules are checked against your hand-written `CLAUDE.md`. Conflicts become alerts — your rules are never overwritten.

### Periodic reflection
Every 5 sessions, the system meta-analyzes its own rules: what's working, what's failing, what should be merged or removed.

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

<!-- evolver:rule id=r_abc fitness=5 created=2026-04-17 source=correction -->
- Always check existing definitions before writing new queries
<!-- /evolver:rule -->

<!-- evolver:rule id=r_def fitness=8 created=2026-04-15 source=observation -->
- After each Edit, run a validation step before moving to the next modification
<!-- /evolver:rule -->

<!-- evolver:rule id=r_ghi fitness=3 created=2026-04-16 source=anti_pattern -->
- Always Read a file before Edit — blind edits cause errors
<!-- /evolver:rule -->

<!-- evolver:managed-end -->
```

## Learning pipeline (9 steps)

Each session end triggers a background process:

1. **Strategy selection** (haiku) — classify session as repair / reinforce / explore / distill
2. **Rule extraction** (haiku) — extract actionable rules from corrections
3. **Conflict check** (haiku) — compare against hand-written CLAUDE.md
4. **Fitness evaluation** (haiku) — match corrections to existing rules
5. **Observation analysis** (sonnet) — detect patterns and anti-patterns from full timeline
6. **Pruning** — remove rules with fitness < -3 after 5+ sessions
7. **Distillation** (sonnet) — merge similar rules into sharper versions
8. **Reflection** (sonnet, every 5 sessions) — meta-analysis of what works
9. **Session compression** (sonnet) — compress observations into persistent memory

## How fitness works

| Event | Fitness change |
|-------|---------------|
| Session with no re-correction | +1 |
| Same topic corrected again (high confidence) | -2 |
| Same topic corrected again (medium confidence) | -1 |
| **Pruning threshold** | fitness < -3 AND sessions >= 5 |

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
│   ├── session-start.js   — Progressive context injection (Tier 1 index)
│   ├── session-end.js     — Collect observations + spawn background
│   └── post-tool.js       — Record full tool input/output
├── processRules.js        — 9-step background pipeline
├── llmBrain.js            — LLM decisions (haiku/sonnet routing)
├── ruleEngine.js          — Rule CRUD, fitness, pruning, distillation
├── claudeMdWriter.js      — CLAUDE.md managed section read/write
├── memoryReader.js        — Read Claude Code feedback memories
├── sessionMemory.js       — Three-tier session memory (index/summary/full)
├── exploration.js         — Stale rule and drift detection
├── analyzer.js            — Session statistics aggregation
├── setup.js               — One-command install/check/uninstall
└── genes.json             — Learning signal definitions
```

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI
- Node.js >= 18
- No npm dependencies (zero install, just clone and run)

## Acknowledgments

- [Evolver / EvoMap](https://github.com/EvoMap/evolver) — the original GEP self-evolution engine that inspired this project's genetic learning approach
- [Claude Code](https://claude.com/claude-code) by Anthropic — the AI coding assistant this system is built for

## License

MIT
