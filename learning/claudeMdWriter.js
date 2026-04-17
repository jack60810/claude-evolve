#!/usr/bin/env node
// claudeMdWriter.js — Read/write auto-learned rules in project CLAUDE.md
// Manages a fenced section marked by HTML comments, never touches hand-written content.

const fs = require('fs');
const path = require('path');

const MANAGED_START = '<!-- claude-evolve:managed-start -->';
const MANAGED_END = '<!-- claude-evolve:managed-end -->';

function ruleTag(rule) {
  const score = rule.score != null ? rule.score : (rule.fitness != null ? rule.fitness : 5);
  const complexity = rule.complexity || 'simple';
  return `<!-- claude-evolve:rule id=${rule.id} score=${score} created=${rule.created} source=${rule.source} complexity=${complexity} -->`;
}
const RULE_END = '<!-- /claude-evolve:rule -->';

// --- Read ---

function findClaudeMd(projectPath) {
  const p = path.join(projectPath, 'CLAUDE.md');
  return fs.existsSync(p) ? p : null;
}

function readClaudeMd(projectPath) {
  const mdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(mdPath)) return { path: mdPath, content: '', exists: false };
  return { path: mdPath, content: fs.readFileSync(mdPath, 'utf8'), exists: true };
}

/**
 * Extract all content outside the managed section (= hand-written content).
 */
function getHandWrittenContent(content) {
  const startIdx = content.indexOf(MANAGED_START);
  const endIdx = content.indexOf(MANAGED_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.slice(0, startIdx).trim();
  const after = content.slice(endIdx + MANAGED_END.length).trim();
  return (before + '\n' + after).trim();
}

// --- Build managed section ---

/**
 * Build the managed section content for CLAUDE.md.
 * @param {Array} rules - Non-methodology rules to write
 * @param {Array} [skillRoutes] - Skill routing entries: [{ name, path, triggers, description }]
 */
function buildManagedSection(rules, skillRoutes) {
  if ((!rules || rules.length === 0) && (!skillRoutes || skillRoutes.length === 0)) return '';

  const lines = [
    '',
    '## Auto-learned Rules',
    '',
    MANAGED_START,
    '',
  ];

  // Skill routing: tell Claude Code when to use auto-generated skills
  if (skillRoutes && skillRoutes.length > 0) {
    lines.push('<!-- claude-evolve:skill-routing -->');
    lines.push('### Skill Routing');
    lines.push('');
    lines.push('The following skills were auto-generated from observed work patterns. Use them when the trigger matches:');
    lines.push('');
    for (const route of skillRoutes) {
      lines.push(`- **${route.name}** (.claude/skills/${route.name}.md): ${route.description}`);
      if (route.triggers && route.triggers.length > 0) {
        lines.push(`  Triggers: ${route.triggers.join(', ')}`);
      }
    }
    lines.push('');
    lines.push('When any of these triggers match, load and follow the corresponding skill before proceeding.');
    lines.push('<!-- /claude-evolve:skill-routing -->');
    lines.push('');
  }

  if (!rules || rules.length === 0) {
    lines.push(MANAGED_END);
    return lines.join('\n');
  }

  for (const rule of rules) {
    lines.push(ruleTag(rule));
    const complexity = rule.complexity || 'simple';

    if (complexity === 'workflow') {
      // Workflow: numbered steps with optional header, preserve as-is
      const contentLines = rule.content.split('\n');
      for (const cl of contentLines) {
        const trimmed = cl.trim();
        if (!trimmed) continue;
        // Preserve headers, numbered steps, and bullets as-is
        if (/^#{1,6}\s/.test(trimmed) || /^\d+\.\s/.test(trimmed) || trimmed.startsWith('- ')) {
          lines.push(trimmed);
        } else {
          // Default: treat as a numbered step
          lines.push(trimmed);
        }
      }
    } else if (complexity === 'compound') {
      // Compound: multi-line bullet list with sub-bullets, preserve indentation
      const contentLines = rule.content.split('\n');
      for (const cl of contentLines) {
        if (!cl.trim()) continue;
        // Preserve indented sub-bullets (e.g., "  - sub item")
        if (/^\s+- /.test(cl)) {
          lines.push(cl);
        } else {
          const trimmed = cl.trim();
          lines.push(trimmed.startsWith('- ') ? trimmed : '- ' + trimmed);
        }
      }
    } else {
      // Simple (default): single-line or multi-line, each line gets a bullet
      const contentLines = rule.content.split('\n');
      for (const cl of contentLines) {
        const trimmed = cl.trim();
        if (!trimmed) continue;
        lines.push(trimmed.startsWith('- ') ? trimmed : '- ' + trimmed);
      }
    }

    lines.push(RULE_END);
    lines.push('');
  }

  lines.push(MANAGED_END);
  return lines.join('\n');
}

// --- Write ---

/**
 * Write rules (and optional skill routes) to CLAUDE.md.
 * @param {string} projectPath
 * @param {Array} rules - Non-methodology rules
 * @param {Array} [skillRoutes] - Skill routing entries from skillWriter
 */
function writeRulesToClaudeMd(projectPath, rules, skillRoutes) {
  const { path: mdPath, content, exists } = readClaudeMd(projectPath);
  const managedSection = buildManagedSection(rules, skillRoutes);
  const hasContent = (rules && rules.length > 0) || (skillRoutes && skillRoutes.length > 0);

  let newContent;

  if (!exists) {
    if (!hasContent) return null;
    newContent = '# CLAUDE.md\n' + managedSection + '\n';
  } else {
    const startIdx = content.indexOf(MANAGED_START);
    const endIdx = content.indexOf(MANAGED_END);

    if (startIdx === -1 || endIdx === -1) {
      // No managed section yet — append
      if (!hasContent) return null;
      newContent = content.trimEnd() + '\n' + managedSection + '\n';
    } else {
      // Find the section header (## Auto-learned Rules) before MANAGED_START
      let sectionStart = startIdx;
      const beforeManaged = content.slice(0, startIdx);
      const headerMatch = beforeManaged.match(/\n*(## Auto-learned Rules\s*\n*)$/);
      if (headerMatch) {
        sectionStart = startIdx - headerMatch[1].length;
      }

      const before = content.slice(0, sectionStart).trimEnd();
      const after = content.slice(endIdx + MANAGED_END.length).trimStart();

      if (rules.length === 0) {
        // Remove managed section entirely
        newContent = before + (after ? '\n\n' + after : '') + '\n';
      } else {
        newContent = before + '\n' + managedSection + (after ? '\n\n' + after : '') + '\n';
      }
    }
  }

  // Atomic write
  const tmp = mdPath + '.tmp';
  fs.writeFileSync(tmp, newContent, 'utf8');
  fs.renameSync(tmp, mdPath);

  return mdPath;
}

/**
 * Remove the managed section from CLAUDE.md entirely.
 */
function removeManagedSection(projectPath) {
  return writeRulesToClaudeMd(projectPath, []);
}

module.exports = {
  findClaudeMd, readClaudeMd, getHandWrittenContent,
  buildManagedSection, writeRulesToClaudeMd, removeManagedSection,
  MANAGED_START, MANAGED_END,
};
