const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function scaffoldProject(targetPath, options = {}) {
  const projectName = options.name || path.basename(targetPath);
  const port = options.port || 3000;
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

  fs.mkdirSync(targetPath, { recursive: true });
  const log = (msg) => console.log(`  ✓ ${msg}`);

  // .build-studio/config.yaml
  const configDir = path.join(targetPath, '.build-studio');
  fs.mkdirSync(configDir, { recursive: true });
  let configContent = fs.readFileSync(path.join(templateDir, 'config.yaml'), 'utf8');
  configContent = configContent.replace(/^name: .*/m, `name: ${projectName}`);
  configContent = configContent.replace(/^port: .*/m, `port: ${port}`);
  fs.writeFileSync(path.join(configDir, 'config.yaml'), configContent);
  log('.build-studio/config.yaml');

  // .claude/commands/
  const cmdSrc = path.join(templateDir, '.claude', 'commands');
  const cmdDst = path.join(targetPath, '.claude', 'commands');
  fs.mkdirSync(cmdDst, { recursive: true });
  let cmdCount = 0;
  if (fs.existsSync(cmdSrc)) {
    for (const file of fs.readdirSync(cmdSrc)) {
      fs.copyFileSync(path.join(cmdSrc, file), path.join(cmdDst, file));
      cmdCount++;
    }
  }
  log(`.claude/commands/ (${cmdCount} role files)`);

  // .claude/settings.json — bypass permissions for all workflow agents
  const settingsSrc = path.join(templateDir, '.claude', 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    const settingsDst = path.join(targetPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsDst)) {
      fs.copyFileSync(settingsSrc, settingsDst);
      log('.claude/settings.json');
    }
  }

  // .claude/skills/ — workflow skills (qa-browser-testing, code-review-checklist, etc.)
  const skillsSrc = path.join(templateDir, '.claude', 'skills');
  const skillsDst = path.join(targetPath, '.claude', 'skills');
  let skillCount = 0;
  if (fs.existsSync(skillsSrc)) {
    const copyDir = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, dstPath);
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    };
    for (const skillDir of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!skillDir.isDirectory()) continue;
      copyDir(path.join(skillsSrc, skillDir.name), path.join(skillsDst, skillDir.name));
      skillCount++;
    }
  }
  if (skillCount > 0) log(`.claude/skills/ (${skillCount} skills)`);

  // docs templates
  const docsDir = path.join(targetPath, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const docsSrc = path.join(templateDir, 'docs');
  for (const file of ['project-state.md', 'vision.md', 'asset-register.md']) {
    const src = path.join(docsSrc, file);
    if (fs.existsSync(src)) {
      let content = fs.readFileSync(src, 'utf8');
      content = content.replace(/\[Project Name\]/g, projectName);
      fs.writeFileSync(path.join(docsDir, file), content);
      log(`docs/${file}`);
    }
  }

  // PRD template — the PM starts every PRD from this instead of
  // reverse-engineering the format from an older PRD.
  const prdsDir = path.join(docsDir, 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  const prdTemplateSrc = path.join(docsSrc, 'prds', 'TEMPLATE.md');
  if (fs.existsSync(prdTemplateSrc)) {
    fs.copyFileSync(prdTemplateSrc, path.join(prdsDir, 'TEMPLATE.md'));
    log('docs/prds/TEMPLATE.md');
  }

  // Empty directories
  for (const dir of ['docs/inputs', 'docs/prds', 'tmp']) {
    fs.mkdirSync(path.join(targetPath, dir), { recursive: true });
    if (dir !== 'tmp') {
      fs.writeFileSync(path.join(targetPath, dir, '.gitkeep'), '');
    }
    log(`${dir}/`);
  }

  // Learnings directory structure (per-file format with category subdirs)
  const learningsCategories = ['architecture', 'backend', 'frontend', 'devops', 'qa', 'security', 'workflow'];
  for (const cat of learningsCategories) {
    fs.mkdirSync(path.join(targetPath, 'docs', 'learnings', cat), { recursive: true });
    fs.writeFileSync(path.join(targetPath, 'docs', 'learnings', cat, '.gitkeep'), '');
  }
  log(`docs/learnings/ (${learningsCategories.length} categories)`);

  // .gitignore
  const gitignoreSrc = path.join(templateDir, '.gitignore');
  if (fs.existsSync(gitignoreSrc)) {
    fs.copyFileSync(gitignoreSrc, path.join(targetPath, '.gitignore'));
  }
  log('.gitignore');

  // CLAUDE.md
  const claudeSrc = path.join(templateDir, 'CLAUDE.md');
  if (fs.existsSync(claudeSrc)) {
    fs.copyFileSync(claudeSrc, path.join(targetPath, 'CLAUDE.md'));
  }
  log('CLAUDE.md');

  // ARCHITECTURE.md — the maintained repo map. Ships as a stub with the
  // maintenance rules; builders fill it in as components land (their prompts
  // instruct reading it before exploring and updating it in the same commit).
  const archSrc = path.join(templateDir, 'ARCHITECTURE.md');
  if (fs.existsSync(archSrc) && !fs.existsSync(path.join(targetPath, 'ARCHITECTURE.md'))) {
    fs.copyFileSync(archSrc, path.join(targetPath, 'ARCHITECTURE.md'));
    log('ARCHITECTURE.md (stub)');
  }

  // git init — force the default branch to `main`. Plain `git init` honors the
  // machine's init.defaultBranch (often `master` on older setups), and the
  // execution/review workflows refuse to start unless the working tree is on
  // `main` ("not main … abort that branch first"). Rename after the first commit
  // so the project always lands on `main`, independent of the local git default
  // or version (`branch -M` works on any git; `init -b` would need ≥2.28).
  execFileSync('git', ['init'], { cwd: targetPath, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: targetPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'chore: initial project scaffolding from build-studio'], {
    cwd: targetPath, stdio: 'ignore',
  });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: targetPath, stdio: 'ignore' });
  log('git init + initial commit (branch: main)');
}

module.exports = { scaffoldProject };
