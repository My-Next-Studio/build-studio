'use strict';

/**
 * Which learnings are worth putting in front of THIS project's agents.
 *
 * The prompt budget is six entries. Measured across this installation, the
 * entries burning that budget hardest were framework trivia reaching projects
 * that do not use the framework: `Svelte bind:value…` at 831 injections and
 * zero applications, `@next/mdx auto-pipeline…` at 711/0,
 * `__NEXT_PRIVATE_STANDALONE_CONFIG…` at 665/0. Meanwhile 58 Swift-tagged
 * entries sat in the shared pool, eligible for an Electron/TypeScript project
 * where none of them could ever apply.
 *
 * The rule is deliberately one-directional. A learning with no stack tag is a
 * general engineering principle and is ALWAYS eligible — those are the entries
 * that actually get applied (the three best performers here are all general,
 * at 18-29% application rates). Only a learning that declares itself specific
 * to a stack the project does not have is dropped. When the project's stack
 * cannot be determined, nothing is dropped at all.
 *
 * That asymmetry is the point: withholding a relevant learning is a silent
 * regression that shows up as a repeated mistake weeks later, while showing an
 * irrelevant one costs a sixth of a prompt.
 */

/**
 * Tags that mark a learning as belonging to one stack.
 *
 * Only unambiguous markers belong here. `testing`, `ci`, `api` and friends
 * appear across every stack and would misclassify general lessons as specific
 * ones — which is the failure direction this module is built to avoid.
 */
const STACK_TAGS = {
  swift: ['swift', 'swiftui', 'xcode', 'xctest', 'spm', 'ios', 'uikit', 'swiftdata', 'combine'],
  next: ['next.js', 'nextjs', 'next', '@next/mdx', 'turbopack', 'app-router'],
  svelte: ['svelte', 'svelte5', 'sveltekit', '@sveltejs/kit'],
  react: ['react', 'jsx'],
  vue: ['vue', 'nuxt'],
  python: ['python', 'fastapi', 'django', 'pytest', 'uv'],
  android: ['android', 'kotlin', 'jetpack-compose'],
};

/** A project on one stack implicitly has the others it is built from. */
const STACK_IMPLIES = {
  next: ['react'],
};

function expand(stacks) {
  const out = new Set(stacks);
  for (const s of stacks) for (const also of STACK_IMPLIES[s] || []) out.add(also);
  return out;
}

/** The stacks a learning declares itself specific to. Empty = general. */
function learningStacks(tags) {
  const lower = new Set((Array.isArray(tags) ? tags : [])
    .map((t) => String(t || '').trim().toLowerCase()).filter(Boolean));
  const found = new Set();
  for (const [stack, markers] of Object.entries(STACK_TAGS)) {
    if (markers.some((m) => lower.has(m))) found.add(stack);
  }
  return found;
}

/**
 * What this project is built with, from evidence the caller has already read.
 * Kept free of file IO so the rules stay testable.
 *
 * @param {object} evidence
 * @param {string[]} [evidence.jsDeps]   dependency + devDependency names
 * @param {boolean}  [evidence.hasSwift] an .xcodeproj / Package.swift exists
 * @param {boolean}  [evidence.hasPython] a pyproject.toml exists
 */
function detectProjectStacks({ jsDeps = [], hasSwift = false, hasPython = false } = {}) {
  const deps = new Set(jsDeps.map((d) => String(d || '').toLowerCase()));
  const stacks = new Set();
  if (hasSwift) stacks.add('swift');
  if (hasPython) stacks.add('python');
  if (deps.has('next')) stacks.add('next');
  if (deps.has('react') || deps.has('react-dom')) stacks.add('react');
  if (deps.has('vue') || deps.has('nuxt')) stacks.add('vue');
  if (deps.has('svelte') || deps.has('@sveltejs/kit')) stacks.add('svelte');
  return expand(stacks);
}

/**
 * @param {string[]} tags  the learning's tags
 * @param {Set} projectStacks  from detectProjectStacks
 * @returns {boolean} true when this learning should be offered to the project
 */
function isLearningEligible(tags, projectStacks) {
  const ls = learningStacks(tags);
  if (ls.size === 0) return true;                       // general — always
  if (!projectStacks || projectStacks.size === 0) return true;  // unknown — never hide
  for (const s of ls) if (projectStacks.has(s)) return true;
  return false;
}

/**
 * Gather stack evidence from disk, scanning the root and two levels below it.
 *
 * The depth is not incidental. A repo is not necessarily one project: one
 * managed project here keeps its Python under `tools/remote-config/`, and an
 * earlier root-only version of this concluded "no Python" and filtered out that
 * project's OWN Python learnings — the precise false-negative this module is
 * built to avoid. Monorepos with a manifest per sub-package are the norm here.
 *
 * @param {string} rootDir
 * @param {object} fs  injected so the layout can be tested without one
 */
function collectStackEvidence(rootDir, fs) {
  const path = require('path');
  const evidence = { jsDeps: [], hasSwift: false, hasPython: false };
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'tmp', '.next', 'vendor', 'Pods']);

  const dirs = [rootDir];
  for (let depth = 0; depth < 2; depth++) {
    for (const dir of [...dirs]) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const child = path.join(dir, e.name);
        if (!dirs.includes(child)) dirs.push(child);
      }
    }
  }

  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      evidence.jsDeps.push(...Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }));
    } catch {}
    try { if (fs.existsSync(path.join(dir, 'pyproject.toml'))) evidence.hasPython = true; } catch {}
    try { if (fs.existsSync(path.join(dir, 'Package.swift'))) evidence.hasSwift = true; } catch {}
    // .xcodeproj is a DIRECTORY, so it appears as an entry rather than a file.
    try {
      if (fs.readdirSync(dir).some((f) => String(f).endsWith('.xcodeproj'))) evidence.hasSwift = true;
    } catch {}
  }
  return evidence;
}

module.exports = {
  collectStackEvidence,
  STACK_TAGS,
  learningStacks,
  detectProjectStacks,
  isLearningEligible,
};
