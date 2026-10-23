const { execSync, execFileSync: rawExecFileSync, spawnSync } = require('child_process');

// Note: Uses execSync for tmux shell commands, matching the existing example-web
// codebase patterns. All inputs are from project config (not user input).

/**
 * Every tmux call here is SYNCHRONOUS, and this process is also the reader of
 * the ptys that attached tmux clients write to — the hub's live terminals. That
 * pair can deadlock:
 *
 *   1. a sync tmux call blocks the event loop;
 *   2. tmux wants to redraw an attached client and writes to its pty;
 *   3. the reader of that pty is this process, which is blocked;
 *   4. the pty fills, tmux blocks on the write, and the call never returns.
 *
 * Seen live 2026-09-19: `tmux send-keys` hung for minutes with a drafting
 * terminal attached, and the project-server stopped answering HTTP entirely —
 * frozen behind its own tmux command.
 *
 * The real remedy is async tmux calls, which is a larger change than the bug
 * warrants today. A timeout is the safety net: the call dies, the loop resumes,
 * the pty drains, and the failure surfaces as an error instead of a freeze.
 * Generous enough that a merely busy tmux is not mistaken for a wedged one.
 */
const TMUX_TIMEOUT_MS = 5000;
const execFileSync = (file, args, opts) =>
  rawExecFileSync(file, args, { timeout: TMUX_TIMEOUT_MS, ...(opts || {}) });

/**
 * tmux 3.6a segfaults when a session that belongs to a session GROUP is
 * destroyed by killing its last window (server_kill_window →
 * server_destroy_session_group → session_destroy → notify_session →
 * cmd_find_from_nothing, NULL + 0x1b8). The crash takes down the whole server,
 * so every agent, every drafting session and every terminal the owner had open
 * in Build Studio goes with it. It happened three times in four days
 * (2026-09-25, -27, -28; crash reports in ~/Library/Logs/DiagnosticReports).
 * Upstream fixed it in 3.8 (issues 5180 and 5620: session_detach no longer
 * empties a session, so a grouped one is never left pointing at a freed window).
 *
 * Build Studio creates exactly that shape: the hub terminal attaches through a
 * `view-*` session grouped with the agent's session (server.js openAgentPty),
 * and that view lives as long as the agent window does.
 *
 * Only `kill-window` on a session's LAST window reaches the crash, and only when
 * a grouped session sorts before the base: tmux visits sessions by name, so
 * `view-*` empties first and is left pointing at a freed window, which the
 * lookup in notify_session then reads. `wf-*` sessions always sort after their
 * views; `draft-*` ones never do. `kill-session` cannot crash at all: it
 * destroys the one session named and never takes the group path
 * (cmd-kill-session.c). Both were reproduced against 3.6a on a throwaway socket.
 *
 * So the rule: never kill-window a session's last window. Close its session
 * instead (closeSession), and release the views around it.
 *
 * Releasing views before the kill was the first version of this fix (09-28),
 * and on its own it was not enough: the crash came back on 10-16, -19, -20 and
 * -23. Every tmux call is bounded by TMUX_TIMEOUT_MS, and the listing that finds
 * the views timed out, which read as "not grouped", so the kill went ahead with
 * the view still attached. That timeout is most likely at exactly this moment:
 * an agent printing its last output into a pane this process is attached to (the
 * deadlock described above). So nothing here may read "tmux did not answer" as
 * "safe".
 */
function listSessionGroups() {
  return execFileSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_group}'], { stdio: ['pipe', 'pipe', 'pipe'] })
    .toString().split('\n').filter(Boolean).map((l) => l.split('\t'));
}

/** What a failed tmux call said, for a log line. */
function tmuxError(e) {
  if (e && e.code === 'ETIMEDOUT') return `tmux did not answer within ${TMUX_TIMEOUT_MS}ms`;
  const stderr = e && e.stderr ? e.stderr.toString().trim() : '';
  return stderr || (e && e.message) || String(e);
}

/** True when a tmux call failed only because what it named is already gone. */
function isGone(e) {
  const stderr = e && e.stderr ? e.stderr.toString() : '';
  return /can't find (session|window)|no server running|error connecting to/.test(stderr);
}

// The close path below used to swallow every failure. Twice on 2026-10-23 a
// draft start left the previous draft's window and the hub's view of it
// standing, under load, and nothing said which call had failed. A failure
// other than "already gone" is now logged with what tmux answered.
//
// "Already gone" is still not logged: it is the normal answer when a window
// closed on its own. But it was wrong once the same day, under load, with the
// window plainly still there, and no line anywhere said what tmux had answered.
// So each helper also takes an optional `failures` list and adds every failed
// call to it, gone or not, for a caller that can tell the two apart by looking
// (createWindow).

function noteFailure(failures, what, e) {
  if (failures) failures.push(`${what}: ${tmuxError(e)}`);
}

/**
 * Remove the hub's `view-*` sessions grouped with `sessionName`. Killing a view
 * only detaches the hub's terminal for a window that is about to disappear.
 *
 * Works after the base session is gone too: the group keeps its name, the name
 * of the session it was created from, and a view left in it holds the windows
 * open, agent and all.
 *
 * @returns {number} views removed
 */
function releaseGroupedViews(sessionName, failures) {
  if (!sessionName) return 0;
  const rows = listSessionsFor(sessionName, failures);
  if (!rows) return 0;
  const base = rows.find(([name]) => name === sessionName);
  const group = base ? base[1] : sessionName;
  if (!group) return 0;                          // not grouped: nothing to do
  return closeViews(rows, group, sessionName, failures);
}

/**
 * Remove views left in a group named `sessionName` that the session itself is
 * not in. They outlive a session that was closed while a view's kill failed,
 * still holding its windows. And tmux finds a group by NAME when a new view is
 * grouped with a session (session_group_new), so the next view pulls the new
 * session into that old group, old windows and all: a finished draft's window
 * came back beside the next draft, and the hub showed it instead (2026-10-23).
 *
 * @returns {number} views removed
 */
function releaseOrphanViews(sessionName) {
  if (!sessionName) return 0;
  const rows = listSessionsFor(sessionName);
  if (!rows) return 0;
  const base = rows.find(([name]) => name === sessionName);
  if (base && base[1] === sessionName) return 0; // the session is in that group: its views are live
  return closeViews(rows, sessionName, sessionName);
}

function listSessionsFor(sessionName, failures) {
  try { return listSessionGroups(); } catch (e) {
    if (!isGone(e)) console.warn(`[tmux] could not list sessions to release the views of ${sessionName}: ${tmuxError(e)}`);
    noteFailure(failures, 'list-sessions', e);
    return null;
  }
}

function closeViews(rows, group, sessionName, failures) {
  let n = 0;
  for (const [name, g] of rows) {
    if (name === sessionName || g !== group || !name.startsWith('view-')) continue;
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      n++;
    } catch (e) {
      if (!isGone(e)) console.warn(`[tmux] could not close view ${name} of ${sessionName}: ${tmuxError(e)}`);
      noteFailure(failures, `kill-session ${name}`, e);
    }
  }
  return n;
}

/**
 * Close a session and the views grouped with it. Crash-safe whatever is
 * grouped, because it only ever uses kill-session.
 *
 * Views are released both before and after: before, so the hub's terminals
 * detach; after, for a view that attached in between or that the first pass
 * could not list, which would otherwise keep the windows alive with nobody
 * watching.
 */
function closeSession(sessionName, failures) {
  if (!sessionName) return;
  releaseGroupedViews(sessionName, failures);
  try {
    execFileSync('tmux', ['kill-session', '-t', `=${sessionName}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    if (!isGone(e)) console.warn(`[tmux] could not close session ${sessionName}: ${tmuxError(e)}`);
    noteFailure(failures, `kill-session ${sessionName}`, e);
  }
  releaseGroupedViews(sessionName, failures);
}

/**
 * Kill one window, never by kill-window on its session's last one (see above).
 *
 * `target` is `session:window`, the window by index or by exact name. It is
 * matched here rather than by tmux, whose -t falls back to a prefix match: once
 * `qa-validate` is gone, `wf-1:qa-validate` would kill `qa-validate-r2`.
 *
 * Fails closed. If tmux does not answer the listing, nothing is killed and a
 * warning is logged: a window left open costs one idle shell until the session
 * is closed, while guessing wrong costs every session on the machine.
 *
 * @param {string[]} [failures] collects every failed tmux call (see noteFailure)
 * @returns {boolean} whether the window is gone because of this call
 */
function killWindowSafely(target, failures) {
  if (!target) return false;
  const str = String(target);
  const colon = str.indexOf(':');
  if (colon < 1) return false;
  const sessionName = str.slice(0, colon);
  const windowRef = str.slice(colon + 1);
  let windows;
  try {
    windows = execFileSync('tmux', ['list-windows', '-t', `=${sessionName}`, '-F', '#{window_id}\t#{window_index}\t#{window_name}'], { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().split('\n').filter(Boolean).map((l) => l.split('\t'));
  } catch (e) {
    if (e && e.code === 'ETIMEDOUT') {
      console.warn(`[tmux] not killing ${str}: tmux did not answer within ${TMUX_TIMEOUT_MS}ms, so it cannot be told whether this is the session's last window`);
    } else if (!isGone(e)) {
      console.warn(`[tmux] not killing ${str}: could not list its session's windows: ${tmuxError(e)}`);
    }
    noteFailure(failures, `list-windows ${sessionName}`, e);
    return false;                                // session gone, or tmux not answering
  }
  const hit = windows.find(([, index]) => index === windowRef) || windows.find(([, , name]) => name === windowRef);
  if (!hit) {
    if (failures) failures.push(`list-windows ${sessionName}: no window ${windowRef}`);
    return false;                                // that window is gone already
  }
  if (windows.length > 1) {
    try {
      execFileSync('tmux', ['kill-window', '-t', hit[0]], { stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch (e) {
      if (!isGone(e)) console.warn(`[tmux] could not kill ${str}: ${tmuxError(e)}`);
      noteFailure(failures, `kill-window ${hit[0]}`, e);
      return false;
    }
  }
  closeSession(sessionName, failures);
  return true;
}

function createTmuxOps(config) {
  const projectName = config.name;

  function generateSessionName(prefix) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${prefix || projectName}-${timestamp}`;
  }

  function hasSession(sessionName) {
    try {
      execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
      return true;
    } catch (_) { return false; }
  }

  /**
   * tmux's id for the session named exactly `sessionName` (`$12`), or null when
   * there is none. Unlike a name, an id is never reused while the server runs,
   * so it tells a relaunched session apart from the one it replaced. Throws
   * when tmux does not answer, which is not the same as "no such session".
   * display-message takes a PANE target, where a bare `=name` resolves to
   * nothing and prints an empty line instead of failing; the trailing colon
   * makes it name the session.
   */
  function sessionId(sessionName) {
    try {
      return execFileSync('tmux', ['display-message', '-p', '-t', `=${sessionName}:`, '#{session_id}'], { stdio: ['pipe', 'pipe', 'pipe'] })
        .toString().trim() || null;
    } catch (e) {
      if (e && e.code === 'ETIMEDOUT') throw e;
      return null;
    }
  }

  function createSession(sessionName, windowName, cwd) {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-n', windowName, '-x', '220', '-y', '50'], { cwd });
  }

  /**
   * Put a window into a session, creating the session when it isn't there.
   *
   * The session can disappear BETWEEN the check and the call, so this cannot be
   * a plain `hasSession() ? createWindow : createSession`. Reaping an agent's
   * window when its feedback lands ends the session if it was the last window,
   * and tmux tears the server down asynchronously — so a step launched in the
   * same request as the reap can find the server gone a moment after seeing it
   * alive. That is exactly what happened on launch-studio (2026-08-01): the fix
   * planner reported, its window was reaped, and the fix_execution launch that
   * followed died on `no server running`, leaving the step half-started.
   *
   * @returns {string} the tmux target for the new window
   */
  function ensureWindow(sessionName, windowName, cwd) {
    if (!hasSession(sessionName)) {
      // A new session by this name would be pulled into any group of the same
      // name the moment the hub views it (see releaseOrphanViews).
      releaseOrphanViews(sessionName);
      createSession(sessionName, windowName, cwd);
      return `${sessionName}:${windowName}`;
    }
    try {
      return `${sessionName}:${createWindow(sessionName, windowName, cwd)}`;
    } catch (e) {
      // Only swallow the race — a failure with the session still standing is a
      // real error and must surface.
      if (hasSession(sessionName)) throw e;
      releaseOrphanViews(sessionName);
      createSession(sessionName, windowName, cwd);
      return `${sessionName}:${windowName}`;
    }
  }

  /**
   * Add a window, first closing any window of the same name.
   *
   * Throws rather than open a second window beside one it could not close. A
   * duplicate runs a second agent, and the hub's terminal shows whichever
   * window tmux finds first: twice on 2026-10-23 that was the finished draft's
   * bare shell, while the new draft ran unseen beside it.
   */
  function createWindow(sessionName, windowName, cwd) {
    // Defensive deduplication — tmux happily allows duplicate window names
    // in a single session, but `capture-pane -t session:name` then returns
    // "can't find window" because the name lookup is ambiguous. Observed on
    // example-ios fix_execution relaunch (2026-05-26): the Log button rendered
    // empty for 30+ minutes while two Claude sessions were burning tokens
    // on the same task in two windows both named `fix-mono-ios`. Kill any
    // existing window with this name before creating. The loop handles the
    // case where multiple duplicates already exist (one kill-window only
    // removes one of N at a time when names collide).
    let dup = null;
    const failures = [];
    for (let attempts = 0; attempts <= 5; attempts++) {
      let names = [];
      try {
        const out = execFileSync('tmux', ['list-windows', '-t', `=${sessionName}`, '-F', '#{window_index} #{window_name}'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        names = out.split('\n').filter(Boolean).map(l => {
          const sp = l.indexOf(' ');
          return [l.slice(0, sp), l.slice(sp + 1)];
        });
      } catch (e) {
        // Closing the last window closes the session; new-window then fails
        // and ensureWindow starts the session afresh.
        if (isGone(e)) { dup = null; break; }
        throw new Error(`could not check ${sessionName} for an earlier "${windowName}" window: ${tmuxError(e)}`);
      }
      dup = names.find(([, n]) => n === windowName);
      if (!dup || attempts === 5) break;
      killWindowSafely(`${sessionName}:${dup[0]}`, failures);
    }
    if (dup) {
      // The window is still listed, so an "already gone" answer above was
      // wrong, and it was not logged. Say here what tmux answered.
      const why = failures.length
        ? `tmux answered: ${[...new Set(failures)].join('; ')}`
        : 'tmux reported it closed, but it is still there';
      console.warn(`[tmux] could not close the earlier "${windowName}" window in ${sessionName}: ${why}`);
      throw new Error(`the earlier "${windowName}" window in ${sessionName} could not be closed (${why}), so no second one was opened beside it`);
    }
    const out = execFileSync('tmux', ['new-window', '-t', `${sessionName}:`, '-n', windowName, '-P', '-F', '#{window_index}'], { cwd });
    return out.toString().trim();
  }

  function sendKeys(target, command, cwd) {
    execFileSync('tmux', ['send-keys', '-t', target, command, 'Enter'], { cwd });
  }

  function pipePaneToLog(target, logFile, cwd) {
    try {
      execFileSync('tmux', ['pipe-pane', '-t', target, '-o', `cat >> '${logFile}'`], { cwd });
    } catch (_) {}
  }

  function killSession(sessionName) {
    closeSession(sessionName);
  }

  // Kill a tmux window AND any processes it spawned that are still holding a port.
  // tmux kill-window only kills the shell; child processes (vite, node, tsx) survive
  // and keep the port bound, preventing the next server from starting.
  function killWindowAndChildren(target, port) {
    if (port) {
      try {
        const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
        const pids = (result.stdout || '').trim();
        if (pids) {
          pids.split('\n').filter(Boolean).forEach(pid => {
            try { process.kill(parseInt(pid), 'SIGTERM'); } catch (_) {}
          });
        }
      } catch (_) {}
    }
    if (target) killWindowSafely(target);
  }

  // Kill all processes holding the given ports, then kill the tmux session.
  // Use instead of killSession() when dev servers were started in the session.
  function killSessionAndDevPorts(sessionName, devServerPorts) {
    const ports = Object.values(devServerPorts || {});
    for (const port of ports) {
      try {
        const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
        const pids = (result.stdout || '').trim();
        if (pids) {
          pids.split('\n').filter(Boolean).forEach(pid => {
            try { process.kill(parseInt(pid), 'SIGTERM'); } catch (_) {}
          });
        }
      } catch (_) {}
    }
    closeSession(sessionName);
  }

  function capturePane(target, lines = 80) {
    // First try: direct capture by target (either "session:name" or "session:index").
    try {
      return execFileSync('tmux', ['capture-pane', '-p', '-t', target, '-S', `-${lines}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (_) {}
    // Fallback: target looks like "session:name" and the name was ambiguous
    // (duplicate windows) — resolve to a concrete window index and retry.
    // Belt-and-suspenders for createWindow's dedup logic.
    const m = target.match(/^([^:]+):(.+)$/);
    if (!m) return '';
    const [, sess, nameOrIdx] = m;
    if (/^\d+$/.test(nameOrIdx)) return ''; // already an index — fail for other reasons
    try {
      const list = execFileSync('tmux', ['list-windows', '-t', sess, '-F', '#{window_index} #{window_name}'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const matches = list.split('\n').filter(Boolean).map(l => {
        const sp = l.indexOf(' ');
        return [l.slice(0, sp), l.slice(sp + 1)];
      }).filter(([, n]) => n === nameOrIdx);
      if (matches.length === 0) return '';
      // If multiple match, prefer the active one if present, else the last (most recent).
      const idx = matches[matches.length - 1][0];
      return execFileSync('tmux', ['capture-pane', '-p', '-t', `${sess}:${idx}`, '-S', `-${lines}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (_) { return ''; }
  }

  // The foreground command of a window's pane (#{pane_current_command}) —
  // the agent-recovery discriminator: a live agent shows its CLI binary
  // (claude/codex/node); a dead one has fallen back to the login shell.
  // Returns null when the window/pane cannot be found.
  function paneCommand(target) {
    try {
      const out = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_current_command}'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      return out || null;
    } catch (_) {}
    // Same ambiguous-name fallback as capturePane: resolve "session:name" to a
    // concrete index when duplicate window names confuse the direct lookup.
    const m = target.match(/^([^:]+):(.+)$/);
    if (!m) return null;
    const [, sess, nameOrIdx] = m;
    if (/^\d+$/.test(nameOrIdx)) return null;
    try {
      const list = execFileSync('tmux', ['list-windows', '-t', sess, '-F', '#{window_index} #{window_name}'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const matches = list.split('\n').filter(Boolean).map(l => {
        const sp = l.indexOf(' ');
        return [l.slice(0, sp), l.slice(sp + 1)];
      }).filter(([, n]) => n === nameOrIdx);
      if (matches.length === 0) return null;
      const idx = matches[matches.length - 1][0];
      const out = execFileSync('tmux', ['display-message', '-p', '-t', `${sess}:${idx}`, '#{pane_current_command}'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      return out || null;
    } catch (_) { return null; }
  }

  // PID of the process tmux launched in this pane — used by agent-recovery to
  // check for a live descendant (e.g. a still-compiling xcodebuild/test run)
  // before declaring an agent dead purely from an idle log + shell-looking
  // pane command (fazon FAZ-186 QA validation, 2026-07-21: a long foreground
  // `xcodebuild ... | tee` left the pane idle and shell-attributed for 2+
  // minutes while the agent was very much alive; the watchdog force-injected
  // its resume script into a live session).
  function panePid(target) {
    try {
      const out = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      return out ? parseInt(out, 10) : null;
    } catch (_) { return null; }
  }

  // Visible rows of this pane. A hub viewer sizes the agent's window (window-size
  // latest), so a squeezed viewer can leave a pane one row tall, too short to
  // show a dialog. Returns null when the pane cannot be found.
  function paneHeight(target) {
    try {
      const out = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_height}'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      const rows = parseInt(out, 10);
      return Number.isFinite(rows) ? rows : null;
    } catch (_) { return null; }
  }

  // True if `pid` has any live direct child process. A pane that fell back to
  // a bare login shell after a genuine crash has none — nothing left to run.
  // A pane legitimately mid-build (xcodebuild, npm test, gradlew, ...) still
  // has a live child even while it looks idle/shell-attributed by the other
  // two signals.
  function hasLiveDescendant(pid) {
    if (!pid) return false;
    try {
      const out = execFileSync('ps', ['-eo', 'pid,ppid'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      for (const line of out.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const ppid = parseInt(parts[1], 10);
        if (ppid === pid) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  /**
   * Send bare key names (Enter, Escape, Down…) with no text.
   *
   * Distinct from sendKeys, which sends a COMMAND and appends Enter — right for
   * a shell prompt, wrong for a TUI chooser, where the text lands nowhere and
   * the appended Enter confirms whatever was highlighted.
   */
  function sendKeysRaw(target, ...keys) {
    execFileSync('tmux', ['send-keys', '-t', target, ...keys]);
  }

  function sendMessage(target, message) {
    execFileSync('tmux', ['set-buffer', '-b', 'agent-msg', message]);
    execFileSync('tmux', ['paste-buffer', '-t', target, '-b', 'agent-msg']);
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
  }

  /**
   * Drop a pane's scrollback. The limit watchdog reads the last 200 lines of a
   * pane for a usage-limit notice, so a notice left from before a relaunch would
   * keep a running agent looking blocked.
   */
  function clearHistory(target) {
    try { execFileSync('tmux', ['clear-history', '-t', target], { stdio: 'ignore' }); } catch (_) { /* window gone */ }
  }

  function openTerminal(sessionName) {
    const osa = `tell application "Terminal"\n  do script "tmux attach-session -t ${sessionName}"\n  activate\nend tell`;
    try { execFileSync('osascript', ['-'], { input: osa }); } catch (_) {}
  }

  return {
    generateSessionName,
    hasSession,
    sessionId,
    createSession,
    createWindow,
    ensureWindow,
    sendKeys,
    sendKeysRaw,
    pipePaneToLog,
    killSession,
    killWindowAndChildren,
    killSessionAndDevPorts,
    capturePane,
    paneCommand,
    panePid,
    paneHeight,
    hasLiveDescendant,
    sendMessage,
    clearHistory,
    openTerminal,
  };
}

/**
 * Render a `pipe-pane` log file into readable lines.
 *
 * NOT the same problem as stripAnsi(). `capture-pane` hands back a terminal
 * that tmux has already rendered — rows separated by \n, spacing materialised.
 * A pipe-pane FILE is the raw byte stream the terminal received: a TUI moves
 * the cursor instead of emitting newlines, so a 52 KB log can contain **two**
 * \n characters. Splitting it on \n therefore yields ~3 "lines", i.e. the whole
 * file as one run-together blob — which is what a reader sees as "confusing",
 * and why every agent's log looks alike (they share the same banner and prompt
 * preamble, and nothing after it is delimited).
 *
 * Two rules recover it:
 *  - split on \r as well as \n — \r is the line break in this stream;
 *  - turn cursor-column / cursor-forward escapes (CSI n G, CSI n C) into a
 *    space BEFORE stripping, because in a TUI those carry the horizontal
 *    spacing that would otherwise be lost, running words together.
 *
 * Unicode is preserved (stripAnsi drops it): the agent UI is full of box
 * drawing and section marks that carry meaning here.
 */
const SPINNER_GLYPHS = /[\u2732\u273B\u2736\u2733\u2722\u00B7\u23FA\u25D0\u25D3\u25D1\u25D2\u2026]/g;

function renderPipePaneLog(str) {
  // ECMA-48 CSI is `ESC [`, parameter bytes 0x30-0x3F (which include < = > ?),
  // intermediate bytes 0x20-0x2F (which include $), then a final 0x40-0x7E.
  // A narrower `[0-9;?]*[a-zA-Z]` misses everything a modern terminal
  // negotiates — `ESC[>1u`, `ESC[>4;2m`, `ESC[?2026$p`, `ESC[<u` — which then
  // survives into the rendered log as leading garbage. Two-character escapes
  // (ESC 7 / ESC 8 save+restore cursor) need their own pass for the same reason.
  return String(str || '')
    .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[GC]/g, ' ')
    .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[78=>MDEHc]/g, '')
    .split(/[\r\n]+/)
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim())
    // Drop spinner frames. The CLI animates a status line in place, so every
    // repaint becomes its own \r-delimited "line" — on a real review log that
    // was 462 of 839 lines, and because the status text is drawn with cursor
    // moves the fragments come out as vertical slices ("✽ u n" / " r i").
    // Deliberately narrow: a line goes only if it is nothing but spinner glyphs,
    // or a glyph plus a 1-3 character slice. Real short lines (" IDs.",
    // "- [ ] (none)") are longer than that and survive.
    .filter((l) => {
      if (l.replace(SPINNER_GLYPHS, '').trim() === '') return false;   // glyphs only
      // A vertical slice is a run of SINGLE-character tokens ("✶ P u 7"): the
      // status text is drawn column by column, so splitting on \r cuts it into
      // one-char columns. Real lines always carry at least one multi-char word
      // (" IDs.", "- [ ] (none)"), so they are untouched.
      const tok = l.trim().split(/\s+/);
      return !(tok.length <= 6 && tok.every((t) => t.length === 1));
    })
    .join('\n');
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
    .split('\n').filter(l => l.trim()).join('\n');
}

module.exports = {
  renderPipePaneLog, createTmuxOps, stripAnsi, releaseGroupedViews, releaseOrphanViews, closeSession, killWindowSafely };
