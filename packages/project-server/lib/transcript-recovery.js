'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Recover the output of an agent that finished but never reported.
 *
 * Observed twice on 2026-07-30/31, on different steps and different projects:
 * an agent completes its work — writes the files, makes the commit, prints the
 * full report — and then simply ends its turn without running the feedback
 * curl. The workflow has no idea it finished, so the watchdog eventually marks
 * it stalled, and the standard advice ("cancel and relaunch") throws away
 * twenty minutes of work to re-derive an answer that already exists.
 *
 * It already exists on disk. The Claude CLI writes every turn to a JSONL
 * transcript, and Build Studio already records the agent's `cliSessionId` when
 * it launches. So the final report can be read back verbatim — full fidelity,
 * not a reflowed terminal scrape — and delivered as the feedback the agent
 * failed to send.
 *
 * This is strictly better than nudging the pane. Under memory pressure the
 * process stops accepting input entirely (both observed cases), so a nudge
 * cannot land — but the transcript is unaffected.
 */

/** Where the Claude CLI keeps per-project transcripts. */
function projectsRoot(home = os.homedir()) {
  return path.join(home, '.claude', 'projects');
}

/**
 * Directory-name spellings the CLI may have used for a working directory.
 *
 * The encoding has changed across CLI versions — this machine carries both
 * `-Volumes-Extern-projects-sickla_tunneln` (underscore kept) and
 * `-Volumes-Extern-projects-sickla-tunneln` (underscore replaced) for the same
 * project. Dots always become dashes, so a worktree at `tmp/.worktrees/x`
 * encodes as `tmp--worktrees-x`. Case is preserved.
 *
 * These are a fast path only; `findTranscript` falls back to a scan, which is
 * what makes the lookup version-proof.
 */
function slugCandidates(cwd) {
  const s = String(cwd || '');
  if (!s) return [];
  return [
    s.replace(/[^a-zA-Z0-9_-]/g, '-'), // keeps underscores (older CLI)
    s.replace(/[^a-zA-Z0-9-]/g, '-'),  // replaces them (newer CLI)
  ].filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Locate an agent's transcript.
 *
 * Tries the derived directory names first, then scans every project directory
 * for the session id. A session id is a UUID, so a hit is unambiguous and the
 * scan does not care how the CLI spelled the path.
 *
 * @returns {string|null} absolute path, or null when there is no transcript
 */
function findTranscript(cliSessionId, agentCwd, { home = os.homedir() } = {}) {
  if (!cliSessionId) return null;
  const root = projectsRoot(home);
  const file = `${cliSessionId}.jsonl`;

  for (const slug of slugCandidates(agentCwd)) {
    const p = path.join(root, slug, file);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* keep looking */ }
  }

  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, file);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* keep looking */ }
  }
  return null;
}

/**
 * The agent's last piece of prose — its report.
 *
 * Walks the whole transcript rather than reading the final line: the last
 * entries are typically `system` records written after the assistant's closing
 * message, and tool-use blocks carry no text. Blank text blocks are skipped so
 * an empty trailing turn does not mask the real answer.
 *
 * @param {string} jsonlText  raw transcript contents
 * @returns {string|null}
 */
function extractFinalAssistantText(jsonlText) {
  let final = null;
  for (const line of String(jsonlText || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch (_) { continue; } // a partial trailing write
    if (!row || row.type !== 'assistant') continue;
    const content = row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        final = block.text;
      }
    }
  }
  return final;
}

/**
 * Read back what an agent produced, if anything.
 *
 * @returns {null|{text:string, chars:number, transcript:string}}
 */
function recoverAgentOutput(agent, opts = {}) {
  if (!agent || !agent.cliSessionId) return null;
  const file = findTranscript(agent.cliSessionId, agent.agentCwd, opts);
  if (!file) return null;
  let text = null;
  try { text = extractFinalAssistantText(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (!text) return null;
  return { text, chars: text.length, transcript: file };
}

module.exports = {
  projectsRoot, slugCandidates, findTranscript, extractFinalAssistantText, recoverAgentOutput,
};
