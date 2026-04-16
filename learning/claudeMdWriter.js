#!/usr/bin/env node
// claudeMdWriter.js — Read/write auto-learned rules in project CLAUDE.md
// Manages a fenced section marked by HTML comments, never touches hand-written content.

const fs = require('fs');
const path = require('path');

const MANAGED_START = '<!-- evolver:managed-start -->';
const MANAGED_END = '<!-- evolver:managed-end -->';

function ruleTag(rule) {
  return `<!-- evolver:rule id=${rule.id} fitness=${rule.fitness} created=${rule.created} source=${rule.source} -->`;
}
const RULE_END = '<!-- /evolver:rule -->';

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

function buildManagedSection(rules) {
  if (!rules || rules.length === 0) return '';

  const lines = [
    '',
    '## Auto-learned Rules',
    '',
    MANAGED_START,
    '',
  ];

  for (const rule of rules) {
    lines.push(ruleTag(rule));
    // Support multi-line content (distilled rules)
    const contentLines = rule.content.split('\n');
    for (const cl of contentLines) {
      const trimmed = cl.trim();
      if (!trimmed) continue;
      // Ensure each line starts with a bullet
      lines.push(trimmed.startsWith('- ') ? trimmed : '- ' + trimmed);
    }
    lines.push(RULE_END);
    lines.push('');
  }

  lines.push(MANAGED_END);
  return lines.join('\n');
}

// --- Write ---

function writeRulesToClaudeMd(projectPath, rules) {
  const { path: mdPath, content, exists } = readClaudeMd(projectPath);
  const managedSection = buildManagedSection(rules);

  let newContent;

  if (!exists) {
    if (rules.length === 0) return null; // Nothing to write, no file to create
    newContent = '# CLAUDE.md\n' + managedSection + '\n';
  } else {
    const startIdx = content.indexOf(MANAGED_START);
    const endIdx = content.indexOf(MANAGED_END);

    if (startIdx === -1 || endIdx === -1) {
      // No managed section yet — append
      if (rules.length === 0) return null;
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
