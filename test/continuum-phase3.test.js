#!/usr/bin/env node
// continuum-phase3.test.js — Phase 3 test suite for the Continuum Writer feature
// Covers: Cross-project pattern store write, cross-project pattern matching/suggestion

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =====================================================================
// Helpers
// =====================================================================

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ce-p3-'));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// =====================================================================
// Group 1: Cross-project store write — 3 tests
//
// Tests the store-write logic from processRules.js lines 458-510.
// We replicate the logic in a helper to avoid needing full LLM pipeline.
// =====================================================================

/**
 * Replicate the cross-project store write logic from processRules.js.
 * This is the exact logic extracted from the source file (lines 470-509).
 */
function writeCrossProjectPatterns(xpPath, finalActive, project, projectType) {
  const ruleEnginePath = require.resolve('../learning/ruleEngine');
  // Use a fresh copy to avoid stale cache
  delete require.cache[ruleEnginePath];
  const ruleEngine = require('../learning/ruleEngine');

  let xpStore;
  try { xpStore = JSON.parse(fs.readFileSync(xpPath, 'utf8')); }
  catch { xpStore = { version: 1, patterns: [] }; }

  let xpAdded = 0;
  let xpUpdated = 0;

  for (const rule of finalActive) {
    if ((rule.score || 0) <= 7) continue;
    if ((rule.relevance_count || 0) < 5) continue;
    const cplx = rule.complexity || 'simple';
    if (cplx === 'simple') continue; // Only compound or higher

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
    fs.mkdirSync(path.dirname(xpPath), { recursive: true });
    fs.writeFileSync(xpPath, JSON.stringify(xpStore, null, 2) + '\n', 'utf8');
  }

  return { xpAdded, xpUpdated, xpStore };
}

/**
 * Replicate the cross-project suggestion logic from session-start.js lines 91-139.
 */
function getCrossProjectSuggestions(xpPath, projectPath, activeRules, currentProjectType) {
  const ruleEnginePath = require.resolve('../learning/ruleEngine');
  delete require.cache[ruleEnginePath];
  const ruleEngine = require('../learning/ruleEngine');

  let xpStore;
  try { xpStore = JSON.parse(fs.readFileSync(xpPath, 'utf8')); }
  catch { return []; }

  const patterns = xpStore.patterns || [];
  const suggestions = [];

  for (const xp of patterns) {
    if (xp.project_type !== currentProjectType) continue;
    if (xp.source_project === projectPath) continue;
    const alreadyExists = (activeRules || []).some(r =>
      ruleEngine.jaccardSimilarity(r.keywords || [], xp.keywords || []) > 0.5
    );
    if (alreadyExists) continue;
    suggestions.push(xp);
  }

  return suggestions;
}

describe('Cross-project store write', () => {
  let tmpDir;
  let xpPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    xpPath = path.join(tmpDir, 'cross_project_patterns.json');
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it('adds mature rule to store — compound+ with score > 7 and relevance >= 5', () => {
    const rules = [{
      id: 'r_mature1',
      content: 'When doing BQ analysis: dry_run first, filter by partition, confirm time range',
      keywords: ['bq', 'analysis', 'dry_run', 'partition', 'time'],
      score: 9,
      relevance_count: 8,
      complexity: 'compound',
      status: 'active',
    }];

    const result = writeCrossProjectPatterns(xpPath, rules, '/projects/alpha', 'analysis');

    assert.equal(result.xpAdded, 1, 'One pattern should be added');
    assert.ok(fs.existsSync(xpPath), 'cross_project_patterns.json should be created');

    const stored = JSON.parse(fs.readFileSync(xpPath, 'utf8'));
    assert.equal(stored.patterns.length, 1);
    assert.equal(stored.patterns[0].content, rules[0].content);
    assert.equal(stored.patterns[0].project_type, 'analysis');
    assert.equal(stored.patterns[0].source_project, '/projects/alpha');
    assert.equal(stored.patterns[0].score, 9);
    assert.equal(stored.patterns[0].complexity, 'compound');
  });

  it('skips low-score rules — score <= 7 or relevance < 5 or simple complexity', () => {
    const rules = [
      {
        id: 'r_low1', content: 'Low score rule',
        keywords: ['low', 'score'], score: 4, relevance_count: 10,
        complexity: 'compound', status: 'active',
      },
      {
        id: 'r_low2', content: 'Low relevance rule',
        keywords: ['low', 'relevance'], score: 9, relevance_count: 2,
        complexity: 'compound', status: 'active',
      },
      {
        id: 'r_low3', content: 'Simple complexity rule',
        keywords: ['simple', 'rule'], score: 9, relevance_count: 10,
        complexity: 'simple', status: 'active',
      },
    ];

    const result = writeCrossProjectPatterns(xpPath, rules, '/projects/beta', 'backend');

    assert.equal(result.xpAdded, 0, 'No patterns should be added');
    assert.ok(!fs.existsSync(xpPath), 'File should not be created when nothing to add');
  });

  it('deduplicates by keyword similarity — updates score instead of creating duplicate', () => {
    // First write: add a pattern
    const rules1 = [{
      id: 'r_dup1',
      content: 'Always dry-run BQ queries before execution',
      keywords: ['dry-run', 'bq', 'query', 'execution'],
      score: 8,
      relevance_count: 6,
      complexity: 'compound',
      status: 'active',
    }];
    writeCrossProjectPatterns(xpPath, rules1, '/projects/alpha', 'analysis');

    const afterFirst = JSON.parse(fs.readFileSync(xpPath, 'utf8'));
    assert.equal(afterFirst.patterns.length, 1);
    assert.equal(afterFirst.patterns[0].score, 8);

    // Second write: same keywords, higher score — should update, not add
    const rules2 = [{
      id: 'r_dup2',
      content: 'Run BQ dry-run before executing any query',
      keywords: ['dry-run', 'bq', 'query', 'execution'],
      score: 9.5,
      relevance_count: 10,
      complexity: 'compound',
      status: 'active',
    }];
    const result = writeCrossProjectPatterns(xpPath, rules2, '/projects/beta', 'analysis');

    assert.equal(result.xpUpdated, 1, 'Should update existing pattern');
    assert.equal(result.xpAdded, 0, 'Should NOT add duplicate');

    const afterSecond = JSON.parse(fs.readFileSync(xpPath, 'utf8'));
    assert.equal(afterSecond.patterns.length, 1, 'Still only one pattern');
    assert.equal(afterSecond.patterns[0].score, 9.5, 'Score should be updated to higher value');
  });
});

// =====================================================================
// Group 2: Cross-project pattern matching — 3 tests
// =====================================================================

describe('Cross-project pattern matching', () => {
  let tmpDir;
  let xpPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    xpPath = path.join(tmpDir, 'cross_project_patterns.json');
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it('suggests patterns matching project type', () => {
    // Create a cross-project store with an "analysis" pattern
    const xpStore = {
      version: 1,
      patterns: [{
        id: 'xp_test1',
        project_type: 'analysis',
        source_project: '/projects/alpha',
        content: 'Always dry-run BQ queries before execution',
        complexity: 'compound',
        score: 9,
        keywords: ['dry-run', 'bq', 'query'],
        sessions_observed: 8,
        created: '2026-04-01',
      }, {
        id: 'xp_test2',
        project_type: 'backend',
        source_project: '/projects/alpha',
        content: 'Use connection pooling for database access',
        complexity: 'compound',
        score: 8,
        keywords: ['connection', 'pool', 'database'],
        sessions_observed: 5,
        created: '2026-04-02',
      }],
    };
    fs.writeFileSync(xpPath, JSON.stringify(xpStore, null, 2), 'utf8');

    const suggestions = getCrossProjectSuggestions(
      xpPath,
      '/projects/beta',  // different project
      [],                 // no local rules
      'analysis'          // matching project type
    );

    assert.equal(suggestions.length, 1, 'Should suggest 1 pattern (analysis type only)');
    assert.equal(suggestions[0].id, 'xp_test1');
    assert.equal(suggestions[0].content, 'Always dry-run BQ queries before execution');
  });

  it('skips patterns from the same project', () => {
    const xpStore = {
      version: 1,
      patterns: [{
        id: 'xp_same1',
        project_type: 'analysis',
        source_project: '/projects/current',
        content: 'Filter by date partition',
        complexity: 'compound',
        score: 9,
        keywords: ['date', 'partition', 'filter'],
        sessions_observed: 6,
        created: '2026-04-01',
      }],
    };
    fs.writeFileSync(xpPath, JSON.stringify(xpStore, null, 2), 'utf8');

    const suggestions = getCrossProjectSuggestions(
      xpPath,
      '/projects/current',  // same project as source
      [],
      'analysis'
    );

    assert.equal(suggestions.length, 0, 'Should NOT suggest patterns from same project');
  });

  it('skips patterns that already exist locally (high keyword overlap)', () => {
    const xpStore = {
      version: 1,
      patterns: [{
        id: 'xp_overlap1',
        project_type: 'analysis',
        source_project: '/projects/alpha',
        content: 'Always dry-run BQ queries before execution',
        complexity: 'compound',
        score: 9,
        keywords: ['dry-run', 'bq', 'query', 'execution'],
        sessions_observed: 8,
        created: '2026-04-01',
      }],
    };
    fs.writeFileSync(xpPath, JSON.stringify(xpStore, null, 2), 'utf8');

    // Local rules have high keyword overlap with the cross-project pattern
    const localRules = [{
      id: 'r_local1',
      content: 'Run dry-run on BQ queries first',
      keywords: ['dry-run', 'bq', 'query', 'execution'],
      score: 7,
    }];

    const suggestions = getCrossProjectSuggestions(
      xpPath,
      '/projects/beta',  // different project
      localRules,         // has overlapping local rule
      'analysis'
    );

    assert.equal(suggestions.length, 0,
      'Should NOT suggest patterns that already exist locally (Jaccard > 0.5)');
  });
});
