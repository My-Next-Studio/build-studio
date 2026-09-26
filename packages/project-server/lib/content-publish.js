'use strict';

/**
 * Scheduled publishing of staged content — the publisher side of a handoff.
 *
 * A content tool stages posts in the project as markdown with `status: draft`
 * and, optionally, a `publish_date`. It never publishes. This module is the
 * other half: when a post is due (or on a manual trigger) it runs the PROJECT'S
 * OWN publish command, commits and pushes what that command produced, and
 * stamps the staged file so the content tool can read the result back.
 *
 * WHY THE PROJECT SUPPLIES THE COMMAND
 *
 * What "publish" means is different in every project: one copies markdown into
 * a content directory with different frontmatter keys, another has images to
 * optimise, a third calls a CMS. Build Studio cannot know, so it owns only the
 * parts that are the same everywhere — when, git, the stamp, the record — and
 * delegates the one part that is not.
 *
 * OFF BY DEFAULT. Nothing here runs unless a project sets
 * `content_publishing.enabled: true`, because it pushes to the default branch
 * unattended, and that must be something a project asked for.
 *
 * THE FOUR PROTOCOL FIELDS (owned by the handoff, not by the project's content)
 *
 *   status        draft -> published        flipped here
 *   publish_date  YYYY-MM-DD, optional      written by the content tool
 *   posted_to     the live URL              stamped here
 *   publishedAt   the flip time             stamped here
 *
 * Every other frontmatter key is the project's own and is never parsed,
 * reordered or rewritten: the stamp is a line edit, not a YAML round-trip, so a
 * key this module has never heard of survives byte for byte.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ensureIgnoreRule } = require('./ignore-rule');

const DEFAULTS = {
  enabled: false,
  staged_dir: 'docs/marketing/content/staged',
  command: null,
  // Local time of day a dated post becomes due. A date alone would publish at
  // midnight, which is nobody's intent.
  publish_time: '08:00',
  check_interval_minutes: 15,
  command_timeout_minutes: 10,
  // Verify the live URL answers after the push, and how long to keep trying.
  verify_url: true,
  verify_timeout_minutes: 20,
  // Run after a successful push, from the project root — for a project whose
  // push does not deploy (a manual workflow_dispatch, say). It cannot live in
  // `command`: that runs BEFORE the commit, so a deploy started there ships the
  // previous tip. Env: BUILD_STUDIO_PUBLISH_ID, _SHA (the pushed commit),
  // _BRANCH, _URLS (space-separated). A failure here does not unpublish: the
  // post is committed and pushed, so it is reported as a failed deploy.
  after_push_command: null,
  after_push_timeout_minutes: 5,
};

function resolveConfig(config) {
  const raw = (config && config.content_publishing) || {};
  return { ...DEFAULTS, ...raw, enabled: raw.enabled === true };
}

// ── frontmatter: read a few keys, edit lines, never re-serialise ─────────────

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** Top-level scalar keys only. Nested and list values are left alone, unread. */
function readFrontmatter(text) {
  const m = FM_RE.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

/** Set top-level scalar keys by editing or appending lines inside the block. */
function stampFrontmatter(text, fields) {
  const m = FM_RE.exec(String(text || ''));
  if (!m) throw new Error('no frontmatter block to stamp');
  const lines = m[1].split(/\r?\n/);
  for (const [key, value] of Object.entries(fields)) {
    const rendered = `${key}: ${JSON.stringify(String(value))}`;
    const i = lines.findIndex((l) => new RegExp(`^${key}:\\s`).test(l) || l === `${key}:`);
    if (i >= 0) lines[i] = rendered; else lines.push(rendered);
  }
  return `---\n${lines.join('\n')}\n---${m[2]}${text.slice(m[0].length)}`;
}

// ── posts: language variants of one slug publish together ────────────────────

/** `a-post.sv.md` -> { slug: 'a-post', lang: 'sv' }; `a-post.md` -> lang null. */
function parseName(file) {
  const m = /^(.*?)(?:\.([a-z]{2}(?:-[A-Za-z]{2})?))?\.(md|mdx)$/.exec(file);
  if (!m) return null;
  return { slug: m[1], lang: m[2] || null };
}

/**
 * Group staged files into posts. A post is every language variant of one slug,
 * because a reader who follows the language switch on a freshly published post
 * should not land on a 404 for a day.
 */
function scanStaged(projectRoot, stagedDir) {
  const dir = path.join(projectRoot, stagedDir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const posts = new Map();
  for (const name of names.sort()) {
    const parsed = parseName(name);
    if (!parsed) continue;
    let fm = null;
    try { fm = readFrontmatter(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { /* unreadable */ }
    if (!fm) continue;
    if (!posts.has(parsed.slug)) posts.set(parsed.slug, { id: parsed.slug, files: [] });
    posts.get(parsed.slug).files.push({
      path: path.posix.join(stagedDir.split(path.sep).join('/'), name),
      lang: parsed.lang || fm.lang || null,
      title: fm.title || null,
      status: fm.status || null,
      publish_date: fm.publish_date || null,
      posted_to: fm.posted_to || null,
      publishedAt: fm.publishedAt || null,
    });
  }
  return [...posts.values()].map(summarise);
}

function summarise(post) {
  const f = post.files;
  const primary = f.find((x) => !x.lang || x.lang === 'en') || f[0];
  const published = f.every((x) => x.status === 'published');
  // The EARLIEST date among variants: staging one language later than the other
  // must not hold the first one back, and they go out together either way.
  const dates = f.map((x) => x.publish_date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort();
  return {
    ...post,
    title: primary.title,
    status: published ? 'published' : 'draft',
    publish_date: dates[0] || null,
    posted_to: primary.posted_to,
    publishedAt: primary.publishedAt,
  };
}

/** Is this post due at `now`? Undated posts never are — they wait for a click. */
function isDue(post, now, publishTime) {
  if (post.status !== 'draft' || !post.publish_date) return false;
  const [h, mi] = String(publishTime || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  const [y, mo, d] = post.publish_date.split('-').map((n) => parseInt(n, 10));
  return now.getTime() >= new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

// ── the record ───────────────────────────────────────────────────────────────

const HISTORY_FILE = 'publish-history.jsonl';

function historyPath(statePath) { return path.join(statePath, HISTORY_FILE); }

function appendHistory(statePath, entry) {
  fs.mkdirSync(statePath, { recursive: true });
  fs.appendFileSync(historyPath(statePath), JSON.stringify(entry) + '\n', 'utf8');
}

function readHistory(statePath, limit = 200) {
  let raw = '';
  try { raw = fs.readFileSync(historyPath(statePath), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a torn line is skipped, never fatal */ }
  }
  return out.slice(-limit).reverse();
}

/** The latest attempt per post — what "is this post currently failing?" reads. */
function lastAttempts(history) {
  const seen = new Map();
  for (const h of history) if (!seen.has(h.id)) seen.set(h.id, h);   // history is newest-first
  return seen;
}

// ── running things without blocking the event loop ───────────────────────────
//
// Async on purpose. This process is also the reader of the ptys its live
// terminals attach through, and a synchronous child process here has already
// deadlocked the server once (see lib/tmux.js).

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        timedOut: !!(err && err.killed),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

const git = (cwd, args) => run('git', args, { cwd });

async function changedPaths(cwd) {
  const r = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (r.code !== 0) return new Set();
  // -z records are `XY <path>\0`; a rename adds a second `\0<orig>` we skip.
  const out = new Set();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    out.add(rec.slice(3));
    if (rec[0] === 'R' || rec[0] === 'C') i++;
  }
  return out;
}

/**
 * The command's answer: one line per published file,
 *   PUBLISHED<TAB><staged path><TAB><live url>
 * Tab-separated so a URL or a path may contain spaces; everything else the
 * command prints is just log.
 */
function parsePublished(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^PUBLISHED\t([^\t]+)\t(\S+)\s*$/.exec(line);
    if (m) out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

/**
 * Publish one post. Never throws: every outcome is a returned, recorded result,
 * because the caller is a timer with nobody watching.
 *
 * @returns {Promise<{ok:boolean, state:string, reason?:string, logFile?:string, urls?:object}>}
 */
async function publishPost({ projectRoot, statePath, logsPath, defaultBranch, cfg, post, trigger, now = new Date() }) {
  const startedAt = now.toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const logFile = logsPath ? path.join(logsPath, `publish-${post.id}-${stamp}.log`) : null;
  const log = [];
  const say = (s) => log.push(s);
  const finish = (result) => {
    if (logFile) {
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, log.join('\n') + '\n', 'utf8'); } catch (_) { /* the record below still stands */ }
    }
    const entry = { at: startedAt, id: post.id, title: post.title, trigger, files: post.files.map((f) => f.path), logFile, ...result };
    // A deferral is not an attempt — it would bury the real history under one
    // line per tick for as long as a run holds the branch.
    if (result.state !== 'deferred') appendHistory(statePath, entry);
    return entry;
  };

  say(`# publish ${post.id} (${trigger}) at ${startedAt}`);
  if (!cfg.command) return finish({ ok: false, state: 'failed', reason: 'content_publishing.command is not set' });

  // Only from the default branch. During a run the working tree sits on a
  // feature branch, and a commit made here would land on it. Waiting is safe:
  // the post is published late, never lost, and never on the wrong branch.
  const head = await git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch !== defaultBranch) {
    return finish({ ok: false, state: 'deferred', reason: `working tree is on "${branch || '?'}", not ${defaultBranch} — waiting for the run to finish` });
  }

  // The history file is machine-local (it carries absolute log paths). Ignore it
  // before it is first written, and commit that one line on its own so the
  // default branch is not left dirty — a dirty tree blocks the next run.
  if (ensureIgnoreRule(projectRoot, `.build-studio/${HISTORY_FILE}`)) {
    await git(projectRoot, ['add', '--', '.gitignore']);
    const gi = await git(projectRoot, ['commit', '-m', 'chore: gitignore publishing history', '--', '.gitignore']);
    say(`--- .gitignore rule added (${gi.code === 0 ? 'committed' : 'NOT committed'}) ---`);
  }

  const before = await changedPaths(projectRoot);
  const files = post.files.map((f) => f.path);
  say(`$ ${cfg.command} ${files.join(' ')}`);
  const r = await run('/bin/sh', ['-c', `${cfg.command} "$@"`, 'publish', ...files], {
    cwd: projectRoot,
    timeout: cfg.command_timeout_minutes * 60 * 1000,
    env: { ...process.env, BUILD_STUDIO_PUBLISH_ID: post.id, BUILD_STUDIO_PUBLISH_TRIGGER: trigger },
  });
  say('--- stdout ---'); say(r.stdout.trimEnd());
  say('--- stderr ---'); say(r.stderr.trimEnd());
  say(`--- exit ${r.code}${r.timedOut ? ' (timed out)' : ''} ---`);
  // What a failed command left behind. NOT cleaned up: a half-written post is
  // the evidence whoever fixes the script needs. But it is reported, because a
  // dirty default branch blocks the next execution run and "why won't my run
  // start" should not be a second mystery stacked on the first.
  const leftovers = async () => {
    const dirty = [...(await changedPaths(projectRoot))].filter((p) => !before.has(p));
    if (dirty.length) { say(`--- left in the working tree (${dirty.length}) ---`); dirty.forEach((p) => say(`  ${p}`)); }
    return dirty;
  };

  if (r.code !== 0) {
    return finish({ ok: false, state: 'failed', reason: r.timedOut ? `command timed out after ${cfg.command_timeout_minutes} min` : `command exited ${r.code}`, exitCode: r.code, dirtyPaths: await leftovers() });
  }

  const urls = parsePublished(r.stdout);
  const missing = files.filter((f) => !urls.has(f));
  if (missing.length) {
    return finish({ ok: false, state: 'failed', reason: `command succeeded but printed no PUBLISHED line for: ${missing.join(', ')}`, dirtyPaths: await leftovers() });
  }

  // Stamp the staged files, then commit exactly what this publish touched:
  // whatever the command changed, plus the stamps. Paths that were already dirty
  // before the command ran belong to someone else and stay out.
  const publishedAt = new Date().toISOString();
  for (const f of files) {
    const abs = path.join(projectRoot, f);
    fs.writeFileSync(abs, stampFrontmatter(fs.readFileSync(abs, 'utf8'), { status: 'published', posted_to: urls.get(f), publishedAt }), 'utf8');
  }
  const after = await changedPaths(projectRoot);
  const mine = [...after].filter((p) => !before.has(p) || files.includes(p));
  say(`--- committing ${mine.length} path(s) ---`); mine.forEach((p) => say(`  ${p}`));

  const add = await git(projectRoot, ['add', '--', ...mine]);
  const commit = add.code === 0
    ? await git(projectRoot, ['commit', '-m', `content: publish "${post.title || post.id}"`, '--', ...mine])
    : add;
  say(commit.stdout.trimEnd()); say(commit.stderr.trimEnd());
  if (commit.code !== 0) return finish({ ok: false, state: 'failed', reason: 'git commit failed — see log', urls: Object.fromEntries(urls) });

  const push = await git(projectRoot, ['push', 'origin', defaultBranch]);
  say('--- push ---'); say(push.stdout.trimEnd()); say(push.stderr.trimEnd());
  if (push.code !== 0) {
    // Committed locally but not live. Say so precisely: retrying the COMMAND
    // would double-publish; the remedy is a push.
    return finish({ ok: false, state: 'push-failed', reason: 'committed locally, but git push failed — see log', urls: Object.fromEntries(urls) });
  }

  let deploy = null;
  if (cfg.after_push_command) {
    const sha = (await git(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    say(`$ ${cfg.after_push_command}`);
    const d = await run('/bin/sh', ['-c', cfg.after_push_command], {
      cwd: projectRoot,
      timeout: cfg.after_push_timeout_minutes * 60 * 1000,
      env: {
        ...process.env,
        BUILD_STUDIO_PUBLISH_ID: post.id,
        BUILD_STUDIO_PUBLISH_SHA: sha,
        BUILD_STUDIO_PUBLISH_BRANCH: defaultBranch,
        BUILD_STUDIO_PUBLISH_URLS: [...urls.values()].join(' '),
      },
    });
    say('--- after_push stdout ---'); say(d.stdout.trimEnd());
    say('--- after_push stderr ---'); say(d.stderr.trimEnd());
    say(`--- after_push exit ${d.code}${d.timedOut ? ' (timed out)' : ''} ---`);
    deploy = d.code === 0
      ? { state: 'started' }
      : { state: 'failed', reason: d.timedOut ? `after_push_command timed out after ${cfg.after_push_timeout_minutes} min` : `after_push_command exited ${d.code}` };
  }

  // Still ok: the post is committed, pushed and stamped. A failed deploy is
  // reported beside it — rerunning the publish would double-publish.
  return finish({
    ok: true, state: 'published', urls: Object.fromEntries(urls), publishedAt,
    verify: cfg.verify_url ? 'pending' : 'skipped',
    ...(deploy ? { deploy: deploy.state, ...(deploy.reason ? { deployReason: deploy.reason } : {}) } : {}),
  });
}

module.exports = {
  DEFAULTS, HISTORY_FILE,
  resolveConfig, readFrontmatter, stampFrontmatter, parseName, scanStaged,
  isDue, appendHistory, readHistory, lastAttempts, parsePublished, publishPost,
};
