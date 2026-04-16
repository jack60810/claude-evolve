# claude-evolve

A self-evolving learning system for [Claude Code](https://claude.com/claude-code). It observes how you work, learns from your corrections and behavior patterns, and automatically writes rules to your project's `CLAUDE.md` — making Claude Code better at helping you over time.

## Origin story

This project was inspired by [Evolver](https://github.com/EvoMap/evolver) by the EvoMap team — a full-featured GEP (Gene Expression Programming) engine that enables AI agents to self-evolve their own code through mutation, validation, and solidification cycles.

I originally wanted to use Evolver as-is, but quickly realized I didn't need a full autonomous self-evolution agent. What I actually needed was much simpler: **I wanted Claude Code to get better at working with me, session after session.**

So I took the core ideas — genetic algorithms, fitness scoring, selection pressure, distillation — and applied them not to code evolution, but to **learning how a human works**. Every session becomes a selection event. Rules that help survive; rules that don't get pruned. Behavior patterns that repeat get reinforced. The "genome" isn't source code — it's each project's `CLAUDE.md`.

The result is a system where Claude Code learns and self-corrects through every interaction. It adds what works, removes what doesn't, and gets a little better each time.

Huge thanks to the Evolver / EvoMap team for the original vision and architecture. This project wouldn't exist without their work.

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
  - Extract rules from corrections
  - Detect behavior patterns and anti-patterns from observations
  - Check for conflicts with hand-written rules
  - Prune rules that don't help
        ↓
Auto-writes to your project's CLAUDE.md
Session compressed into persistent memory
        ↓
Next session: Claude follows learned rules + has session history context
```

## Key features

### Observation-based learning
Records full tool input/output (not just tool names). The LLM sees what you actually did — file paths, query content, edit patterns — and extracts actionable rules from real behavior.

### Anti-pattern detection
Spots mistakes and suboptimal behaviors (e.g., editing without reading first, running queries without dry-run). Creates corrective rules automatically.

### Darwinian rule evolution
Rules have fitness scores. Clean sessions = +1. Re-corrections on the same topic = -2. Low-fitness rules get pruned. Strong rules survive.

### Session memory
Every session is compressed into a structured `.md` file with summary, key decisions, and full observation timeline. An index provides quick context at session start.

### Progressive disclosure
Session-start injects only a compact index + stats (Tier 1). Detailed context is available on-demand, not dumped into every prompt.

### Conflict detection
New auto-learned rules are checked against your hand-written `CLAUDE.md`. Conflicts become alerts — your rules are never overwritten.

### Strategy selection
Each session is classified (repair / reinforce / explore / distill) and processed accordingly.

### Periodic reflection
Every 5 sessions, the system meta-analyzes its own rules: what's working, what's failing, what should be merged or removed.

## Installation

### Quick setup (recommended)

```bash
git clone https://github.com/YOUR_USER/claude-evolve.git
cd claude-evolve
node setup.js
```

That's it. The setup script automatically:
- Detects your `claude-evolve` install path
- Adds hooks to `~/.claude/settings.json` (merges with existing settings)
- Creates the data directory
- Verifies claude CLI is available

### Verify installation

```bash
node setup.js --check
```

You should see all checks pass:
```
  ✓ SessionStart → node /path/to/claude-evolve/learning/hooks/session-start.js
  ✓ PostToolUse → node /path/to/claude-evolve/learning/hooks/post-tool.js
  ✓ Stop → node /path/to/claude-evolve/learning/hooks/session-end.js
  ✓ claude CLI → /usr/local/bin/claude
  ✓ Node.js v22.0.0

All checks passed. ✓
```

### Uninstall

```bash
node setup.js --remove
```

Removes all claude-evolve hooks from settings. Your learned rules in `CLAUDE.md` and data in `learning/data/` are preserved.

### Manual setup (if you prefer)

<details>
<summary>Click to expand manual instructions</summary>

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

<!-- evolver:rule id=r_def fitness=8 created=2026-04-15 source=behavior -->
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
5. **Observation analysis** (sonnet) — detect patterns and anti-patterns from full session timeline
6. **Pruning** — remove rules with fitness < -3 after 5+ sessions
7. **Distillation** (sonnet) — merge similar rules
8. **Reflection** (sonnet, every 5 sessions) — meta-analysis of what works
9. **Session compression** (sonnet) — compress observations into persistent memory

## Three-tier session memory

| Tier | Content | When used |
|------|---------|-----------|
| **1. Index** | One line per session in `index.md` | Injected at every session-start |
| **2. Summary** | Bullet points + key decisions | On-demand (search/recall) |
| **3. Full** | Complete tool observation timeline | Debugging / deep analysis |

## Data files

All data in `learning/data/`:

| File | Purpose |
|------|---------|
| `rules.json` | Rule database with fitness scores |
| `changelog.jsonl` | All rule changes (add, prune, distill, reflect) |
| `conflicts.json` | Pending conflict alerts |
| `memory/index.md` | Session index (Tier 1) |
| `memory/sessions/*.md` | Session memory files (Tier 2+3) |
| `session_counter.json` | Per-project session count |
| `session_log.jsonl` | Tool usage statistics |
| `user_profile.json` | Aggregated user profile |

## Exploration (manual)

Scan a project for stale rules and drift:

```bash
node learning/exploration.js /path/to/your/project
```

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
└── genes.json             — Learning signal definitions
```

## How fitness works

| Event | Fitness change |
|-------|---------------|
| Session with no re-correction | +1 |
| Same topic corrected again (high confidence) | -2 |
| Same topic corrected again (medium confidence) | -1 |
| **Pruning threshold** | fitness < -3 AND sessions >= 5 |

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI
- Node.js >= 18

## Acknowledgments

- [Evolver / EvoMap](https://github.com/EvoMap/evolver) — the original GEP self-evolution engine that inspired this project's genetic learning approach
- [Claude Code](https://claude.com/claude-code) by Anthropic — the AI coding assistant this system is built for

## License

MIT
