#!/usr/bin/env node
// session-start.js — SessionStart hook
// Progressive disclosure: inject only Tier 1 (index + stats) at startup.
// Detailed context available on-demand via MCP tools.

const path = require('path');
const fs = require('fs');

const LEARNING_ROOT = path.join(__dirname, '..');

function main() {
  let input = '';
  let handled = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    if (handled) return;
    handled = true;

    try {
      // Guard: skip if this is a child process spawned by llmBrain
      if (process.env.EVOLVER_CHILD === '1') {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const sections = [];

      // --- Tier 1: Session memory index (recent history) ---
      try {
        const sessionMemory = require(path.join(LEARNING_ROOT, 'sessionMemory'));
        const indexLines = sessionMemory.readIndex(10);
        if (indexLines.length > 0) {
          sections.push('[Recent Sessions]');
          sections.push(indexLines.join('\n'));
        }
      } catch {}

      // --- Compact rule stats ---
      try {
        const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
        const projectPath = process.cwd();
        const activeRules = ruleEngine.getActiveRules(projectPath);
        if (activeRules.length > 0) {
          sections.push(`[claude-evolve] ${activeRules.length} active rules (see CLAUDE.md auto-learned section)`);
        }
      } catch {}

      // --- Conflict alerts (must be immediate — user action required) ---
      try {
        const ruleEngine = require(path.join(LEARNING_ROOT, 'ruleEngine'));
        const projectPath = process.cwd();
        const conflicts = ruleEngine.getPendingConflicts(projectPath);

        if (conflicts.length > 0) {
          sections.push('⚠️ [claude-evolve Conflict Alert]');
          sections.push('The following auto-learned rules conflict with hand-written CLAUDE.md:');
          for (const c of conflicts) {
            sections.push(`- New rule: "${c.new_content}"`);
            sections.push(`  Conflicts with: "${(c.conflicts_with || '').slice(0, 150)}..." (ID: ${c.id})`);
          }
          sections.push('Reply "accept new rule" / "keep existing" / "update existing" to resolve');
        }
      } catch {}

      // --- Recent rule changes (compact, last 24h) ---
      try {
        const changelogPath = path.join(LEARNING_ROOT, 'data', 'changelog.jsonl');
        if (fs.existsSync(changelogPath)) {
          const lines = fs.readFileSync(changelogPath, 'utf8').trim().split('\n').filter(Boolean);
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const recent = [];
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (new Date(entry.timestamp).getTime() < oneDayAgo) break;
              if (['add_rule', 'prune_rule', 'distill_rules'].includes(entry.action)) {
                recent.push(entry);
              }
            } catch {}
          }

          if (recent.length > 0) {
            sections.push('[Rule Changes (24h)]');
            for (const r of recent.reverse()) {
              if (r.action === 'add_rule') {
                const src = r.source === 'observation' ? 'obs' : r.source === 'anti_pattern' ? 'fix' : r.source === 'behavior' ? 'beh' : 'corr';
                sections.push(`+ [${src}] ${(r.content || '').slice(0, 80)}`);
              } else if (r.action === 'prune_rule') {
                sections.push(`- pruned: ${(r.content || '').slice(0, 60)}`);
              } else if (r.action === 'distill_rules') {
                sections.push(`~ distilled ${(r.distilled_from || []).length} → 1`);
              }
            }
          }
        }
      } catch {}

      if (sections.length === 0) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const context = sections.join('\n');
      process.stdout.write(JSON.stringify({
        agent_message: context,
        additionalContext: context,
      }));
    } catch {
      process.stdout.write(JSON.stringify({}));
    }
  });

  setTimeout(() => {
    if (handled) return;
    handled = true;
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }, 2000);
}

main();
