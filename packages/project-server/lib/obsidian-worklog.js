'use strict';

// Appends a line to the owner's Obsidian daily note through the `obsidian` CLI.
//
// Never blocks the server. This used to be execFileSync with a 5 s timeout, but
// a sync call's timeout only sends SIGTERM and then waits for the child to
// exit. The Obsidian CLI can ignore SIGTERM while it waits for the Obsidian app
// (not running after a reboot, say), and the whole project-server then hung on
// it: every request queued unanswered, so the run looked stuck at its last step.
// Now the CLI runs asynchronously and is killed with SIGKILL at the timeout.

const { execFile } = require('child_process');

const TIMEOUT_MS = 5000;

/** Run the CLI once; resolves to its stdout, rejects on error or timeout. Never throws synchronously. */
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (err, stdout) => {
        if (err) reject(err.killed ? new Error(`${bin} did not finish within ${timeoutMs} ms; killed`) : err);
        else resolve(stdout || '');
      });
    } catch (e) { reject(e); }
  });
}

/**
 * Append `content` to the vault note at `dailyPath`, creating the note with a
 * frontmatter header when the CLI reports it missing. Resolves to true when
 * written, false on any failure (logged, never thrown): the note is advisory.
 */
async function obsidianAppend({ vault, dailyPath, content, date, label = 'Worklog', bin = 'obsidian', timeoutMs = TIMEOUT_MS }) {
  const append = () => run(bin, ['append', `path=${dailyPath}`, `content=${content}`, `vault=${vault}`, 'silent'], timeoutMs);
  try {
    const out = await append();
    if (out.includes('Error:')) {
      const frontmatter = `---\\ndate: ${date}\\n---\\n\\n## Work Log`;
      await run(bin, ['create', `path=${dailyPath}`, `content=${frontmatter}`, `vault=${vault}`, 'silent'], timeoutMs);
      await append();
    }
    console.log(`[workflow] ${label} written to ${vault}/${dailyPath}`);
    return true;
  } catch (e) {
    console.warn(`[workflow] Failed to write ${label.toLowerCase()} to Obsidian: ${e.message}`);
    return false;
  }
}

module.exports = { obsidianAppend, TIMEOUT_MS };
