'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Heuristically pick a project preset from filesystem signals.
 *
 * Evaluated top-to-bottom; first match wins. Returns one of:
 *   'mobile-app' | 'monorepo' | 'web-app' | 'api-only' | 'static-site'
 * along with a `reason` string for the preview UI.
 *
 * `monorepo` is recognized but flagged separately — onboardProject refuses to
 * scaffold for it in PRD-001 v1 (single-project model only).
 */
function detectPreset(projectRoot) {
  const has = (rel) => fs.existsSync(path.join(projectRoot, rel));
  const readPkg = () => {
    try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')); }
    catch { return null; }
  };

  // 1. Mobile — iOS/Android signals are unambiguous.
  if (has('Podfile') || has('ios/Podfile') || globExists(projectRoot, '*.xcodeproj') || globExists(projectRoot, '*.xcworkspace')) {
    return { preset: 'mobile-app', reason: 'iOS Podfile or Xcode project detected' };
  }
  if (has('android') && (has('android/build.gradle') || has('android/build.gradle.kts'))) {
    return { preset: 'mobile-app', reason: 'Android Gradle project detected' };
  }
  // iOS signal anywhere under apps/<name>/ (with or without a sibling package.json) —
  // sufficient on its own to classify as mobile-app, since example-studio-style
  // monorepos may not have a package.json at the per-app root.
  if (anyAppHasIosSignal(projectRoot)) {
    return { preset: 'mobile-app', reason: 'iOS project nested under apps/<name>/ios/' };
  }

  // 2. Monorepo — workspace-style repo. Flagged separately so the caller can
  //    refuse to scaffold (PRD-001 v1 doesn't support monorepo onboarding).
  const pkg = readPkg();
  if (pkg && (Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages)))) {
    return { preset: 'monorepo', reason: 'package.json declares workspaces' };
  }
  if (hasMonorepoApps(projectRoot)) {
    return { preset: 'monorepo', reason: 'apps/ directory with multiple sub-projects' };
  }
  if (has('packages') && fs.statSync(path.join(projectRoot, 'packages')).isDirectory()) {
    const subdirs = fs.readdirSync(path.join(projectRoot, 'packages'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => fs.existsSync(path.join(projectRoot, 'packages', d.name, 'package.json')));
    if (subdirs.length > 1) {
      return { preset: 'monorepo', reason: `packages/ contains ${subdirs.length} sub-packages` };
    }
  }

  // 3. Web frameworks. Look at deps + config files.
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const dep = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  const hasWranglerConfig = has('wrangler.jsonc') || has('wrangler.toml');
  const hasNext = dep('next') || has('next.config.js') || has('next.config.mjs') || has('next.config.ts');
  const hasVite = dep('vite') || has('vite.config.js') || has('vite.config.ts') || has('vite.config.mjs');
  const hasAstro = dep('astro') || has('astro.config.mjs') || has('astro.config.ts');
  const hasSvelteKit = dep('@sveltejs/kit') || has('svelte.config.js');
  const hasExpress = dep('express');
  const hasFastify = dep('fastify');
  const hasHono = dep('hono');
  const hasPublic = has('public') || has('static');
  const hasServerCode = has('server.js') || has('server.mjs') || has('server.ts') || has('src/server.ts') || has('app.js');

  if (hasNext && hasWranglerConfig) {
    return { preset: 'web-app', reason: 'Next.js + Cloudflare Workers/Pages config' };
  }
  if (hasNext) {
    return { preset: 'web-app', reason: 'Next.js project detected' };
  }
  if (hasSvelteKit) {
    return { preset: 'web-app', reason: 'SvelteKit project detected' };
  }

  // API-only: server framework in deps, no public/static dir, no vite/astro/etc.
  if ((hasExpress || hasFastify || hasHono) && !hasPublic && !hasVite && !hasAstro) {
    return { preset: 'api-only', reason: 'Server framework in deps with no public/ directory' };
  }

  // Static site: Vite/Astro without a server-side framework or server entrypoint.
  if ((hasVite || hasAstro) && !hasExpress && !hasFastify && !hasHono && !hasServerCode) {
    return { preset: 'static-site', reason: hasVite ? 'Vite project, no server-side code' : 'Astro project, no server-side code' };
  }

  // Default: web-app catches the long tail of mixed projects.
  return { preset: 'web-app', reason: 'Default — no specific framework signal matched' };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function hasMonorepoApps(projectRoot) {
  const apps = path.join(projectRoot, 'apps');
  if (!fs.existsSync(apps)) return false;
  let stat;
  try { stat = fs.statSync(apps); } catch { return false; }
  if (!stat.isDirectory()) return false;
  const entries = fs.readdirSync(apps, { withFileTypes: true }).filter((d) => d.isDirectory());
  // Two or more sub-projects (each with its own package.json or Podfile) → monorepo.
  let appCount = 0;
  for (const e of entries) {
    const sub = path.join(apps, e.name);
    if (fs.existsSync(path.join(sub, 'package.json')) || fs.existsSync(path.join(sub, 'Podfile'))) {
      appCount++;
    }
  }
  return appCount >= 2;
}

function anyAppHas(projectRoot, file) {
  const apps = path.join(projectRoot, 'apps');
  if (!fs.existsSync(apps)) return false;
  for (const e of fs.readdirSync(apps, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(apps, e.name, file))) return true;
  }
  return false;
}

function anyAppHasIosSignal(projectRoot) {
  const apps = path.join(projectRoot, 'apps');
  if (!fs.existsSync(apps)) return false;
  for (const e of fs.readdirSync(apps, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const appDir = path.join(apps, e.name);
    if (fs.existsSync(path.join(appDir, 'Podfile'))) return true;
    const iosDir = path.join(appDir, 'ios');
    if (!fs.existsSync(iosDir)) continue;
    if (fs.existsSync(path.join(iosDir, 'Podfile'))) return true;
    try {
      if (fs.readdirSync(iosDir).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) return true;
    } catch {}
  }
  return false;
}

function globExists(projectRoot, pattern) {
  if (!pattern.includes('*')) return fs.existsSync(path.join(projectRoot, pattern));
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  try {
    return fs.readdirSync(projectRoot).some((f) => re.test(f));
  } catch { return false; }
}

module.exports = { detectPreset };
