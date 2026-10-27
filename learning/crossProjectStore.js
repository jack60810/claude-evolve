#!/usr/bin/env node
// crossProjectStore.js — Manage cross-project pattern transfer
// Extracted from processRules.js for P3 refactor.

const path = require('path');
const { DATA_DIR } = require('./paths');
const { readJson, writeJsonAtomic, withLock } = require('./fsutil');

const XP_PATH = path.join(DATA_DIR, 'cross_project_patterns.json');

/**
 * Save mature rules to the cross-project pattern store (locked read-modify-write).
 * @param {string} project - Project root
 * @param {Array} activeRules - Active rules to evaluate
 * @param {string} projectType - Project type (analysis, backend, etc.)
 * @param {Function} log - Logging function
 */
function savePatterns(project, activeRules, projectType, log) {
  try {
    const ruleEngine = require('./ruleEngine');
    const mature = (activeRules || []).filter(rule =>
      (rule.score || 0) > 7 && (rule.relevance_count || 0) >= 5 && (rule.complexity || 'simple') !== 'simple');
    if (mature.length === 0) return;

    withLock(XP_PATH, () => {
      const xpStore = readJson(XP_PATH, () => ({ version: 1, patterns: [] }));
      if (!Array.isArray(xpStore.patterns)) xpStore.patterns = [];
      let xpAdded = 0;
      let xpUpdated = 0;

      for (const rule of mature) {
        const ruleKeywords = rule.keywords || [];
        const existing = xpStore.patterns.find(xp =>
          ruleEngine.jaccardSimilarity(xp.keywords || [], ruleKeywords) > 0.5
        );

        if (existing) {
          if ((rule.score || 0) > (existing.score || 0)) {
            existing.score = rule.score;
            existing.sessions_observed = (existing.sessions_observed || 0) + 1;
            xpUpdated++;
          }
        } else {
          xpStore.patterns.push({
            id: 'xp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            project_type: projectType,
            source_project: project,
            content: rule.content,
            complexity: rule.complexity,
            score: rule.score,
            keywords: ruleKeywords,
            sessions_observed: rule.relevance_count || 0,
            created: new Date().toISOString().slice(0, 10),
          });
          xpAdded++;
        }
      }

      if (xpAdded > 0 || xpUpdated > 0) {
        writeJsonAtomic(XP_PATH, xpStore);
        if (log) log(`Cross-project store: ${xpAdded} added, ${xpUpdated} updated`);
      }
    });
  } catch (err) {
    if (log) log(`XP store error: ${err.message}`);
  }
}

module.exports = { savePatterns, XP_PATH };
