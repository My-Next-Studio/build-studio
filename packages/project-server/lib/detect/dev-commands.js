'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Inspect package.json scripts (and a few config files) to pre-fill the
 * `dev_commands:` block in .build-studio/config.yaml.
 *
 * Strategy:
 *   - For a single-package project, look at the root package.json. If it has a
 *     `dev` or `start` script, emit one entry. Port + type inferred from the
 *     script body and from framework config files (vite.config, next.config…).
 *   - For sibling-package projects (example-web shape — `frontend/`, `backend/`,
 *     `admin/` each with their own package.json at the root), walk those
 *     immediate subdirectories and emit one entry per package with a `dev`/`start`
 *     script. Only direct children at depth=1 are inspected.
 *
 * Returns { devCommands: [{ name, cmd, cwd?, port?, type? }, …], reasons: [] }.
 * Empty array when nothing meaningful was found — owner can populate by hand.
 */
function detectDevCommands(projectRoot) {
  const out = { devCommands: [], reasons: [] };

  const rootPkg = readPkg(path.join(projectRoot, 'package.json'));
  const rootDevScript = pickDevScript(rootPkg);
  if (rootDevScript) {
    out.devCommands.push(buildEntry({
      name: 'app',
      cmd: `npm run ${rootDevScript.scriptName}`,
      cwd: null,
      script: rootDevScript.body,
      pkgDeps: rootDevScript.deps,
      configRoot: projectRoot,
    }));
    out.reasons.push(`root package.json has "${rootDevScript.scriptName}" script`);
  }

  // Sibling-package layout (example-web shape).
  for (const sibling of immediateSiblingPackages(projectRoot)) {
    const sibPkg = readPkg(path.join(projectRoot, sibling, 'package.json'));
    const dev = pickDevScript(sibPkg);
    if (!dev) continue;
    const entry = buildEntry({
      name: sibling,
      cmd: `npm run ${dev.scriptName}`,
      cwd: sibling,
      script: dev.body,
      pkgDeps: dev.deps,
      configRoot: path.join(projectRoot, sibling),
    });
    out.devCommands.push(entry);
    out.reasons.push(`${sibling}/package.json has "${dev.scriptName}" script`);
  }

  return out;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function readPkg(absPath) {
  try { return JSON.parse(fs.readFileSync(absPath, 'utf8')); }
  catch { return null; }
}

/**
 * Prefer "dev" over "start" — convention for hot-reload servers. Returns the
 * script entry { scriptName, body, deps } or null.
 */
function pickDevScript(pkg) {
  if (!pkg || !pkg.scripts || typeof pkg.scripts !== 'object') return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const name of ['dev', 'start']) {
    if (pkg.scripts[name]) return { scriptName: name, body: String(pkg.scripts[name]), deps };
  }
  return null;
}

const FRAMEWORK_RULES = [
  { framework: 'next',   defaultPort: 3000, scriptCue: /\bnext(\s|$)/, depCue: 'next' },
  { framework: 'vite',   defaultPort: 5173, scriptCue: /\bvite(\s|$)/, depCue: 'vite' },
  { framework: 'astro',  defaultPort: 4321, scriptCue: /\bastro(\s|$)/, depCue: 'astro' },
  { framework: 'sveltekit', defaultPort: 5173, scriptCue: /\bvite(\s|$)/, depCue: '@sveltejs/kit' },
  { framework: 'fastify',defaultPort: 4000, scriptCue: /\bfastify-cli(\s|$)|node\s+server/, depCue: 'fastify' },
  { framework: 'express',defaultPort: 3000, scriptCue: /\bnode\s+server/, depCue: 'express' },
];

function buildEntry({ name, cmd, cwd, script, pkgDeps, configRoot }) {
  const entry = { name, cmd };
  if (cwd) entry.cwd = cwd;

  // 1. Honor explicit `--port N` or `PORT=N` on the script itself.
  const explicit = parseExplicitPort(script);
  if (explicit) entry.port = explicit;

  // 2. Match a framework rule via the script body or deps.
  const rule = FRAMEWORK_RULES.find((r) => r.scriptCue.test(script) || (pkgDeps && pkgDeps[r.depCue]));
  if (rule) {
    if (!entry.port) entry.port = configFilePortOverride(configRoot, rule.framework) || rule.defaultPort;
    entry.type = simpleType(rule.framework);
  }

  return entry;
}

function parseExplicitPort(script) {
  const dashPort = script.match(/--port[\s=](\d{2,5})/);
  if (dashPort) return Number(dashPort[1]);
  const envPort = script.match(/\bPORT=(\d{2,5})\b/);
  if (envPort) return Number(envPort[1]);
  return null;
}

function configFilePortOverride(dir, framework) {
  // Vite supports `server.port` in vite.config.ts/js. Quick best-effort regex.
  if (framework === 'vite' || framework === 'sveltekit') {
    for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      const abs = path.join(dir, f);
      if (!fs.existsSync(abs)) continue;
      try {
        const m = fs.readFileSync(abs, 'utf8').match(/port\s*:\s*(\d+)/);
        if (m) return Number(m[1]);
      } catch {}
    }
  }
  return null;
}

function simpleType(framework) {
  if (framework === 'vite' || framework === 'sveltekit' || framework === 'astro') return 'vite';
  return 'node';
}

/**
 * Direct subdirectories that look like sibling packages — each has its own
 * package.json. Skips conventional dirs that aren't packages (node_modules,
 * .git, dist, build, docs, tmp, public, static, etc.).
 */
function immediateSiblingPackages(projectRoot) {
  const SKIP = new Set([
    'node_modules', '.git', '.github', '.next', '.turbo', '.vscode', '.idea',
    'dist', 'build', 'out', 'coverage', 'tmp', 'public', 'static', 'docs',
    '.build-studio', '.claude', '.worktrees',
  ]);
  let entries;
  try { entries = fs.readdirSync(projectRoot, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(projectRoot, name, 'package.json')))
    .sort();
}

module.exports = { detectDevCommands };
