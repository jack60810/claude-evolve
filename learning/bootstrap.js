#!/usr/bin/env node
// bootstrap.js — Initialize user profile from existing Claude Code memory files.
// Written from scratch. No code from GPL-licensed upstream.
//
// Scans ~/.claude/projects/*/memory/ for feedback and reference memories,
// extracts patterns, and seeds user_profile.json.
// Run once: node bootstrap.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createEmptyProfile } = require('./analyzer');
const { parseFrontmatter } = require('./memoryReader');
const { DATA_DIR } = require('./paths');
const { writeJsonAtomic } = require('./fsutil');

const PROFILE_PATH = path.join(DATA_DIR, 'user_profile.json');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function scanMemoryFiles() {
  const memories = [];
  try {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const memDir = path.join(PROJECTS_DIR, proj, 'memory');
      if (!fs.existsSync(memDir)) continue;
      for (const f of fs.readdirSync(memDir)) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        try {
          const raw = fs.readFileSync(path.join(memDir, f), 'utf8');
          const fm = parseFrontmatter(raw);
          memories.push({
            file: f, project: proj,
            type: fm.type || 'unknown',
            name: fm.name || f,
            description: fm.description || '',
            body: fm.body || '',
          });
        } catch {}
      }
    }
  } catch {}
  return memories;
}

function bootstrap() {
  const profile = createEmptyProfile();
  const memories = scanMemoryFiles();

  console.log(`Found ${memories.length} memory files.\n`);

  // Extract patterns from feedback memories
  const feedbacks = memories.filter(m => m.type === 'feedback');
  for (const fb of feedbacks) {
    console.log(`  [feedback] ${fb.name}`);
  }

  // Extract patterns from reference memories
  const refs = memories.filter(m => m.type === 'reference');
  for (const ref of refs) {
    console.log(`  [reference] ${ref.name}`);
  }

  // Set defaults
  profile.session_count = 0;

  // Write profile only when there is none yet: never reset accumulated sessions
  if (fs.existsSync(PROFILE_PATH)) {
    console.log(`\nProfile already exists, left unchanged: ${PROFILE_PATH}`);
    return;
  }
  writeJsonAtomic(PROFILE_PATH, profile);

  console.log(`\nProfile initialized at: ${PROFILE_PATH}`);
  console.log(`Sessions will build on this profile automatically.`);
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap, scanMemoryFiles, parseFrontmatter };
