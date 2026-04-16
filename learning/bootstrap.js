#!/usr/bin/env node
// bootstrap.js — Creates initial user_profile.json from existing Claude memory files.
// Run once: node bootstrap.js

const fs = require('fs');
const path = require('path');
const { createEmptyProfile } = require('./analyzer');

const PROFILE_PATH = path.join(__dirname, 'data', 'user_profile.json');
const CLAUDE_PROJECTS_DIR = path.join(require('os').homedir(), '.claude', 'projects');

function readMemoryFiles() {
  const memories = [];
  try {
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
    for (const proj of projects) {
      const memDir = path.join(CLAUDE_PROJECTS_DIR, proj, 'memory');
      if (!fs.existsSync(memDir)) continue;
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(memDir, f), 'utf8');
          const frontmatter = parseFrontmatter(content);
          memories.push({
            file: f,
            project: proj,
            type: frontmatter.type || 'unknown',
            name: frontmatter.name || f,
            description: frontmatter.description || '',
            body: content.replace(/^---[\s\S]*?---\n*/, '').trim(),
          });
        } catch {}
      }
    }
  } catch {}
  return memories;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const [key, ...vals] = line.split(':');
    if (key && vals.length) result[key.trim()] = vals.join(':').trim();
  }
  return result;
}

function bootstrap() {
  const profile = createEmptyProfile();
  const memories = readMemoryFiles();

  console.log(`Found ${memories.length} memory files across projects.\n`);

  // --- Seed from feedback memories ---

  const feedbacks = memories.filter(m => m.type === 'feedback');
  console.log(`Processing ${feedbacks.length} feedback memories...`);

  for (const fb of feedbacks) {
    const name = fb.name.toLowerCase();
    const body = fb.body.toLowerCase();

    // Analysis methodology
    if (name.includes('methodology') || name.includes('analysis') || name.includes('retention')) {
      profile.analysis_methodology.corrections.push({
        date: '2026-04-01',
        what: fb.description || fb.name,
        lesson: fb.body.slice(0, 200),
        source: fb.file,
      });
    }

    // DB query patterns
    if (name.includes('bq') || name.includes('query') || name.includes('dryrun')) {
      if (body.includes('20 gb') || body.includes('20gb')) {
        profile.query_patterns.learned_preferences.push('BQ dry-run < 20GB: auto-approve');
      }
      }
      if (body.includes('event_type')) {
      }
      if (body.includes('combine') || body.includes('single pass')) {
      }
    }

    // dbt patterns
    if (name.includes('dbt') || body.includes('dbt')) {
      profile.analysis_methodology.principles.push(
        'dbt incremental column removal needs --full-refresh'
      );
    }

    // Communication style
    if (name.includes('em_dash') || name.includes('em dash')) {
      profile.communication_style.format_preferences.push('No em dashes in writing');
    }
    if (name.includes('notion') && body.includes('minimal')) {
      profile.communication_style.format_preferences.push('Keep Notion updates minimal');
    }
    if (name.includes('auto_execute') || body.includes('without asking')) {
      profile.communication_style.confirmed_patterns.push('Prefer auto-execution over confirmation prompts');
    }

    // Docker/infra patterns
    if (name.includes('docker') || name.includes('hotpatch')) {
      profile.analysis_methodology.principles.push(
        'Hot-patch running Docker containers for fast iteration'
      );
    }
    if (name.includes('chrome') && body.includes('cookies')) {
      profile.analysis_methodology.principles.push(
        'Use cookies.json for cross-platform Chrome sessions (Mac profiles incompatible with Linux Docker)'
      );
    }
  }

  // --- Seed from reference memories ---

  const refs = memories.filter(m => m.type === 'reference');
  console.log(`Processing ${refs.length} reference memories...`);

  for (const ref of refs) {
      profile.query_patterns.learned_preferences.push(
      );
    }
  }

  // --- Seed from CLAUDE.md ---

  profile.communication_style.language = 'auto';
  profile.communication_style.format_preferences.push('Concise bullet points');
  );
  profile.analysis_methodology.principles.push(
    'Flow: Base -> Filters -> Metrics (never reverse)'
  );
  profile.analysis_methodology.principles.push(
    'Sanity check: MAU > DAU, ratios make sense'
  );

  // Deduplicate arrays
  profile.query_patterns.learned_preferences = [...new Set(profile.query_patterns.learned_preferences)];
  profile.analysis_methodology.principles = [...new Set(profile.analysis_methodology.principles)];
  profile.communication_style.format_preferences = [...new Set(profile.communication_style.format_preferences)];
  profile.communication_style.confirmed_patterns = [...new Set(profile.communication_style.confirmed_patterns)];

  // Write profile
  fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  console.log(`\nProfile written to: ${PROFILE_PATH}`);
  console.log(`  - ${profile.query_patterns.learned_preferences.length} query preferences`);
  console.log(`  - ${profile.analysis_methodology.principles.length} methodology principles`);
  console.log(`  - ${profile.analysis_methodology.corrections.length} corrections`);
  console.log(`  - ${profile.communication_style.format_preferences.length} style preferences`);
}

bootstrap();
