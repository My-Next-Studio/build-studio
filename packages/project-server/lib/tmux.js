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
 * Upstream's fix ("grouped sessions sometimes being left as unusable command
 * targets while they are being killed", issue 5180) is listed for 3.8.
 *
 * Build Studio creates exactly that shape: the hub terminal attaches through a
 * `view-*` session grouped with the agent's session (server.js openAgentPty),
 * and that view lives as long as the agent window does. So before anything that
 * can destroy a session — killing its last window, or the session itself —
 * remove the view sessions grouped with it. The base session is then alone,
 * and destroying it never enters the group path. Killing a view only detaches
 * the hub's terminal for a window that is about to disappear anyway.
 */
function releaseGroupedViews(sessionName) {
  if (!sessionName) return 0;
  let rows = [];
  try {
    rows = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_group}'], { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().split('\n').filter(Boolean).map((l) => l.split('\t'));
  } catch (_) { return 0; }
  const base = rows.find(([name]) => name === sessionName);
  if (!base || !base[1]) return 0;               // not grouped: nothing to do
  const group = base[1];
  let n = 0;
  for (const [name, g] of rows) {
    if (name === sessionName || g !== group || !name.startsWith('view-')) continue;
    try { execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }); n++; } catch (_) {}
  }
  return n;
}

/** Kill one window without ever destroying a still-grouped session (see above). */
function killWindowSafely(target) {
  if (!target) return;
  const sessionName = String(target).split(':')[0];
  let windows = 0;
  try {
    windows = execFileSync('tmux', ['list-windows', '-t', `=${sessionName}`, '-F', '#{window_index}'], { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().split('\n').filter(Boolean).length;
  } catch (_) { /* session gone already */ }
  if (windows <= 1) releaseGroupedViews(sessionName);
  try { execFileSync('tmux', ['kill-window', '-t', target], { stdio: 'ignore' }); } catch (_) {}
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
      createSession(sessionName, windowName, cwd);
      return `${sessionName}:${windowName}`;
    }
    try {
      return `${sessionName}:${createWindow(sessionName, windowName, cwd)}`;
    } catch (e) {
      // Only swallow the race — a failure with the session still standing is a
      // real error and must surface.
      if (hasSession(sessionName)) throw e;
      createSession(sessionName, windowName, cwd);
      return `${sessionName}:${windowName}`;
    }
  }

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
    for (let attempts = 0; attempts < 5; attempts++) {
      let names = [];
      try {
        const out = execFileSync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index} #{window_name}'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        names = out.split('\n').filter(Boolean).map(l => {
          const sp = l.indexOf(' ');
          return [l.slice(0, sp), l.slice(sp + 1)];
        });
      } catch (_) { break; }
      const dup = names.find(([, n]) => n === windowName);
      if (!dup) break;
      killWindowSafely(`${sessionName}:${dup[0]}`);
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
    releaseGroupedViews(sessionName);
    try { execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' }); } catch (_) {}
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
    releaseGroupedViews(sessionName);
    try { execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' }); } catch (_) {}
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

  function openTerminal(sessionName) {
    const osa = `tell application "Terminal"\n  do script "tmux attach-session -t ${sessionName}"\n  activate\nend tell`;
    try { execFileSync('osascript', ['-'], { input: osa }); } catch (_) {}
  }

  return {
    generateSessionName,
    hasSession,
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
    hasLiveDescendant,
    sendMessage,
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
  renderPipePaneLog, createTmuxOps, stripAnsi, releaseGroupedViews, killWindowSafely };
