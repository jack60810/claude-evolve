#!/usr/bin/env node
// skillHints.js — Manage skill maturity hints for session-start injection
// Extracted from processRules.js for P3 refactor.

const path = require('path');
const { DATA_DIR } = require('./paths');
const { readJson, writeJsonAtomic, withLock } = require('./fsutil');

const HINTS_PATH = path.join(DATA_DIR, 'skill_hints.json');

/**
 * Update skill hints after solidify (locked read-modify-write; session-start marks them shown).
 * Cleans up shown hints, adds new ones for methodology-level rules.
 * @param {Array} methodologyRules - Rules at methodology complexity level
 * @param {Function} log - Logging function
 */
function updateHints(methodologyRules, log) {
  try {
    withLock(HINTS_PATH, () => {
      const hints = readJson(HINTS_PATH, () => ({ hints: [] }));
      const before = JSON.stringify(hints);
      hints.hints = (hints.hints || []).filter(h => !h.shown);

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

      if (JSON.stringify(hints) !== before) writeJsonAtomic(HINTS_PATH, hints);
    });
  } catch (err) {
    if (log) log(`Skill hints error: ${err.message}`);
  }
}

module.exports = { updateHints, HINTS_PATH };
