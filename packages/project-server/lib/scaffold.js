const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { planAgentsMdMigration, applyAgentsMdMigration } = require('./agents-md');

/**
 * New-project init: write Build Studio's files into a folder and commit them.
 *
 * The folder is often not empty. A project is commonly set up by first putting
 * its brief in docs/inputs/ and committing it, then running init on that repo.
 * Init used to copy every template over whatever was there and commit with
 * `git add -A`, so it could replace a project's own .gitignore, AGENTS.md,
 * CLAUDE.md and docs, commit files the old .gitignore kept out (an .env), and
 * rename the checked-out branch. Now:
 *
 *   - files Build Studio owns (role commands, skills, the PRD template, the
 *     docs-budget script) are written, and replacing an existing one is
 *     reported;
 *   - the project's own documents (vision, project state, decisions, backlog
 *     index, asset register, ARCHITECTURE.md, settings.json) are written only
 *     when absent;
 *   - .gitignore gains the template's missing lines instead of being replaced;
 *   - AGENTS.md and CLAUDE.md follow agents-md.js: never overwritten; a
 *     populated CLAUDE.md is moved into AGENTS.md verbatim behind a stub;
 *   - in an existing repository: no `git init` and no branch rename, a dirty
 *     working tree is refused, and only the paths init wrote are committed.
 *
 * planScaffold() reports what init would replace, merge or move, without
 * writing, so the caller can ask before anything changes.
 */

/** Project documents written only when absent. */
const DOC_TEMPLATES = ['project-state.md', 'decisions.md', 'backlog-index.md', 'vision.md', 'asset-register.md'];
const KEPT_DIRS = ['docs/inputs', 'docs/prds', 'docs/adrs', 'docs/backlog'];
const LEARNING_CATEGORIES = ['architecture', 'backend', 'frontend', 'devops', 'qa', 'security', 'workflow'];

function resolveTemplateDir() {
  // Multi-candidate template resolution — works in both the source tree and
  // the Electron bundle (project-server may be loaded from
  // standalone/node_modules/@build-studio/project-server/ OR from the
  // extraResources copy at Resources/project-server/).
  const templateSuffix = path.join('templates', 'default');
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', templateSuffix),
    path.resolve(__dirname, '..', '..', '..', '..', '..', templateSuffix),
    path.resolve(__dirname, '..', '..', templateSuffix),
  ];
  const templateDir = candidates.find((c) => fs.existsSync(c));
  if (!templateDir) {
    throw new Error(`Template directory not found. Tried:\n  ${candidates.join('\n  ')}`);
  }
  return templateDir;
}

function listTree(dir, rel = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...listTree(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** [templateRelPath, targetRelPath] for every file Build Studio owns and overwrites. */
function ownedFiles(templateDir) {
  const pairs = [];
  for (const f of listTree(path.join(templateDir, '.claude', 'commands'))) {
    pairs.push([path.join('.claude', 'commands', f), path.join('.claude', 'commands', f)]);
  }
  const skillsDir = path.join(templateDir, '.claude', 'skills');
  let skillDirs = [];
  try { skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { /* none */ }
  for (const d of skillDirs) {
    for (const f of listTree(path.join(skillsDir, d.name))) {
      const rel = path.join('.claude', 'skills', d.name, f);
      pairs.push([rel, rel]);
    }
  }
  for (const rel of [path.join('docs', 'prds', 'TEMPLATE.md'), path.join('scripts', 'check-docs-budget.mjs')]) {
    if (fs.existsSync(path.join(templateDir, rel))) pairs.push([rel, rel]);
  }
  return pairs;
}

function sameContent(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (_) { return false; }
}

function gitignoreLines(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Template .gitignore lines the existing file lacks. */
function missingIgnoreLines(templateDir, targetPath) {
  const tpl = path.join(templateDir, '.gitignore');
  const cur = path.join(targetPath, '.gitignore');
  if (!fs.existsSync(tpl) || !fs.existsSync(cur)) return null;
  const have = new Set(gitignoreLines(fs.readFileSync(cur, 'utf8')));
  return gitignoreLines(fs.readFileSync(tpl, 'utf8')).filter((l) => !have.has(l));
}

function git(targetPath, args, opts = {}) {
  return execFileSync('git', args, { cwd: targetPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * What init would do to a folder that already has files. Writes nothing.
 * @returns {{ existingRepo: boolean, branch: string|null, dirty: string[],
 *             changes: { path: string, action: 'overwrite'|'merge'|'migrate', note: string }[] }}
 *   `changes` lists only existing files init would alter; new files are not listed.
 */
function planScaffold(targetPath, templateDir = resolveTemplateDir()) {
  const existingRepo = fs.existsSync(path.join(targetPath, '.git'));
  let branch = null;
  let dirty = [];
  if (existingRepo) {
    try { branch = git(targetPath, ['branch', '--show-current']) || null; } catch (_) { /* detached or unborn */ }
    // Not via git(): its trim() would eat the first line's leading status column.
    try {
      dirty = execFileSync('git', ['status', '--porcelain'], { cwd: targetPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        .split('\n').filter(Boolean);
    } catch (_) { dirty = []; }
  }
  const changes = [];
  for (const [src, dst] of ownedFiles(templateDir)) {
    const target = path.join(targetPath, dst);
    if (fs.existsSync(target) && !sameContent(path.join(templateDir, src), target)) {
      changes.push({ path: dst, action: 'overwrite', note: 'Build Studio file, replaced with the current template' });
    }
  }
  const missing = missingIgnoreLines(templateDir, targetPath);
  if (missing && missing.length) {
    changes.push({ path: '.gitignore', action: 'merge', note: `${missing.length} line(s) appended; existing lines kept` });
  }
  if (fs.existsSync(targetPath)) {
    const agents = planAgentsMdMigration(targetPath);
    if (agents.action === 'migrate') {
      changes.push({ path: 'CLAUDE.md', action: 'migrate', note: 'content moved verbatim to AGENTS.md; CLAUDE.md becomes a stub that imports it' });
    }
  }
  return { existingRepo, branch, dirty, changes };
}

function scaffoldProject(targetPath, options = {}) {
  const projectName = options.name || path.basename(targetPath);
  const port = options.port || 3000;
  const templateDir = resolveTemplateDir();

  fs.mkdirSync(targetPath, { recursive: true });
  const log = (msg) => console.log(`  ✓ ${msg}`);

  const existingRepo = fs.existsSync(path.join(targetPath, '.git'));
  if (existingRepo) {
    let dirty = '';
    try { dirty = git(targetPath, ['status', '--porcelain']); } catch (_) { /* not a usable repo: let git fail later */ }
    if (dirty) {
      const err = new Error('The folder is a git repository with uncommitted changes. Commit or stash them first, so init commits only its own files.');
      err.code = 'DIRTY_TREE';
      throw err;
    }
  }

  const written = [];
  const kept = [];
  const warnings = [];
  const writeFile = (rel, content) => {
    const abs = path.join(targetPath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  };
  const copyFile = (srcRel, dstRel) => {
    const abs = path.join(targetPath, dstRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(templateDir, srcRel), abs);
    written.push(dstRel);
  };
  const writeIfAbsent = (rel, content) => {
    if (fs.existsSync(path.join(targetPath, rel))) { kept.push(rel); return false; }
    writeFile(rel, content);
    return true;
  };

  // .build-studio/config.yaml — the caller refuses a folder that already has one.
  let configContent = fs.readFileSync(path.join(templateDir, 'config.yaml'), 'utf8');
  configContent = configContent.replace(/^name: .*/m, `name: ${projectName}`);
  configContent = configContent.replace(/^port: .*/m, `port: ${port}`);
  writeFile(path.join('.build-studio', 'config.yaml'), configContent);
  log('.build-studio/config.yaml');

  // Build Studio's own files: role commands, skills, PRD template, docs-budget script.
  const owned = ownedFiles(templateDir);
  for (const [src, dst] of owned) copyFile(src, dst);
  const cmdCount = owned.filter(([, d]) => d.startsWith(path.join('.claude', 'commands'))).length;
  log(`.claude/commands/ (${cmdCount} role files), .claude/skills/, docs/prds/TEMPLATE.md, scripts/check-docs-budget.mjs`);

  // .claude/settings.json — bypass permissions for all workflow agents. Kept if present.
  const settingsSrc = path.join(templateDir, '.claude', 'settings.json');
  if (fs.existsSync(settingsSrc) && writeIfAbsent(path.join('.claude', 'settings.json'), fs.readFileSync(settingsSrc))) {
    log('.claude/settings.json');
  }

  // Project documents, only when absent.
  const docsSrc = path.join(templateDir, 'docs');
  for (const file of DOC_TEMPLATES) {
    const src = path.join(docsSrc, file);
    if (!fs.existsSync(src)) continue;
    const content = fs.readFileSync(src, 'utf8').replace(/\[Project Name\]/g, projectName);
    if (writeIfAbsent(path.join('docs', file), content)) log(`docs/${file}`);
  }

  // Knowledge manifest — declares this repo's knowledge surface (file contract). Never overwrites.
  const { ensureManifest } = require('./knowledge-manifest');
  const manifestRel = path.join('docs', 'knowledge.yaml');
  const manifestExisted = fs.existsSync(path.join(targetPath, manifestRel));
  if (ensureManifest(targetPath, { name: projectName }) && !manifestExisted) { written.push(manifestRel); log('docs/knowledge.yaml'); }

  // Empty directories. docs/adrs and docs/backlog are kept so the stub
  // ARCHITECTURE.md's references to them resolve for check-docs-budget.mjs
  // on the very first CI run.
  for (const dir of KEPT_DIRS) {
    fs.mkdirSync(path.join(targetPath, dir), { recursive: true });
    const keep = path.join(dir, '.gitkeep');
    if (!fs.existsSync(path.join(targetPath, keep))) writeFile(keep, '');
  }
  fs.mkdirSync(path.join(targetPath, 'tmp'), { recursive: true });
  for (const cat of LEARNING_CATEGORIES) {
    const keep = path.join('docs', 'learnings', cat, '.gitkeep');
    fs.mkdirSync(path.join(targetPath, 'docs', 'learnings', cat), { recursive: true });
    if (!fs.existsSync(path.join(targetPath, keep))) writeFile(keep, '');
  }
  log(`docs/ directories, docs/learnings/ (${LEARNING_CATEGORIES.length} categories)`);

  // .gitignore: the template's, or the template's missing lines appended.
  const gitignoreSrc = path.join(templateDir, '.gitignore');
  if (fs.existsSync(gitignoreSrc)) {
    const missing = missingIgnoreLines(templateDir, targetPath);
    if (missing === null) {
      copyFile('.gitignore', '.gitignore');
      log('.gitignore');
    } else if (missing.length) {
      const cur = fs.readFileSync(path.join(targetPath, '.gitignore'), 'utf8');
      writeFile('.gitignore', `${cur.replace(/\n*$/, '\n')}\n# Added by Build Studio init\n${missing.join('\n')}\n`);
      log(`.gitignore (${missing.length} line(s) appended)`);
    }
  }

  // AGENTS.md (canonical agent instructions — read natively by OpenCode and
  // Codex) + CLAUDE.md stub (@-imports AGENTS.md for Claude Code). Never
  // overwrites; see agents-md.js for the existing-repo matrix.
  const agentsResult = applyAgentsMdMigration(targetPath, planAgentsMdMigration(targetPath));
  for (const w of agentsResult.written) {
    const rel = w.split(' ')[0];
    written.push(rel);
    if (w.includes('moved from CLAUDE.md')) written.push('CLAUDE.md');
    log(w);
  }
  if (agentsResult.skipped.some((s) => /reconcile|aborting/.test(s))) {
    warnings.push('AGENTS.md and a populated CLAUDE.md both exist; neither was changed. Merge them by hand.');
  }

  // ARCHITECTURE.md — the maintained repo map. Ships as a stub with the
  // maintenance rules; builders fill it in as components land.
  const archSrc = path.join(templateDir, 'ARCHITECTURE.md');
  if (fs.existsSync(archSrc) && writeIfAbsent('ARCHITECTURE.md', fs.readFileSync(archSrc))) {
    log('ARCHITECTURE.md (stub)');
  }

  if (!existingRepo) {
    // git init — force the default branch to `main`. Plain `git init` honors the
    // machine's init.defaultBranch (often `master` on older setups), and the
    // execution/review workflows refuse to start unless the working tree is on
    // `main` ("not main … abort that branch first"). Rename after the first commit
    // so the project always lands on `main`, independent of the local git default
    // or version (`branch -M` works on any git; `init -b` would need ≥2.28).
    // A new repository holds nothing but what init wrote, so `add -A` is safe here.
    execFileSync('git', ['init'], { cwd: targetPath, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: targetPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'chore: initial project scaffolding from build-studio'], {
      cwd: targetPath, stdio: 'ignore',
    });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: targetPath, stdio: 'ignore' });
    log('git init + initial commit (branch: main)');
  } else {
    // An existing repository: commit only what init wrote, never the project's
    // other files, and leave its branches alone. Paths the project's own
    // .gitignore excludes stay out (`git add` refuses them by name).
    const unique = [...new Set(written)].map((p) => p.split(path.sep).join('/'));
    let ignored = new Set();
    try {
      ignored = new Set(git(targetPath, ['check-ignore', '--stdin'], { input: unique.join('\n') }).split('\n').filter(Boolean));
    } catch (_) { /* exit 1: none ignored */ }
    const toAdd = unique.filter((p) => !ignored.has(p));
    for (let i = 0; i < toAdd.length; i += 100) git(targetPath, ['add', '--', ...toAdd.slice(i, i + 100)]);
    let staged = true;
    try { git(targetPath, ['diff', '--cached', '--quiet']); staged = false; } catch (_) { /* exit 1: something staged */ }
    if (staged) {
      git(targetPath, ['commit', '-m', 'chore: add Build Studio project scaffolding']);
      log(`committed ${toAdd.length} path(s) init wrote`);
    }
    let branch = '';
    try { branch = git(targetPath, ['branch', '--show-current']); } catch (_) { /* detached */ }
    if (branch !== 'main') {
      warnings.push(`The repository is on "${branch || '(detached HEAD)'}", not main. Build Studio runs start from the default branch (main unless origin/HEAD says otherwise); init did not rename it.`);
    }
  }

  // Claude Code folder trust — a never-before-seen folder triggers Claude's
  // interactive trust dialog, which headless tmux agents can't answer: every
  // agent of the first workflow stalls silently until the idle timeout.
  const { seedClaudeFolderTrust } = require('./claude-trust');
  if (seedClaudeFolderTrust(targetPath)) {
    log('Claude folder trust (~/.claude.json)');
  } else {
    console.warn('  ⚠ could not seed Claude folder trust — run `claude` in the project folder once and accept the dialog, or the first workflow will stall');
  }

  return { written: [...new Set(written)], kept, warnings };
}

module.exports = { scaffoldProject, planScaffold };
