#!/usr/bin/env node
// post-tool.js — PostToolUse hook
// Fires on every tool call. Records full input/output as observations.
// Raw data is ephemeral (deleted after session-end processes it).
// Must be fast (< 100ms). Returns {} (no context injection).

const fs = require('fs');
const path = require('path');
const os = require('os');

// Session key: use PPID (parent Claude process) + date to scope temp file
const SESSION_KEY = `${process.ppid || 'unknown'}-${new Date().toISOString().slice(0, 10)}`;
const TEMP_FILE = path.join(os.tmpdir(), `claude-learning-${SESSION_KEY}.jsonl`);

// Max sizes to prevent temp file from growing unbounded
const MAX_INPUT_LEN = 2000;
const MAX_OUTPUT_LEN = 4000;

// DB table extraction: match FROM/JOIN clauses
function extractBqTables(sql) {
  const tables = [];
  const regex = /(?:FROM|JOIN)\s+`?([a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?)`?/gi;
  let m;
  while ((m = regex.exec(sql)) !== null) {
    tables.push(m[1].replace(/`/g, ''));
  }
  return [...new Set(tables)];
}

// Check if a bash command is a database query
function parseBqCommand(command) {
  if (!command || typeof command !== 'string') return null;
  if (!/bq\s/.test(command)) return null;
  const isDryRun = /--dry_run/.test(command);
  const tables = extractBqTables(command);
  return { isDryRun, tables };
}

// Truncate a string with a marker
function truncate(str, max) {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '…[truncated]';
}

// Serialize tool input for observation record
function serializeInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolName === 'Bash') return truncate(toolInput.command || '', MAX_INPUT_LEN);
  if (toolName === 'Read') return toolInput.file_path || '';
  if (toolName === 'Glob') return `${toolInput.pattern || ''}${toolInput.path ? ' in ' + toolInput.path : ''}`;
  if (toolName === 'Grep') return `/${toolInput.pattern || '/'} ${toolInput.path || ''}`;
  if (toolName === 'Edit') return `${toolInput.file_path || ''} | old: ${truncate(toolInput.old_string || '', 200)} → new: ${truncate(toolInput.new_string || '', 200)}`;
  if (toolName === 'Write') return `${toolInput.file_path || ''} (${(toolInput.content || '').length} chars)`;
  // MCP tools: serialize full input
  return truncate(JSON.stringify(toolInput), MAX_INPUT_LEN);
}

// Serialize tool output for observation record
function serializeOutput(toolName, toolOutput) {
  if (!toolOutput) return '';
  const str = typeof toolOutput === 'string' ? toolOutput
    : toolOutput.stdout ? toolOutput.stdout
    : JSON.stringify(toolOutput);
  return truncate(str, MAX_OUTPUT_LEN);
}

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

      const data = input.trim() ? JSON.parse(input) : {};
      const toolName = data.tool_name || '';
      const toolInput = data.tool_input || {};
      const toolOutput = data.tool_output || '';

      const record = {
        ts: Date.now(),
        tool: toolName,
        input: serializeInput(toolName, toolInput),
        output: serializeOutput(toolName, toolOutput),
      };

      // Special handling: BQ queries
      if (toolName === 'Bash' && toolInput.command) {
        const bq = parseBqCommand(toolInput.command);
        if (bq) {
          record.type = 'database_query';
          record.tables = bq.tables;
          record.isDryRun = bq.isDryRun;
          const outputStr = typeof toolOutput === 'string' ? toolOutput :
            (toolOutput && toolOutput.stdout) ? toolOutput.stdout : '';
          const bytesMatch = outputStr.match(/(\d+)\s+bytes/i);
          if (bytesMatch) record.bytesScanned = parseInt(bytesMatch[1], 10);
        }
      }

      // Special handling: any MCP tools
      if (toolName.startsWith('mcp__')) {
        record.type = 'mcp_action';
        record.mcpTool = toolName.replace('mcp__', '');
      }



      // Append to temp file (sync, fast for small writes)
      fs.appendFileSync(TEMP_FILE, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // Silently fail — never block the session
    }

    process.stdout.write(JSON.stringify({}));
  });

  // Timeout safety
  setTimeout(() => {
    if (handled) return;
    handled = true;
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }, 1500);
}

main();
