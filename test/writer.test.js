#!/usr/bin/env node
// writer.test.js — Rules file writer and skill files
// Covers: legacy marker migration, single heading, markers inside rule text, quoted markers,
// unchanged-bytes skip, symlink preservation, skill dir format, info/exclude, flat skill
// migration, reconcile and routes. Offline: temp data dir and HOME, no LLM calls.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-writer-')));
process.env.CLAUDE_EVOLVE_DATA_DIR = path.join(SANDBOX, 'data');
process.env.HOME = path.join(SANDBOX, 'home');

const writer = require('../learning/claudeMdWriter');
const skillWriter = require('../learning/skillWriter');
const llmBrain = require('../learning/llmBrain');

const TARGET = writer.RULES_FILENAME;
let n = 0;

function project({ git = false } = {}) {
  const dir = path.join(SANDBOX, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  if (git) execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function readAll(dir) {
  return writer.INSTRUCTION_FILES.map(f => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; }
  }).join('\n');
}

const count = (text, needle) => text.split(needle).length - 1;
const rule = (id, content, extra) => ({ id, content, complexity: 'simple', score: 5, ...extra });

describe('claudeMdWriter.writeRules', () => {
  it('migrates legacy evolver blocks: keeps rules still active, drops the rest, one heading', () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), [
      '# CLAUDE.md', '', '- hand-written user rule', '',
      '## Auto-learned Rules', '',
      '<!-- evolver:managed-start -->', '',
      '<!-- evolver:rule id=r_keep score=21 created=2026-04-16 source=observation -->',
      '- Old rule that is still active',
      '<!-- /evolver:rule -->', '',
      '<!-- evolver:rule id=r_gone score=18 created=2026-04-16 source=observation -->',
      '- After shipping, post to Slack #dev',
      '<!-- /evolver:rule -->', '',
      '<!-- evolver:managed-end -->', '',
      '## Auto-learned Rules', '',
      '<!-- claude-evolve:managed-start -->', '',
      '<!-- claude-evolve:rule id=r_new score=5.4 created=2026-04-18 source=observation complexity=simple -->',
      '- Newer rule',
      '<!-- /claude-evolve:rule -->', '',
      '<!-- claude-evolve:managed-end -->', '',
    ].join('\n'));

    // rules.json says r_keep and r_new are active; r_gone was demoted
    writer.writeRules(dir, [rule('r_keep', 'Old rule that is still active'), rule('r_new', 'Newer rule')]);

    const all = readAll(dir);
    assert.equal(count(all, '## Auto-learned Rules'), 1, 'exactly one heading');
    assert.ok(!all.includes('evolver:managed') && !all.includes('evolver:rule'), 'legacy markers gone');
    assert.ok(all.includes('Old rule that is still active') && all.includes('Newer rule'));
    assert.ok(!all.includes('Slack'), 'demoted legacy rule dropped');
    assert.ok(!all.includes('score='), 'no metadata in tags');
    assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('- hand-written user rule'), 'hand-written content kept');
    assert.equal(count(fs.readFileSync(path.join(dir, TARGET), 'utf8'), writer.MANAGED_START), 1);
  });

  it('repeated writes never duplicate the heading or the block', () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, TARGET), '# Notes\n- mine\n');
    for (let i = 0; i < 3; i++) writer.writeRules(dir, [rule('r1', `rule text ${i}`)]);
    const text = fs.readFileSync(path.join(dir, TARGET), 'utf8');
    assert.equal(count(text, '## Auto-learned Rules'), 1);
    assert.equal(count(text, writer.MANAGED_START), 1);
    assert.equal(count(text, writer.MANAGED_END), 1);
    assert.ok(text.includes('rule text 2') && !text.includes('rule text 1'));
  });

  it('marker text inside a rule cannot break the block', () => {
    const dir = project();
    const rules = [
      rule('r1', 'Never edit between <!-- claude-evolve:managed-start --> and\n<!-- claude-evolve:managed-end --> markers'),
      rule('r2', 'second rule'),
    ];
    for (let i = 0; i < 3; i++) writer.writeRules(dir, rules);
    const text = fs.readFileSync(path.join(dir, TARGET), 'utf8');
    assert.equal(count(text, 'second rule'), 1, 'no growth across writes');
    assert.equal(count(text, writer.MANAGED_START), 1);
    assert.equal(count(text, writer.MANAGED_END), 1);
  });

  it('a marker quoted inside a line of user text is not treated as a marker', () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, TARGET), [
      '# Notes', 'The hook writes after `<!-- claude-evolve:managed-start -->` markers.', '',
      '## My section', '- KEEP THIS USER RULE', '',
      '## Auto-learned Rules', '', writer.MANAGED_START, writer.MANAGED_END, '',
    ].join('\n'));
    writer.writeRules(dir, [rule('r1', 'new rule')]);
    const text = fs.readFileSync(path.join(dir, TARGET), 'utf8');
    assert.ok(text.includes('KEEP THIS USER RULE'));
    assert.ok(text.includes('The hook writes after `<!-- claude-evolve:managed-start -->` markers.'));
    assert.equal(count(text, '## Auto-learned Rules'), 1);
  });

  it('skips the write when bytes are unchanged (score changes included)', () => {
    const dir = project();
    const first = writer.writeRules(dir, [rule('r1', 'stable rule', { score: 5 })]);
    assert.equal(first.changed, true);
    const file = path.join(dir, TARGET);
    const before = fs.statSync(file).mtimeMs;
    const inode = fs.statSync(file).ino;
    const second = writer.writeRules(dir, [rule('r1', 'stable rule', { score: 7.3 })]);
    assert.equal(second.changed, false);
    assert.equal(fs.statSync(file).mtimeMs, before);
    assert.equal(fs.statSync(file).ino, inode, 'file not replaced');
  });

  it('writes through a symlinked rules file instead of replacing the link', () => {
    const dir = project();
    const shared = path.join(SANDBOX, `shared-${n}.md`);
    fs.writeFileSync(shared, '# Shared\n- keep me\n');
    fs.symlinkSync(shared, path.join(dir, TARGET));
    writer.writeRules(dir, [rule('r1', 'linked rule')]);
    assert.ok(fs.lstatSync(path.join(dir, TARGET)).isSymbolicLink());
    const text = fs.readFileSync(shared, 'utf8');
    assert.ok(text.includes('linked rule') && text.includes('- keep me'));
  });

  it('an empty rule set removes the block and a file that only held it', () => {
    const dir = project();
    writer.writeRules(dir, [rule('r1', 'temporary rule')]);
    writer.writeRules(dir, []);
    assert.ok(!fs.existsSync(path.join(dir, TARGET)), 'untracked file that only held the block is removed');
  });

  it('R3: a marker shown inside a code fence never pairs with the real block', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    fs.writeFileSync(file, [
      '# Notes', '', 'How the block looks:', '```md', writer.MANAGED_START, '```', '',
      '- HAND-WRITTEN TEXT BETWEEN', '',
      writer.MANAGED_START, '<!-- claude-evolve:rule id=r_old -->', '- old rule', '<!-- /claude-evolve:rule -->', writer.MANAGED_END, '',
    ].join('\n'));
    const res = writer.writeRules(dir, [rule('r1', 'fresh rule')]);
    assert.equal(res.error, undefined);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('- HAND-WRITTEN TEXT BETWEEN'), 'text between fence and block kept');
    assert.ok(text.includes('```md\n' + writer.MANAGED_START + '\n```'), 'fenced example kept');
    assert.ok(text.includes('fresh rule') && !text.includes('old rule'));
  });

  it('R3: two start markers outside fences → refuse to write, file untouched', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    const original = ['# Notes', writer.MANAGED_START, '- user text', writer.MANAGED_START, '- x', writer.MANAGED_END, ''].join('\n');
    fs.writeFileSync(file, original);
    const res = writer.writeRules(dir, [rule('r1', 'fresh rule')]);
    assert.match(res.error, /more than one claude-evolve start marker/);
    assert.equal(res.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  it('A: an inline ```code``` line above an existing block is not a fence (no growth across 3 runs)', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    fs.writeFileSync(file, ['# Notes', '```code``` spans are fine in prose', '',
      writer.MANAGED_START, '<!-- claude-evolve:rule id=r0 -->', '- old', '<!-- /claude-evolve:rule -->', writer.MANAGED_END, ''].join('\n'));
    for (let i = 0; i < 3; i++) assert.equal(writer.writeRules(dir, [rule('r1', 'fresh rule')]).error, undefined);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(count(text, writer.MANAGED_START), 1, 'one block after 3 runs');
    assert.ok(text.includes('fresh rule') && !text.includes('- old'));
  });

  it('A: an unclosed ``` line above an existing block → refuse, file untouched across 3 runs', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    const original = ['# Notes', '```bash', 'echo never closed', '',
      writer.MANAGED_START, '<!-- claude-evolve:rule id=r0 -->', '- old', '<!-- /claude-evolve:rule -->', writer.MANAGED_END, ''].join('\n');
    fs.writeFileSync(file, original);
    for (let i = 0; i < 3; i++) {
      const res = writer.writeRules(dir, [rule('r1', 'fresh rule')]);
      assert.match(res.error, /code fence is never closed/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    // The same file in CLAUDE.md (not the target): its old block is not silently kept and duplicated either
    if (TARGET !== 'CLAUDE.md') {
      const dir2 = project();
      fs.writeFileSync(path.join(dir2, 'CLAUDE.md'), original);
      assert.match(writer.writeRules(dir2, [rule('r1', 'fresh rule')]).error, /CLAUDE\.md: a code fence is never closed/);
      assert.equal(fs.readFileSync(path.join(dir2, 'CLAUDE.md'), 'utf8'), original);
      assert.ok(!fs.existsSync(path.join(dir2, TARGET)), 'no second copy of the rules next to the old block');
    }
  });

  it('B: a workflow rule with an unbalanced fence cannot freeze the file (2 writes)', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    const wf = { id: 'w1', complexity: 'workflow', content: '1. Dry run first\n```bash\nbq query --dry_run\n2. Then run it' };
    const first = writer.writeRules(dir, [wf, rule('r2', 'second rule')]);
    assert.equal(first.error, undefined);
    const text1 = fs.readFileSync(file, 'utf8');
    assert.ok(!/^ {0,3}```/m.test(text1), 'no rule line can open a fence');
    const second = writer.writeRules(dir, [wf, rule('r2', 'second rule changed')]);
    assert.equal(second.error, undefined, 'not frozen');
    assert.equal(second.changed, true);
    const text2 = fs.readFileSync(file, 'utf8');
    assert.ok(text2.includes('second rule changed'));
    assert.equal(count(text2, writer.MANAGED_START), 1);
  });

  it('B: fence lines already inside our block (older writer) do not hide the end marker', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    fs.writeFileSync(file, ['# Notes', '- mine', '',
      writer.MANAGED_START, '<!-- claude-evolve:rule id=w0 -->', '1. step', '```bash', 'ls', '<!-- /claude-evolve:rule -->', writer.MANAGED_END,
      '', '- after the block', ''].join('\n'));
    const res = writer.writeRules(dir, [rule('r1', 'fresh rule')]);
    assert.equal(res.error, undefined);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('- mine') && text.includes('- after the block') && text.includes('fresh rule'));
    assert.ok(!text.includes('```bash'));
  });

  it('R4: the first change to an existing CLAUDE.md is backed up once; a file we created is not', () => {
    const dir = project();
    const md = path.join(dir, 'CLAUDE.md');
    const original = `# Mine\n- keep\n\n## Auto-learned Rules\n\n${writer.MANAGED_START}\n<!-- claude-evolve:rule id=r0 -->\n- old\n<!-- /claude-evolve:rule -->\n${writer.MANAGED_END}\n`;
    fs.writeFileSync(md, original);
    writer.writeRules(dir, [rule('r1', 'first')]);
    writer.writeRules(dir, [rule('r1', 'second')]);  // changes our own file only
    const backupDir = path.join(process.env.CLAUDE_EVOLVE_DATA_DIR, 'backups', 'writer', path.dirname(md));
    const copies = fs.readdirSync(backupDir);
    const mdCopies = copies.filter(n => n.startsWith('CLAUDE.md.'));
    assert.equal(mdCopies.length, 1, 'one backup of CLAUDE.md');
    assert.equal(fs.readFileSync(path.join(backupDir, mdCopies[0]), 'utf8'), original);
    if (TARGET !== 'CLAUDE.md') assert.ok(!copies.some(n => n.startsWith(`${TARGET}.`)), 'our own created file is not backed up');
  });

  it('R5: the writer never creates a project root that does not exist', () => {
    const gone = path.join(SANDBOX, 'deleted-worktree');
    const res = writer.writeRules(gone, [rule('r1', 'x')]);
    assert.equal(res.error, 'project root does not exist');
    assert.ok(!fs.existsSync(gone));
    assert.equal(skillWriter.writeSkill(gone, { id: 'm', content: 'x', keywords: ['a'] }, [], 'x', [], []).written, false);
    assert.ok(!fs.existsSync(gone));
  });

  it('R7: a CRLF file keeps CRLF and loses its orphan heading', () => {
    const dir = project();
    const file = path.join(dir, TARGET);
    fs.writeFileSync(file, ['# Notes', '- mine', '', '## Auto-learned Rules', '', writer.MANAGED_START, '- old', writer.MANAGED_END, ''].join('\r\n'));
    writer.writeRules(dir, [rule('r1', 'crlf rule')]);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(count(text, '## Auto-learned Rules'), 1);
    assert.ok(text.includes('- mine') && text.includes('crlf rule'));
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF line endings');
    assert.equal(writer.writeRules(dir, [rule('r1', 'crlf rule')]).changed, false, 'stable on rewrite');
  });

  it('R12: a symlinked rules file holding only the block is written through, not deleted', () => {
    const dir = project();
    const shared = path.join(SANDBOX, `only-block-${n}.md`);
    fs.writeFileSync(shared, `${writer.MANAGED_START}\n<!-- claude-evolve:rule id=r1 -->\n- stale\n<!-- /claude-evolve:rule -->\n${writer.MANAGED_END}\n`);
    fs.symlinkSync(shared, path.join(dir, TARGET));
    writer.writeRules(dir, []);
    assert.ok(fs.lstatSync(path.join(dir, TARGET)).isSymbolicLink(), 'link kept');
    assert.ok(!fs.readFileSync(shared, 'utf8').includes('stale'), 'target no longer holds the stale block');
  });

  it('a new CLAUDE.local.md is added to .git/info/exclude', { skip: TARGET !== 'CLAUDE.local.md' }, () => {
    const dir = project({ git: true });
    writer.writeRules(dir, [rule('r1', 'local rule')]);
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes('/CLAUDE.local.md'));
    execFileSync('git', ['-C', dir, 'check-ignore', '-q', 'CLAUDE.local.md']);  // throws if not ignored
  });
});

describe('skillWriter directory format', () => {
  let origGenerate;
  let nextName = 'Data Flow!!';
  before(() => {
    origGenerate = llmBrain.generateSkillContent;
    llmBrain.generateSkillContent = () => ({
      content: `---\nname: auto-${nextName}\ndescription: How this user validates data flows\ntriggers:\n  - validate pipeline\n  - check data flow\n---\n\n## Thinking Model\nCheck sources first.\n`,
    });
  });
  after(() => { llmBrain.generateSkillContent = origGenerate; });

  const methodology = id => ({ id, content: `rule ${id}`, keywords: ['data', 'flow'], complexity: 'methodology', created: '2026-04-17' });

  it('writes .claude/skills/auto-<slug>/SKILL.md with frontmatter first and excludes it from git', () => {
    const dir = project({ git: true });
    const r = methodology('m1');
    const res = skillWriter.writeSkill(dir, r, [methodology('m2')], 'analysis', [], []);

    assert.ok(res.written);
    assert.equal(res.path, path.join(dir, '.claude', 'skills', 'auto-data-flow', 'SKILL.md'));
    assert.equal(r.skill_path, res.path, 'skill_path tracked on the rule');
    const content = fs.readFileSync(res.path, 'utf8');
    assert.ok(content.startsWith('---\nname: auto-data-flow\n'), 'frontmatter first, name = dir name');
    assert.match(content, /\ndescription: How this user validates data flows\n/);
    assert.equal(skillWriter.ownership(content), 'ours');

    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes(skillWriter.EXCLUDE_PATTERN));
    execFileSync('git', ['-C', dir, 'check-ignore', '-q', path.relative(dir, res.path)]);

    // Regenerating keeps the slug even when the LLM proposes another name (no rename churn)
    nextName = 'something-else';
    const again = skillWriter.writeSkill(dir, r, [], 'analysis', [], []);
    assert.equal(again.path, res.path);
    nextName = 'Data Flow!!';
  });

  it('migrates flat skills, reconciles stale ones and lists only existing skills as routes', () => {
    const dir = project({ git: true });
    const skills = path.join(dir, '.claude', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    const body = '---\nname: auto-legacy-flow\ndescription: Old flat skill\n---\n\n# Legacy\n';
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    fs.writeFileSync(path.join(skills, 'auto-legacy-flow.md'), `<!-- claude-evolve:auto-skill hash=${hash} project-type=x created=2026-04-01 -->\n${body}`);
    fs.writeFileSync(path.join(skills, 'auto-edited.md'), `<!-- claude-evolve:auto-skill hash=${hash} project-type=x created=2026-04-01 -->\n${body}\nuser notes\n`);

    const moved = skillWriter.migrateFlatSkills(dir);
    assert.equal(moved.length, 2);
    assert.ok(!fs.existsSync(path.join(skills, 'auto-legacy-flow.md')) && !fs.existsSync(path.join(skills, 'auto-edited.md')));
    const legacy = path.join(skills, 'auto-legacy-flow', 'SKILL.md');
    const edited = path.join(skills, 'auto-edited', 'SKILL.md');
    assert.equal(skillWriter.ownership(fs.readFileSync(legacy, 'utf8')), 'ours');
    assert.ok(fs.readFileSync(legacy, 'utf8').startsWith('---\nname: auto-legacy-flow\n'));
    assert.equal(skillWriter.ownership(fs.readFileSync(edited, 'utf8')), 'foreign', 'edited flat skill becomes user-owned');

    const current = skillWriter.writeSkill(dir, methodology('m3'), [], 'analysis', [], []).path;
    const removed = skillWriter.reconcileSkills(dir, [current]);
    assert.deepEqual(removed, [legacy], 'unedited stale skill removed, user-owned one kept');
    assert.ok(fs.existsSync(edited));

    const routes = skillWriter.listSkillRoutes(dir).map(r => r.name).sort();
    assert.deepEqual(routes, ['auto-data-flow', 'auto-edited']);
    const section = writer.buildManagedSection([], skillWriter.listSkillRoutes(dir));
    assert.ok(section.includes('(.claude/skills/auto-data-flow/SKILL.md)'));
  });

  it('deleteSkill keeps a skill the user edited', () => {
    const dir = project();
    const r = methodology('m4');
    const res = skillWriter.writeSkill(dir, r, [], 'analysis', [], []);
    fs.appendFileSync(res.path, '\nmy own note\n');
    assert.deepEqual(skillWriter.deleteSkill(dir, r), { deleted: false, path: res.path, reason: 'user-edited' });
    assert.ok(fs.existsSync(res.path));
  });
});
