#!/usr/bin/env node
// skillHints.js — Manage skill maturity hints for session-start injection
// Extracted from processRules.js for P3 refactor.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HINTS_PATH = path.join(DATA_DIR, 'skill_hints.json');

/**
 * Update skill hints after solidify.
 * Cleans up shown hints, adds new ones for methodology-level rules.
 * @param {Array} methodologyRules - Rules at methodology complexity level
 * @param {Function} log - Logging function
 */
function updateHints(methodologyRules, log) {
  try {
    let hints = { hints: [] };
    try { hints = JSON.parse(fs.readFileSync(HINTS_PATH, 'utf8')); } catch {}

    hints.hints = hints.hints.filter(h => !h.shown);

    for (const rule of (methodologyRules || [])) {
      if (!hints.hints.some(h => h.pattern_id === rule.id)) {
        const kw = (rule.keywords || []).slice(0, 3).join(', ');
        hints.hints.push({
          pattern_id: rule.id,
          message: `Your ${kw} workflow is mature (${rule.sessions_evaluated || 0} sessions). A skill has been created.`,
          shown: false,
        });
      }
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = HINTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hints, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, HINTS_PATH);
  } catch (err) {
    if (log) log(`Skill hints error: ${err.message}`);
  }
}

module.exports = { updateHints };
