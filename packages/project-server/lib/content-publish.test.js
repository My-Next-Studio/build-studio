'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cp = require('./content-publish');
const { createPublisher } = require('./api/publishing');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

const POST = (extra = '') => `---
title: "A post — with a dash"
description: "Body copy…"
date: "2026-08-06"
customKey:
  - kept
  - exactly
status: "draft"
${extra}---

Body.
`;

/** A project with a bare `origin`, a staged EN+SV post, and a publish script. */
function makeProject({ script, publishDate = '2026-09-01' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-test-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'work');
  fs.mkdirSync(remote); git(remote, 'init', '--bare', '-b', 'main');
  fs.mkdirSync(root); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.local'); git(root, 'config', 'user.name', 'T');
  git(root, 'remote', 'add', 'origin', remote);
  const staged = path.join(root, 'docs/marketing/content/staged');
  fs.mkdirSync(staged, { recursive: true });
  const dated = publishDate ? `publish_date: "${publishDate}"\n` : '';
  fs.writeFileSync(path.join(staged, 'a-post.md'), POST(dated));
  fs.writeFileSync(path.join(staged, 'a-post.sv.md'), POST(`lang: "sv"\n${dated}`));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/publish.sh'), script || `#!/bin/sh
mkdir -p content/blog
for f in "$@"; do
  name=$(basename "$f")
  cp "$f" "content/blog/$name"
  printf 'PUBLISHED\\t%s\\thttps://example.test/blog/%s\\n' "$f" "\${name%.md}"
done
`, { mode: 0o755 });
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'seed'); git(root, 'push', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', 'main');
  return { base, root, remote, statePath: path.join(root, '.build-studio'), logsPath: path.join(root, 'tmp/.logs') };
}

const cfgFor = (over = {}) => cp.resolveConfig({ content_publishing: { enabled: true, command: 'sh scripts/publish.sh', verify_url: false, ...over } });
const publish = (p, post, over = {}) => cp.publishPost({
  projectRoot: p.root, statePath: p.statePath, logsPath: p.logsPath, defaultBranch: 'main',
  cfg: cfgFor(over), post, trigger: 'manual',
});

// ── the parts that must never touch the project's own content ────────────────

test('stamping edits lines and leaves every other key byte for byte', () => {
  const out = cp.stampFrontmatter(POST(), { status: 'published', posted_to: 'https://x/y', publishedAt: '2026-09-20T08:00:00.000Z' });
  assert.match(out, /^status: "published"$/m);
  assert.match(out, /^posted_to: "https:\/\/x\/y"$/m);
  assert.match(out, /customKey:\n  - kept\n  - exactly\n/, 'a key this module has never heard of survives untouched');
  assert.match(out, /title: "A post — with a dash"/);
  assert.ok(out.endsWith('\nBody.\n'), 'the body is not touched');
  assert.equal((out.match(/^status:/gm) || []).length, 1, 'replaced, not duplicated');
});

test('off unless a project asks for it', () => {
  assert.equal(cp.resolveConfig({}).enabled, false);
  assert.equal(cp.resolveConfig({ content_publishing: { enabled: 'yes' } }).enabled, false, 'only a literal true');
  assert.equal(cp.resolveConfig({ content_publishing: { enabled: true } }).enabled, true);
});

test('language variants of one slug are one post', () => {
  const p = makeProject();
  const posts = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, 'a-post');
  assert.deepEqual(posts[0].files.map((f) => f.lang), [null, 'sv']);
});

test('a dated post is due at the publish time, an undated one never', () => {
  const dated = { status: 'draft', publish_date: '2026-09-20' };
  assert.equal(cp.isDue(dated, new Date(2026, 8, 20, 7, 59), '08:00'), false);
  assert.equal(cp.isDue(dated, new Date(2026, 8, 20, 8, 0), '08:00'), true);
  assert.equal(cp.isDue(dated, new Date(2026, 8, 25, 3, 0), '08:00'), true, 'a missed date is still due — late, not lost');
  assert.equal(cp.isDue({ status: 'draft', publish_date: null }, new Date(2030, 0, 1), '08:00'), false);
  assert.equal(cp.isDue({ ...dated, status: 'published' }, new Date(2026, 8, 21), '08:00'), false);
});

test('the command answers with tab-separated PUBLISHED lines; the rest is log', () => {
  const m = cp.parsePublished('building…\nPUBLISHED\tdocs/a b.md\thttps://x/a\nnoise PUBLISHED x y\n');
  assert.deepEqual([...m], [['docs/a b.md', 'https://x/a']]);
});

// ── the whole path, against a real repository and a real remote ──────────────

test('publishing runs the command, stamps, commits only its own paths, and pushes', async () => {
  const p = makeProject();
  fs.writeFileSync(path.join(p.root, 'unrelated.txt'), 'someone else is mid-edit\n');   // dirty before we start
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post);

  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state, 'published');
  const stagedText = fs.readFileSync(path.join(p.root, post.files[0].path), 'utf8');
  assert.match(stagedText, /^status: "published"$/m);
  assert.match(stagedText, /^posted_to: "https:\/\/example\.test\/blog\/a-post"$/m);
  assert.match(stagedText, /^publishedAt: "/m);

  const committed = git(p.root, 'show', '--name-only', '--pretty=', 'HEAD');
  assert.match(committed, /content\/blog\/a-post\.md/);
  assert.match(committed, /staged\/a-post\.sv\.md/);
  assert.doesNotMatch(committed, /unrelated\.txt/, 'a file that was already dirty is not swept in');
  assert.match(git(p.root, 'status', '--porcelain'), /unrelated\.txt/, 'and is left exactly as it was');
  assert.equal(git(p.remote, 'rev-parse', 'main').trim(), git(p.root, 'rev-parse', 'HEAD').trim(), 'pushed');
});

test('a failing command is marked failed, logged in full, and changes nothing', async () => {
  const p = makeProject({ script: '#!/bin/sh\necho "about to break" \necho "image optimiser not found: sharp" >&2\nexit 3\n' });
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post);

  assert.equal(r.ok, false);
  assert.equal(r.state, 'failed');
  assert.match(r.reason, /exited 3/);
  const log = fs.readFileSync(r.logFile, 'utf8');
  assert.match(log, /image optimiser not found: sharp/, 'stderr is in the log — it is what an agent fixing this reads');
  assert.match(log, /about to break/);
  // The ignore rule for the history file is committed up front; the PUBLISH is not.
  assert.doesNotMatch(git(p.root, 'log', '--pretty=%s'), /content: publish/, 'no publish commit');
  assert.deepEqual(r.dirtyPaths, [], 'this script wrote nothing before failing');
  assert.match(fs.readFileSync(path.join(p.root, post.files[0].path), 'utf8'), /^status: "draft"$/m, 'still a draft');
});

test('success without a PUBLISHED line per file is a failure, not a guess', async () => {
  const p = makeProject({ script: '#!/bin/sh\nprintf \'PUBLISHED\\t%s\\thttps://example.test/x\\n\' "$1"\n' });   // only the first file
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post);
  assert.equal(r.state, 'failed');
  assert.match(r.reason, /a-post\.sv\.md/);
});

// During a run the working tree sits on a feature branch; a commit made there
// would land on it. Waiting is safe — late, never lost, never on the wrong branch.
test('off the default branch the publish is deferred, and leaves no history', async () => {
  const p = makeProject();
  git(p.root, 'checkout', '-q', '-b', 'feature/x');
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post);
  assert.equal(r.state, 'deferred');
  assert.match(r.reason, /feature\/x/);
  assert.deepEqual(cp.readHistory(p.statePath), [], 'a deferral is not an attempt');
});

// A loop that re-runs a broken script every fifteen minutes buries the first,
// useful log under dozens of identical ones — and the command may have
// half-published. A failure waits for a person and a manual retry.
test('the timer does not retry a failed post; a manual publish does', async () => {
  const p = makeProject({ script: '#!/bin/sh\nexit 1\n' });
  const config = { projectRoot: p.root, name: 'proj', statePath: p.statePath, logsPath: p.logsPath,
    content_publishing: { enabled: true, command: 'sh scripts/publish.sh', verify_url: false } };
  const pub = createPublisher(config);
  await pub.tick();
  await pub.tick();
  assert.equal(cp.readHistory(p.statePath).length, 1, 'one attempt, not one per tick');
  assert.equal(pub.overview().posts[0].state, 'failed');
  assert.equal(pub.alerts()[0].kind, 'publish-failed');
  assert.match(pub.alerts()[0].detail, /publish-a-post-.*\.log/, 'the alert points at the log');
});

// Off means nothing publishes. The queue is still shown, so the owner can see
// what the first check would publish BEFORE switching it on.
test('a disabled project never ticks, but shows its queue', async () => {
  const p = makeProject();
  const pub = createPublisher({ projectRoot: p.root, name: 'proj', statePath: p.statePath, logsPath: p.logsPath });
  assert.deepEqual(await pub.tick(), { ran: false });
  const o = pub.overview();
  assert.equal(o.enabled, false);
  assert.equal(o.posts.length, 1);
  assert.equal(o.posts[0].status, 'draft');
  assert.deepEqual(o.history, []);
});

test('an undated draft is listed as unscheduled and waits for a click', () => {
  const p = makeProject({ publishDate: null });
  const pub = createPublisher({ projectRoot: p.root, name: 'proj', statePath: p.statePath, logsPath: p.logsPath,
    content_publishing: { enabled: true, command: 'sh scripts/publish.sh' } });
  assert.equal(pub.overview().posts[0].state, 'unscheduled');
});

// Not cleaned up — a half-written post is the evidence whoever fixes the script
// needs. But reported, because a dirty default branch blocks the next run.
test('what a failed command left behind is reported, not removed', async () => {
  const p = makeProject({ script: '#!/bin/sh\nmkdir -p content/blog\necho half > content/blog/half.md\nexit 1\n' });
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post);
  assert.deepEqual(r.dirtyPaths, ['content/blog/half.md']);
  assert.ok(fs.existsSync(path.join(p.root, 'content/blog/half.md')), 'left in place');
  assert.match(fs.readFileSync(r.logFile, 'utf8'), /left in the working tree/);
});

// ── after_push_command: for a project whose push does not deploy ─────────────

test('after_push_command runs after the push, and sees the pushed commit', async () => {
  const p = makeProject();
  const envFile = path.join(p.base, 'after-push.env');
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post, {
    after_push_command: `printf '%s|%s|%s|%s' "$BUILD_STUDIO_PUBLISH_SHA" "$BUILD_STUDIO_PUBLISH_ID" "$BUILD_STUDIO_PUBLISH_BRANCH" "$BUILD_STUDIO_PUBLISH_URLS" > '${envFile}'`,
  });
  assert.equal(r.ok, true);
  assert.equal(r.deploy, 'started');
  const [sha, id, branch, urls] = fs.readFileSync(envFile, 'utf8').split('|');
  // The commit it sees is the one ORIGIN has — i.e. it ran after the push.
  assert.equal(sha, git(p.remote, 'rev-parse', 'main').trim());
  assert.match(git(p.remote, 'log', '-1', '--format=%s', 'main'), /^content: publish/);
  assert.equal(id, 'a-post');
  assert.equal(branch, 'main');
  assert.match(urls, /https:\/\/example\.test\/blog\/a-post/);
});

test('a failing after_push_command reports a failed deploy, not a failed publish', async () => {
  const p = makeProject();
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post, { after_push_command: 'echo "gh: not logged in" >&2; exit 4' });
  assert.equal(r.ok, true, 'committed and pushed — rerunning would double-publish');
  assert.equal(r.state, 'published');
  assert.equal(r.deploy, 'failed');
  assert.match(r.deployReason, /exited 4/);
  assert.match(fs.readFileSync(r.logFile, 'utf8'), /gh: not logged in/);
  assert.match(git(p.remote, 'log', '-1', '--format=%s', 'main'), /^content: publish/);
});

test('without after_push_command nothing extra runs and no deploy field is set', async () => {
  const p = makeProject();
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await publish(p, post);
  assert.equal(r.ok, true);
  assert.equal('deploy' in r, false);
});

test('a failed deploy raises its own Monitor alert on the published post', async () => {
  const p = makeProject();
  const pub = createPublisher({
    projectRoot: p.root, name: 'proj', statePath: p.statePath, logsPath: p.logsPath,
    content_publishing: { enabled: true, command: 'sh scripts/publish.sh', verify_url: false, after_push_command: 'exit 1' },
  });
  const [post] = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  const r = await pub.publishOne(post, 'manual');
  assert.equal(r.deploy, 'failed');
  const alerts = pub.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'deploy-failed');
  assert.match(alerts[0].detail, /do not publish it again/);
});

// ── the MDX + choice-field contract (Launch Studio LS-180 / LS-181) ──────────
//
// Launch Studio can stage posts as .mdx and add per-post choice fields
// (category, type). Build Studio's side needs no new code: the scan already
// accepts .mdx, and the stamp is a line edit that leaves every other key and
// the body alone. These pin that, so a later change cannot quietly break it.

const MDX_POST = (lang) => `---
title: "Fasting, explained"
slug: "fasting-explained"
${lang ? `lang: "${lang}"\n` : ''}category: "guides"
type: "founder-note"
status: "draft"
---

Intro with an escaped brace \\{ and a less-than \\< sign.

<PullQuote>A quote from the founder.</PullQuote>

<InFazon>Track this in the app.</InFazon>
`;

test('an EN + SV .mdx pair is one post, and publishing changes only the protocol lines', async () => {
  const p = makeProject();
  const staged = path.join(p.root, 'docs/marketing/content/staged');
  fs.rmSync(path.join(staged, 'a-post.md')); fs.rmSync(path.join(staged, 'a-post.sv.md'));
  fs.writeFileSync(path.join(staged, 'fasting-explained.mdx'), MDX_POST(null));
  fs.writeFileSync(path.join(staged, 'fasting-explained.sv.mdx'), MDX_POST('sv'));
  git(p.root, 'add', '-A'); git(p.root, 'commit', '-m', 'stage mdx'); git(p.root, 'push');

  const posts = cp.scanStaged(p.root, 'docs/marketing/content/staged');
  assert.equal(posts.length, 1, 'the two variants are one post');
  assert.deepEqual(posts[0].files.map((f) => [path.basename(f.path), f.lang]), [['fasting-explained.mdx', null], ['fasting-explained.sv.mdx', 'sv']]);

  const r = await publish(p, posts[0]);
  assert.equal(r.ok, true, r.reason);

  for (const [name, lang] of [['fasting-explained.mdx', null], ['fasting-explained.sv.mdx', 'sv']]) {
    const after = fs.readFileSync(path.join(staged, name), 'utf8');
    // Drop the three lines the stamp owns; what remains must be the original exactly.
    const withoutStamp = after.split('\n').filter((l) => !/^(posted_to|publishedAt):/.test(l)).join('\n').replace('status: "published"', 'status: "draft"');
    assert.equal(withoutStamp, MDX_POST(lang), `${name}: choice keys, components and escapes survive byte for byte`);
    assert.match(after, /^status: "published"$/m);
  }
  assert.match(git(p.root, 'show', '--name-only', '--pretty=', 'HEAD'), /content\/blog\/fasting-explained\.sv\.mdx/);
});

test('a Markdown post is unaffected by the MDX contract (existing projects)', () => {
  assert.deepEqual(cp.parseName('a-post.md'), { slug: 'a-post', lang: null });
  assert.deepEqual(cp.parseName('a-post.sv.md'), { slug: 'a-post', lang: 'sv' });
  assert.deepEqual(cp.parseName('a-post.sv.mdx'), { slug: 'a-post', lang: 'sv' });
  assert.equal(cp.parseName('a-post.txt'), null);
});
