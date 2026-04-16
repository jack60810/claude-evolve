#!/usr/bin/env node
// analyzer.js — Session statistics aggregator for claude-evolve
// Written from scratch. No code from GPL-licensed upstream.
//
// Aggregates per-session tool usage into a persistent user profile.
// Generates a compact context string for session-start injection.

const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE_PATH = path.join(__dirname, 'data', 'user_profile.json');

// ===================== Session analysis =====================

function analyzeSession(sessionData) {
  const { tools = {}, dbQueries = [], mcpQueries = [], cwd = '' } = sessionData;
  const signals = [];
  const patterns = {};

  if (dbQueries.length > 0) {
    signals.push('database_query');
    const tables = {};
    for (const q of dbQueries) {
      for (const t of (q.tables || [])) tables[t] = (tables[t] || 0) + 1;
    }
    patterns.db_tables = tables;
    patterns.db_query_count = dbQueries.length;
    if (dbQueries.some(q => q.isDryRun)) signals.push('db_dry_run');
  }

  if (mcpQueries.length > 0) {
    signals.push('mcp_action');
    patterns.mcp_query_count = mcpQueries.length;
    patterns.mcp_tools = [...new Set(mcpQueries.map(q => q.tool))];
  }

  const totalToolCalls = Object.values(tools).reduce((a, b) => a + b, 0);
  if (totalToolCalls > 5) {
    signals.push('tool_usage_pattern');
    patterns.tool_counts = tools;
  }

  const mcpTools = Object.keys(tools).filter(t => t.startsWith('mcp__'));
  if (mcpTools.length > 0) {
    signals.push('mcp_tool_usage');
    patterns.mcp_tools_used = mcpTools;
  }

  patterns.project = detectProject(cwd);

  return { signals, patterns, totalToolCalls };
}

// ===================== Profile management =====================

function createEmptyProfile() {
  return {
    version: 2,
    last_updated: new Date().toISOString(),
    session_count: 0,
    db_patterns: {
      table_frequency: {},
      query_total: 0,
    },
    mcp_patterns: {
      query_total: 0,
      tools_used: [],
    },
    tool_usage: {},
    project_activity: {},
  };
}

function readProfile(profilePath) {
  try {
    return JSON.parse(fs.readFileSync(profilePath || DEFAULT_PROFILE_PATH, 'utf8'));
  } catch {
    return createEmptyProfile();
  }
}

function updateProfile(profilePath, analysis) {
  const p = profilePath || DEFAULT_PROFILE_PATH;
  const profile = readProfile(p);

  profile.last_updated = new Date().toISOString();
  profile.session_count = (profile.session_count || 0) + 1;

  const pat = analysis.patterns || {};

  // DB table frequency
  if (pat.db_tables) {
    if (!profile.db_patterns) profile.db_patterns = { table_frequency: {}, query_total: 0 };
    for (const [table, count] of Object.entries(pat.db_tables)) {
      profile.db_patterns.table_frequency[table] =
        (profile.db_patterns.table_frequency[table] || 0) + count;
    }
    profile.db_patterns.query_total = (profile.db_patterns.query_total || 0) + (pat.db_query_count || 0);
  }

  // MCP tool usage
  if (pat.mcp_query_count) {
    if (!profile.mcp_patterns) profile.mcp_patterns = { query_total: 0, tools_used: [] };
    profile.mcp_patterns.query_total = (profile.mcp_patterns.query_total || 0) + pat.mcp_query_count;
    const seen = new Set(profile.mcp_patterns.tools_used || []);
    for (const t of (pat.mcp_tools || [])) seen.add(t);
    profile.mcp_patterns.tools_used = [...seen];
  }

  // Tool usage
  if (pat.tool_counts) {
    if (!profile.tool_usage) profile.tool_usage = {};
    for (const [tool, count] of Object.entries(pat.tool_counts)) {
      profile.tool_usage[tool] = (profile.tool_usage[tool] || 0) + count;
    }
  }

  // Project activity
  if (pat.project) {
    if (!profile.project_activity) profile.project_activity = {};
    profile.project_activity[pat.project] = (profile.project_activity[pat.project] || 0) + 1;
  }

  // Write
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);

  return profile;
}

// ===================== Context generation =====================

function generateContext(profilePath, cwd) {
  const profile = readProfile(profilePath || DEFAULT_PROFILE_PATH);
  if (!profile || profile.session_count === 0) return '';

  const lines = [];

  // Top DB tables
  const tableFreq = (profile.db_patterns && profile.db_patterns.table_frequency) || {};
  const topTables = Object.entries(tableFreq)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([t, c]) => `${t} (${c}x)`);
  if (topTables.length > 0) lines.push(`DB tables: ${topTables.join(', ')}`);

  // Top tools
  const topTools = Object.entries(profile.tool_usage || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([t, c]) => `${t}(${c})`);
  if (topTools.length > 0) lines.push(`Top tools: ${topTools.join(', ')}`);

  // Current project
  const proj = detectProject(cwd || process.cwd());
  if (proj && profile.project_activity && profile.project_activity[proj]) {
    lines.push(`Project: ${proj} (${profile.project_activity[proj]} sessions)`);
  }

  return lines.length > 0 ? '[Profile] ' + lines.join(' | ') : '';
}

// ===================== Helpers =====================

function detectProject(cwd) {
  if (!cwd) return 'unknown';
  // Find common code directory markers
  const markers = ['/GitHub/', '/Projects/', '/repos/', '/src/', '/workspace/'];
  let bestIdx = -1;
  let markerLen = 0;
  for (const m of markers) {
    const idx = cwd.indexOf(m);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      markerLen = m.length;
    }
  }
  if (bestIdx === -1) return path.basename(cwd);
  const rel = cwd.slice(bestIdx + markerLen);
  const parts = rel.split('/').filter(Boolean);
  return parts.slice(0, 2).join('/') || parts[0] || 'unknown';
}

module.exports = { analyzeSession, updateProfile, generateContext, readProfile, createEmptyProfile, detectProject };
