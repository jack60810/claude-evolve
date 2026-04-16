# CLAUDE.md

## Auto-learned Rules

<!-- evolver:managed-start -->

<!-- evolver:rule id=r_mo1vghrx_8hvs fitness=17 created=2026-04-16 source=observation -->
- After writing a new CLI script, immediately test it with its own help/check flags (e.g., `node setup.js --check`, `node setup.js --help`) before staging or committing, to verify it runs without errors
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1vqwnv_q45i fitness=14 created=2026-04-16 source=observation -->
- After deploying or shipping a version, post a notification to the relevant team channel (e.g., Slack #dev) with the version tag, a one-line summary of what changed, and a link to the release or PR.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1vr9tz_uuem fitness=15 created=2026-04-16 source=distillation -->
- When testing a stateful hook or pipeline: (1) wipe persistent state at suite start for a clean baseline, (2) run both cold-start and warm modes to cover both code paths, (3) loop multiple iterations to surface accumulation bugs, and (4) use structured JSON parsing (e.g., python3 -c 'import json...') rather than raw grep to catch schema issues early.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1yl142_7cyp fitness=8 created=2026-04-16 source=observation -->
- When implementing multiple interdependent modules in one session, create all task stubs upfront before beginning any implementation so full scope is visible, tracked, and sequenced.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1z8x5e_04zl fitness=1 created=2026-04-16 source=observation -->
- When removing or replacing a major subsystem (e.g., GA mechanics), document the removal explicitly in the commit message: what was removed, why, and what replaces it — not just what was added.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1z99bq_e6ha fitness=23 created=2026-04-16 source=distillation -->
- Always Read a file before editing it — capture everything you need in a single Read. Never re-read the same file multiple times; use `grep -n` to locate specific function boundaries or fill gaps instead. When restructuring docs, use targeted section-level Edits rather than wiping the entire body in one pass, as a failed follow-up Edit would leave the file broken.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1z99br_okeq fitness=23 created=2026-04-16 source=distillation -->
- After any refactoring, bulk replacement, file copy between repos, or removal of hardcoded references — especially in JS/Node modules — immediately run a targeted grep to verify no stale references remain and a require/import audit to confirm all module dependencies resolve. When testing refactored modules, run incremental Bash test scripts in layers (module load check → isolated unit logic → full integration) rather than one monolithic test, to isolate failures faster.
<!-- /evolver:rule -->

<!-- evolver:managed-end -->
