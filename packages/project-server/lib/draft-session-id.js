'use strict';

/**
 * Find the session id of a drafting conversation on a CLI that cannot be told
 * one at launch.
 *
 * Claude takes `--session-id <uuid>`, so its id is chosen up front. Codex and
 * OpenCode both resume by id (`codex resume <id>`, `opencode --session <id>`)
 * but pick the id themselves, so it has to be read back from their own session
 * records afterwards. Until this existed, every Draft on those CLIs started a
 * fresh conversation.
 *
 * WHY NOT THE PANE LOG. Codex prints `session id:` in its banner, and
 * codex-telemetry reads it from there for workflow agents. The drafting log is
 * appended to across launches, so its first id is the OLDEST session, not this
 * one. The CLI's own record is the reliable source.
 *
 * WHAT COUNTS AS A MATCH. A session in this project's directory, created at or
 * after the launch, whose opening message carries the draft prompt. The prompt
 * check is what rules out a workflow agent that happened to start in the same
 * directory in the same few seconds. The earliest match wins.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Clock slack between our launch stamp and the CLI's own. */
const SKEW_MS = 5000;
/** How much of a codex rollout to read: the meta line and the first message. */
const HEAD_BYTES = 256 * 1024;

/** The phrase every opening draft prompt carries (drafting.js draftPrompt). */
function draftMarker(itemId) {
  return `draft a PRD for backlog item ${itemId}`;
}

function readHead(file, bytes = HEAD_BYTES) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

/** Day directories (YYYY/MM/DD, local time) from `since` to now. */
function dayDirs(root, since, now) {
  const out = [];
  const d = new Date(since);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(path.join(root, y, m, day));
  }
  return out;
}

/**
 * Codex: rollout files under ~/.codex/sessions/YYYY/MM/DD/. Their first line is
 * `session_meta` with the id, cwd and timestamp.
 */
function findCodexSessionId({ projectRoot, since, itemId, home = os.homedir(), now = Date.now() }) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs) || !itemId) return null;
  const marker = draftMarker(itemId);
  const candidates = [];
  for (const dir of dayDirs(path.join(home, '.codex', 'sessions'), sinceMs - SKEW_MS, now)) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const head = readHead(path.join(dir, name));
      if (!head) continue;
      let meta;
      try { meta = JSON.parse(head.slice(0, head.indexOf('\n') > 0 ? head.indexOf('\n') : undefined)); } catch (_) { continue; }
      const p = meta && meta.type === 'session_meta' && meta.payload;
      if (!p || p.cwd !== projectRoot) continue;
      const created = Date.parse(p.timestamp || meta.timestamp);
      if (!Number.isFinite(created) || created < sinceMs - SKEW_MS) continue;
      if (!head.includes(marker)) continue;
      candidates.push({ id: String(p.id || p.session_id), created });
    }
  }
  candidates.sort((a, b) => a.created - b.created);
  return candidates.length ? candidates[0].id : null;
}

/**
 * OpenCode: `opencode session list --format json` gives id, directory and
 * created; `opencode export <id>` gives the messages to check the prompt in.
 */
function findOpencodeSessionId({ projectRoot, since, itemId, exec = execFileSync }) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs) || !itemId) return null;
  const run = (args) => exec('opencode', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  let list;
  try { list = JSON.parse(run(['session', 'list', '--format', 'json', '-n', '30'])); } catch (_) { return null; }
  const candidates = (Array.isArray(list) ? list : [])
    .filter((s) => s && s.directory === projectRoot && Number(s.created) >= sinceMs - SKEW_MS)
    .sort((a, b) => Number(a.created) - Number(b.created));
  const marker = draftMarker(itemId);
  for (const s of candidates) {
    let exported = '';
    try { exported = run(['export', s.id]); } catch (_) { continue; }
    if (exported.includes(marker)) return s.id;
  }
  return null;
}

/**
 * The id of a drafting session on `cli`, read back from the CLI. Null when it
 * cannot be found; the caller then starts a fresh conversation, as before.
 *
 * @param {object} p  { cli, projectRoot, since (ISO launch time), itemId (the item the session opened on) }
 */
function findDraftSessionId(p, deps = {}) {
  if (p.cli === 'codex') return findCodexSessionId({ ...p, ...deps });
  if (p.cli === 'opencode') return findOpencodeSessionId({ ...p, ...deps });
  return null;
}

module.exports = { findDraftSessionId, findCodexSessionId, findOpencodeSessionId, draftMarker };
