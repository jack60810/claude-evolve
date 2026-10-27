#!/usr/bin/env node
// post-tool.js — PostToolUse hook
// Fires on every tool call. Records redacted input/output as observations in a temp file
// keyed by the session_id of the hook payload (see sessionMemory.observationFile).
// Raw data is ephemeral (deleted after session-end processes it).
// Must be fast: exits as soon as the record is appended. Prints nothing.

const fs = require('fs');
const path = require('path');

const LEARNING_ROOT = path.join(__dirname, '..');
const { DATA_DIR, CHILD_ENV } = require(path.join(LEARNING_ROOT, 'paths'));
const { appendBounded } = require(path.join(LEARNING_ROOT, 'fsutil'));
const { redact, redactJson } = require(path.join(LEARNING_ROOT, 'redact'));
const sessionMemory = require(path.join(LEARNING_ROOT, 'sessionMemory'));

const ERROR_LOG = path.join(DATA_DIR, 'hook_errors.log');

// Max sizes to prevent temp file from growing unbounded
const MAX_INPUT_LEN = 2000;
const MAX_OUTPUT_LEN = 4000;
// Redact a little past the cap, so a secret straddling the cut is still caught whole.
const REDACT_SLACK = 1000;

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

// Redact, then truncate
function clip(value, max) {
  if (value == null) return '';
  const str = String(value);
  return truncate(redact(str.length > max + REDACT_SLACK ? str.slice(0, max + REDACT_SLACK) : str), max);
}

// Serialize tool input for observation record
function serializeInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolName === 'Bash') return clip(toolInput.command || '', MAX_INPUT_LEN);
  if (toolName === 'Read') return clip(toolInput.file_path || '', MAX_INPUT_LEN);
  if (toolName === 'Glob') return clip(`${toolInput.pattern || ''}${toolInput.path ? ' in ' + toolInput.path : ''}`, MAX_INPUT_LEN);
  if (toolName === 'Grep') return clip(`/${toolInput.pattern || '/'} ${toolInput.path || ''}`, MAX_INPUT_LEN);
  if (toolName === 'Edit') return `${clip(toolInput.file_path, 500)} | old: ${clip(toolInput.old_string, 200)} → new: ${clip(toolInput.new_string, 200)}`;
  if (toolName === 'Write') return `${clip(toolInput.file_path, 500)} (${(toolInput.content || '').length} chars)`;
  // MCP tools: serialize full input
  return truncate(redactJson(toolInput, MAX_INPUT_LEN + REDACT_SLACK), MAX_INPUT_LEN);
}

// Plain text of a tool_response. Claude Code sends a string or an object:
// Bash { stdout, stderr }, MCP [{ type: 'text', text }] or { content: [...] }, Read { file },
// Edit/Write echo whole files (originalFile, structuredPatch, content), which are dropped.
function responseText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res)) return res.map(responseText).filter(Boolean).join('\n');
  if (typeof res !== 'object') return String(res);
  if (typeof res.stdout === 'string' || typeof res.stderr === 'string') {
    return [res.stdout, res.stderr ? `[stderr] ${res.stderr}` : ''].filter(Boolean).join('\n');
  }
  if (typeof res.text === 'string') return res.text;
  if (Array.isArray(res.content)) return responseText(res.content);
  if (res.file && typeof res.file.content === 'string') return res.file.content;
  const { originalFile, structuredPatch, ...rest } = res;
  if (rest.filePath) delete rest.content;
  return redactJson(rest, MAX_OUTPUT_LEN + REDACT_SLACK);
}

// Serialize tool output for observation record
function serializeOutput(toolResponse) {
  return clip(responseText(toolResponse), MAX_OUTPUT_LEN);
}

function logError(err, input) {
  try {
    appendBounded(ERROR_LOG, `${new Date().toISOString()} [post-tool] ${err && err.stack || err} | payload: ${clip(input, 300)}`);
  } catch {}
}

function handle(input) {
  if (!input.trim()) return;
  const data = JSON.parse(input);
  const toolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  const toolResponse = data.tool_response !== undefined ? data.tool_response : data.tool_output;

  const record = {
    ts: Date.now(),
    tool: toolName,
    input: serializeInput(toolName, toolInput),
    output: serializeOutput(toolResponse),
  };

  // Special handling: BQ queries
  if (toolName === 'Bash' && toolInput.command) {
    const bq = parseBqCommand(toolInput.command);
    if (bq) {
      record.type = 'database_query';
      record.tables = bq.tables;
      record.isDryRun = bq.isDryRun;
      const bytesMatch = responseText(toolResponse).match(/(\d+)\s+bytes/i);
      if (bytesMatch) record.bytesScanned = parseInt(bytesMatch[1], 10);
    }
  }

  // Special handling: any MCP tools
  if (toolName.startsWith('mcp__')) {
    record.type = 'mcp_action';
    record.mcpTool = toolName.replace('mcp__', '');
  }

  const file = sessionMemory.observationFile(sessionMemory.sessionKey(data));
  sessionMemory.startObservationFile(file, data.session_id || null, data.cwd || process.cwd());
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function main() {
  // Child of the processor (its own `claude` calls): record nothing.
  if (process.env[CHILD_ENV] === '1') return;

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try { handle(input); } catch (err) { logError(err, input); }
  });

  // Safety net if stdin never closes. unref: it never keeps a finished hook alive.
  setTimeout(() => process.exit(0), 1500).unref();
}

main();
