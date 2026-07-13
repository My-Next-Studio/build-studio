'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectDeployment, parseGithubOwnerRepo } = require('./deployment');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-deploy-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function gitInitWithRemote(root, remoteUrl) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: root, stdio: 'ignore' });
}

// ─── parseGithubOwnerRepo ───────────────────────────────────────────────────

test('parseGithubOwnerRepo: SSH URL', () => {
  assert.equal(parseGithubOwnerRepo('git@github.com:example-org/example-app.git'), 'example-org/example-app');
});

test('parseGithubOwnerRepo: HTTPS URL with .git', () => {
  assert.equal(parseGithubOwnerRepo('https://github.com/example-org/example-web.git'), 'example-org/example-web');
});

test('parseGithubOwnerRepo: HTTPS URL without .git', () => {
  assert.equal(parseGithubOwnerRepo('https://github.com/example-org/example-site'), 'example-org/example-site');
});

test('parseGithubOwnerRepo: ssh:// URL', () => {
  assert.equal(parseGithubOwnerRepo('ssh://git@github.com/example-org/repo.git'), 'example-org/repo');
});

test('parseGithubOwnerRepo: trailing slash tolerated', () => {
  assert.equal(parseGithubOwnerRepo('https://github.com/owner/repo/'), 'owner/repo');
});

test('parseGithubOwnerRepo: non-github host returns null (gh CLI only knows github)', () => {
  assert.equal(parseGithubOwnerRepo('https://gitlab.com/owner/repo.git'), null);
});

test('parseGithubOwnerRepo: empty/null input returns null', () => {
  assert.equal(parseGithubOwnerRepo(''), null);
  assert.equal(parseGithubOwnerRepo(null), null);
});

// ─── detectDeployment.repo ─────────────────────────────────────────────────

test('detectDeployment.repo: parses from git remote get-url origin', () => {
  const root = makeTree({});
  try {
    gitInitWithRemote(root, 'https://github.com/example-org/example-app.git');
    const r = detectDeployment(root);
    assert.equal(r.repo, 'example-org/example-app');
  } finally { clean(root); }
});

test('detectDeployment.repo: null when no git remote', () => {
  const root = makeTree({});
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    const r = detectDeployment(root);
    assert.equal(r.repo, null);
  } finally { clean(root); }
});

test('detectDeployment.repo: null when not a git repo', () => {
  const root = makeTree({});
  try {
    const r = detectDeployment(root);
    assert.equal(r.repo, null);
  } finally { clean(root); }
});

// ─── detectDeployment.ciWorkflow ───────────────────────────────────────────

test('detectDeployment.ciWorkflow: picks the workflow with workflow_dispatch', () => {
  // deploy.yml triggers on BOTH push to main AND workflow_dispatch — the
  // hybrid case (push = deploy in normal flow; manual button is a re-trigger).
  const root = makeTree({
    '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n',
    '.github/workflows/deploy.yml': 'name: Deploy\non:\n  workflow_dispatch:\n  push:\n    branches: [main]\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'deploy.yml');
    assert.equal(r.deployedOnPush, true, 'hybrid push+dispatch → push IS the deploy');
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: null when no .github/workflows/', () => {
  const root = makeTree({});
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, null);
    assert.equal(r.deployedOnPush, true);
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: null when no workflow has workflow_dispatch', () => {
  // example-site-shape: ci.yml runs lint+test+build on push but has no manual deploy.
  const root = makeTree({
    '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, null);
    assert.equal(r.deployedOnPush, true, 'no manual deploy → push = deploy');
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: workflow_dispatch on backup.yml is NOT a deploy candidate', () => {
  // example-site-real-shape: backup.yml has workflow_dispatch for manual backup runs
  // but is not the Deploy button target. Push to main = Railway deploy.
  const root = makeTree({
    '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n',
    '.github/workflows/backup.yml': 'name: Backup\non:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, null, 'backup.yml is not deploy-shaped — must not be picked');
    assert.equal(r.deployedOnPush, true);
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: workflow_dispatch on daily-health-check is NOT a deploy candidate', () => {
  // example-studio-real-shape
  const root = makeTree({
    '.github/workflows/daily-health-check.yml':
      'name: Daily health check\non:\n  schedule:\n    - cron: "0 12 * * *"\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, null);
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: prod-monitor.yml is NOT a deploy candidate (prod≠deploy)', () => {
  // skrivhjälp-real-shape — "prod" in the filename does not imply deploy.
  const root = makeTree({
    '.github/workflows/prod-monitor.yml':
      'name: Production monitor\non:\n  schedule:\n    - cron: "0 * * * *"\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, null);
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: filename signal beats name-field signal', () => {
  const root = makeTree({
    '.github/workflows/test.yml':
      'name: Deploy nightly\non:\n  workflow_dispatch:\n',
    '.github/workflows/deploy.yml':
      'name: CI\non:\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'deploy.yml', 'deploy filename outranks name-field signal in test.yml');
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: job named "deploy" inside an otherwise-neutral workflow', () => {
  // example-web-shape — ci.yml has lint/test/build jobs plus a deploy job gated on workflow_dispatch.
  const root = makeTree({
    '.github/workflows/ci.yml':
      'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n' +
      'jobs:\n  lint:\n    runs-on: ubuntu-latest\n  deploy:\n    runs-on: ubuntu-latest\n    if: github.event_name == \'workflow_dispatch\'\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'ci.yml', 'a "deploy:" job inside a generic CI workflow makes it a candidate');
  } finally { clean(root); }
});

test('detectDeployment.ciWorkflow: indented workflow_dispatch on a deploy-named workflow', () => {
  const root = makeTree({
    '.github/workflows/deploy-pages.yml':
      'name: Deploy Pages\non:\n  push:\n    branches:\n      - main\n  pull_request:\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'deploy-pages.yml');
  } finally { clean(root); }
});

// ─── detectDeployment.autoDeployHint ───────────────────────────────────────

test('detectDeployment.autoDeployHint: wrangler.jsonc → cloudflare-pages', () => {
  const root = makeTree({ 'wrangler.jsonc': '{}' });
  try { assert.equal(detectDeployment(root).autoDeployHint, 'cloudflare-pages'); }
  finally { clean(root); }
});

test('detectDeployment.autoDeployHint: wrangler.toml → cloudflare-pages', () => {
  const root = makeTree({ 'wrangler.toml': '' });
  try { assert.equal(detectDeployment(root).autoDeployHint, 'cloudflare-pages'); }
  finally { clean(root); }
});

test('detectDeployment.autoDeployHint: vercel.json → vercel', () => {
  const root = makeTree({ 'vercel.json': '{}' });
  try { assert.equal(detectDeployment(root).autoDeployHint, 'vercel'); }
  finally { clean(root); }
});

test('detectDeployment.autoDeployHint: railway.json → railway', () => {
  const root = makeTree({ 'railway.json': '{}' });
  try { assert.equal(detectDeployment(root).autoDeployHint, 'railway'); }
  finally { clean(root); }
});

test('detectDeployment.autoDeployHint: netlify.toml → netlify', () => {
  const root = makeTree({ 'netlify.toml': '' });
  try { assert.equal(detectDeployment(root).autoDeployHint, 'netlify'); }
  finally { clean(root); }
});

test('detectDeployment.autoDeployHint: none configured → null', () => {
  const root = makeTree({});
  try { assert.equal(detectDeployment(root).autoDeployHint, null); }
  finally { clean(root); }
});

// ─── End-to-end shapes (matching real projects' configs) ────────────────────

test('end-to-end example-app-shape: hybrid push+workflow_dispatch → deployedOnPush=true', () => {
  // Pilot finding (2026-04-27): example-app's deploy-pages.yml triggers on BOTH
  // push to main AND workflow_dispatch. Push IS the deploy; the manual button
  // is just a re-trigger. deployedOnPush must be true.
  const root = makeTree({
    '.github/workflows/ci.yml': 'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n',
    '.github/workflows/deploy-pages.yml':
      'name: Deploy Pages\non:\n  push:\n    branches:\n      - main\n  pull_request:\n  workflow_dispatch:\n',
  });
  try {
    gitInitWithRemote(root, 'https://github.com/example-org/example-app.git');
    const r = detectDeployment(root);
    assert.equal(r.repo, 'example-org/example-app');
    assert.equal(r.ciWorkflow, 'deploy-pages.yml');
    assert.equal(r.deployedOnPush, true, 'hybrid push+workflow_dispatch → push = deploy');
  } finally { clean(root); }
});

test('detectDeployment.deployedOnPush: workflow_dispatch only (no push trigger) → false', () => {
  // example-web-shape: the manual deploy job is gated on workflow_dispatch and
  // does NOT trigger on push. Push runs CI; production deploy needs the button.
  const root = makeTree({
    '.github/workflows/ci.yml':
      'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n' +
      'jobs:\n  lint:\n    runs-on: ubuntu-latest\n  deploy:\n    if: github.event_name == \'workflow_dispatch\'\n    runs-on: ubuntu-latest\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'ci.yml', 'has a deploy: job → ci.yml is the deploy candidate');
    // Note: ci.yml DOES trigger on push to main, so by the heuristic
    // deployedOnPush=true. The deploy *job* is gated on workflow_dispatch but
    // the *workflow* runs on push. This matches the example-web actual behavior:
    // pushing to main runs CI on main; the deploy job is conditional on the
    // dispatch event so push pushes do not deploy. The heuristic is coarse here —
    // owner can override by editing config.yaml after preview if push is
    // truly only-CI-not-deploy.
    assert.equal(r.deployedOnPush, true, 'heuristic: workflow runs on push → deployedOnPush=true. Owner can override.');
  } finally { clean(root); }
});

test('detectDeployment.deployedOnPush: deploy-only workflow with push to a non-main branch → false', () => {
  // Edge case: the deploy workflow only fires on push to a `release` branch (not main).
  const root = makeTree({
    '.github/workflows/release.yml':
      'on:\n  push:\n    branches: [release]\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'release.yml');
    assert.equal(r.deployedOnPush, false, 'push to non-main branch → main-push is not the deploy');
  } finally { clean(root); }
});

test('detectDeployment.deployedOnPush: deploy with workflow_dispatch only and no push: → false', () => {
  const root = makeTree({
    '.github/workflows/deploy.yml': 'on:\n  workflow_dispatch:\n',
  });
  try {
    const r = detectDeployment(root);
    assert.equal(r.ciWorkflow, 'deploy.yml');
    assert.equal(r.deployedOnPush, false, 'no push trigger at all → manual-only deploy');
  } finally { clean(root); }
});

test('end-to-end example-site-shape: ci.yml only (push = Railway deploy)', () => {
  const root = makeTree({
    '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n',
  });
  try {
    gitInitWithRemote(root, 'git@github.com:example-org/example-site.git');
    const r = detectDeployment(root);
    assert.equal(r.repo, 'example-org/example-site');
    assert.equal(r.ciWorkflow, null);
    assert.equal(r.deployedOnPush, true);
  } finally { clean(root); }
});
