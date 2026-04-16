#!/usr/bin/env node
// analyzer.js — Lightweight user-learning analyzer
// Replaces the obfuscated evolve.js for personal learning use case.
// Three exports: analyzeSession, updateProfile, generateContext

const fs = require('fs');
const path = require('path');

const GENES_PATH = path.join(__dirname, 'genes.json');
const DEFAULT_PROFILE_PATH = path.join(__dirname, 'data', 'user_profile.json');

// --- Gene matching ---

function loadGenes() {
  try {
    return JSON.parse(fs.readFileSync(GENES_PATH, 'utf8')).genes || [];
  } catch { return []; }
}

function matchGenes(signals, genes) {
  const matched = [];
  for (const gene of genes) {
    const hits = (gene.signals_match || []).filter(s => signals.includes(s));
    if (hits.length > 0) matched.push({ gene: gene.id, hits });
  }
  return matched;
}

// --- Session analysis ---

function analyzeSession(sessionData) {
  const { tools = {}, dbQueries = [], mcpQueries = [], corrections = [], cwd = '' } = sessionData;
  const signals = [];
  const patterns = {};

  // Query pattern signals
  if (dbQueries.length > 0) {
    signals.push('database_query');
    const tables = {};
    for (const q of dbQueries) {
      for (const t of (q.tables || [])) {
        tables[t] = (tables[t] || 0) + 1;
      }
    }
    patterns.bq_tables = tables;
    patterns.db_query_count = dbQueries.length;
    if (dbQueries.some(q => q.isDryRun)) signals.push('bq_dry_run');
  }

  if (mcpQueries.length > 0) {
    signals.push('mcp_action');
    patterns.amp_query_count = mcpQueries.length;
    patterns.amp_tools = [...new Set(mcpQueries.map(q => q.tool))];
  }

  // Tool usage signals
  const totalToolCalls = Object.values(tools).reduce((a, b) => a + b, 0);
  if (totalToolCalls > 5) {
    signals.push('tool_usage_pattern');
    patterns.tool_counts = tools;
  }

  // MCP tool usage
  const mcpTools = Object.keys(tools).filter(t => t.startsWith('mcp__'));
  if (mcpTools.length > 0) {
    signals.push('mcp_tool_usage');
    patterns.mcp_tools = mcpTools;
  }

  // Corrections
  if (corrections.length > 0) {
    signals.push('analysis_correction');
    patterns.corrections = corrections;
  }

  // Project context
  patterns.project = detectProject(cwd);

  // Match genes
  const genes = loadGenes();
  const matched = matchGenes(signals, genes);

  return { signals, patterns, matched, totalToolCalls };
}

// --- Profile update ---

function readProfile(profilePath) {
  const p = profilePath || DEFAULT_PROFILE_PATH;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return createEmptyProfile();
  }
}

function createEmptyProfile() {
  return {
    schema_version: 1,
    last_updated: new Date().toISOString(),
    session_count: 0,
    query_patterns: {
      db_table_frequency: {},
      db_query_total: 0,
      mcp_query_total: 0,
      mcp_tools_used: [],
      learned_preferences: [],
    },
    analysis_methodology: {
      principles: [],
      corrections: [],
    },
    tool_usage: {
      cumulative: {},
      session_tool_averages: {},
      mcp_tools_seen: [],
    },
    communication_style: {
      language: 'auto',
      format_preferences: [],
      confirmed_patterns: [],
    },
    project_activity: {},
  };
}

function updateProfile(profilePath, analysis) {
  const p = profilePath || DEFAULT_PROFILE_PATH;
  const profile = readProfile(p);

  profile.last_updated = new Date().toISOString();
  profile.session_count = (profile.session_count || 0) + 1;

  const pat = analysis.patterns || {};

  // Update DB table frequency
  if (pat.bq_tables) {
    for (const [table, count] of Object.entries(pat.bq_tables)) {
      profile.query_patterns.db_table_frequency[table] =
        (profile.query_patterns.db_table_frequency[table] || 0) + count;
    }
    profile.query_patterns.db_query_total =
      (profile.query_patterns.db_query_total || 0) + (pat.db_query_count || 0);
  }

  // Update MCP tool usage
  if (pat.amp_query_count) {
    profile.query_patterns.mcp_query_total =
      (profile.query_patterns.mcp_query_total || 0) + pat.amp_query_count;
    const existing = new Set(profile.query_patterns.mcp_tools_used || []);
    for (const t of (pat.amp_tools || [])) existing.add(t);
    profile.query_patterns.mcp_tools_used = [...existing];
  }

  // Update tool usage cumulative
  if (pat.tool_counts) {
    for (const [tool, count] of Object.entries(pat.tool_counts)) {
      profile.tool_usage.cumulative[tool] =
        (profile.tool_usage.cumulative[tool] || 0) + count;
    }
  }

  // Update MCP tools seen
  if (pat.mcp_tools) {
    const existing = new Set(profile.tool_usage.mcp_tools_seen || []);
    for (const t of pat.mcp_tools) existing.add(t);
    profile.tool_usage.mcp_tools_seen = [...existing];
  }

  // Append corrections (dedup by content, keep last 20)
  if (pat.corrections && pat.corrections.length > 0) {
    const existing = profile.analysis_methodology.corrections || [];
    for (const c of pat.corrections) {
      if (!existing.some(e => e.what === c.what)) {
        existing.push({ date: new Date().toISOString().slice(0, 10), ...c });
      }
    }
    profile.analysis_methodology.corrections = existing.slice(-20);
  }

  // Update project activity
  if (pat.project) {
    profile.project_activity[pat.project] =
      (profile.project_activity[pat.project] || 0) + 1;
  }

  // Write back
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);

  return profile;
}

// --- Context generation for SessionStart ---

function generateContext(profilePath, cwd) {
  const profile = readProfile(profilePath || DEFAULT_PROFILE_PATH);
  const hasContent = profile && (
    profile.session_count > 0 ||
    (profile.query_patterns.learned_preferences || []).length > 0 ||
    (profile.analysis_methodology.principles || []).length > 0 ||
    (profile.analysis_methodology.corrections || []).length > 0 ||
    (profile.communication_style.format_preferences || []).length > 0
  );
  if (!hasContent) return '';

  const lines = ['[User Learning Profile]'];

  // Query patterns
  const topTables = Object.entries(profile.query_patterns.db_table_frequency || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${t} (${c}x)`);
  if (topTables.length > 0) {
    lines.push(`- Top DB tables: ${topTables.join(', ')}`);
  }
  if (profile.query_patterns.db_query_total > 0) {
    lines.push(`- DB queries run: ${profile.query_patterns.db_query_total} total across ${profile.session_count} sessions`);
  }
  if (profile.query_patterns.learned_preferences.length > 0) {
    lines.push(`- Learned preferences: ${profile.query_patterns.learned_preferences.join('; ')}`);
  }

  // Analysis methodology
  const corrections = profile.analysis_methodology.corrections || [];
  const recent = corrections.slice(-3);
  if (recent.length > 0) {
    lines.push('- Recent corrections:');
    for (const c of recent) {
      lines.push(`  - [${c.date}] ${c.what}${c.lesson ? ' -> ' + c.lesson : ''}`);
    }
  }
  if (profile.analysis_methodology.principles.length > 0) {
    lines.push(`- Analysis principles: ${profile.analysis_methodology.principles.join('; ')}`);
  }

  // Communication style
  const style = profile.communication_style;
  if (style.format_preferences.length > 0) {
    lines.push(`- Style: ${style.format_preferences.join(', ')}`);
  }

  // Top tools
  const topTools = Object.entries(profile.tool_usage.cumulative || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${t}(${c})`);
  if (topTools.length > 0) {
    lines.push(`- Top tools: ${topTools.join(', ')}`);
  }

  // Active project
  const currentProject = detectProject(cwd || process.cwd());
  if (currentProject && profile.project_activity[currentProject]) {
    lines.push(`- Current project: ${currentProject} (${profile.project_activity[currentProject]} prior sessions)`);
  }

  if (lines.length <= 1) return '';
  return lines.join('\n');
}

// --- Helpers ---

function detectProject(cwd) {
  if (!cwd) return 'unknown';
  const githubIdx = cwd.indexOf('Documents/GitHub/');
  if (githubIdx === -1) return path.basename(cwd);
  const rel = cwd.slice(githubIdx + 'Documents/GitHub/'.length);
  // Return first two path segments (e.g., "MyProject/subdir")
  const parts = rel.split('/').filter(Boolean);
  return parts.slice(0, 2).join('/') || parts[0] || 'unknown';
}

module.exports = { analyzeSession, updateProfile, generateContext, readProfile, createEmptyProfile, detectProject };
