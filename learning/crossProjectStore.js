#!/usr/bin/env node
// crossProjectStore.js — Manage cross-project pattern transfer
// Extracted from processRules.js for P3 refactor.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const XP_PATH = path.join(DATA_DIR, 'cross_project_patterns.json');

/**
 * Save mature rules to the cross-project pattern store.
 * @param {string} project - Project path
 * @param {Array} activeRules - Active rules to evaluate
 * @param {string} projectType - Project type (analysis, backend, etc.)
 * @param {Function} log - Logging function
 */
function savePatterns(project, activeRules, projectType, log) {
  try {
    const ruleEngine = require('./ruleEngine');

    let xpStore;
    try { xpStore = JSON.parse(fs.readFileSync(XP_PATH, 'utf8')); }
    catch { xpStore = { version: 1, patterns: [] }; }

    let xpAdded = 0;
    let xpUpdated = 0;

    for (const rule of activeRules) {
      if ((rule.score || 0) <= 7) continue;
      if ((rule.relevance_count || 0) < 5) continue;
      const cplx = rule.complexity || 'simple';
      if (cplx === 'simple') continue;

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
          complexity: cplx,
          score: rule.score,
          keywords: ruleKeywords,
          sessions_observed: rule.relevance_count || 0,
          created: new Date().toISOString().slice(0, 10),
        });
        xpAdded++;
      }
    }

    if (xpAdded > 0 || xpUpdated > 0) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = XP_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(xpStore, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, XP_PATH);
      if (log) log(`Cross-project store: ${xpAdded} added, ${xpUpdated} updated`);
    }
  } catch (err) {
    if (log) log(`XP store error: ${err.message}`);
  }
}

module.exports = { savePatterns };
