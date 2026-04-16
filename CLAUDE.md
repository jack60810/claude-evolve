# CLAUDE.md

## Auto-learned Rules

<!-- evolver:managed-start -->

<!-- evolver:rule id=r_mo1vaz7p_1a91 fitness=14 created=2026-04-16 source=reflection -->
- After any refactoring, bulk replacement (sed/grep), file copy between repos, or removal of hardcoded references — especially in JS/Node modules — immediately run a targeted grep to verify no stale references remain AND run a require/import audit to confirm all module dependencies resolve correctly.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1vghrx_8hvs fitness=8 created=2026-04-16 source=observation -->
- After writing a new CLI script, immediately test it with its own help/check flags (e.g., `node setup.js --check`, `node setup.js --help`) before staging or committing, to verify it runs without errors
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1vqwnv_q45i fitness=5 created=2026-04-16 source=observation -->
- After deploying or shipping a version, post a notification to the relevant team channel (e.g., Slack #dev) with the version tag, a one-line summary of what changed, and a link to the release or PR.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1vr9tz_uuem fitness=6 created=2026-04-16 source=distillation -->
- When testing a stateful hook or pipeline: (1) wipe persistent state at suite start for a clean baseline, (2) run both cold-start and warm modes to cover both code paths, (3) loop multiple iterations to surface accumulation bugs, and (4) use structured JSON parsing (e.g., python3 -c 'import json...') rather than raw grep to catch schema issues early.
<!-- /evolver:rule -->

<!-- evolver:rule id=r_mo1vutky_d12b fitness=14 created=2026-04-16 source=reflection -->
- Always Read a file before editing it — capture everything you need in a single Read and proceed. Never jump straight to Edit. When restructuring a README or doc file in particular, use targeted section-level Edits rather than wiping the entire body in one pass, as a failed follow-up Edit would leave the file broken.
<!-- /evolver:rule -->

<!-- evolver:managed-end -->
