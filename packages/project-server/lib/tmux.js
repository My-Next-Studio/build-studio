const { execSync, execFileSync, spawnSync } = require('child_process');

// Note: Uses execSync for tmux shell commands, matching the existing example-web
// codebase patterns. All inputs are from project config (not user input).

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
      try { execFileSync('tmux', ['kill-window', '-t', `${sessionName}:${dup[0]}`], { stdio: 'ignore' }); } catch (_) { break; }
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
    if (target) {
      try { execFileSync('tmux', ['kill-window', '-t', target], { stdio: 'ignore' }); } catch (_) {}
    }
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

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
    .split('\n').filter(l => l.trim()).join('\n');
}

module.exports = { createTmuxOps, stripAnsi };
