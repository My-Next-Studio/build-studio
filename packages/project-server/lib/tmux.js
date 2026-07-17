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
    sendKeys,
    pipePaneToLog,
    killSession,
    killWindowAndChildren,
    killSessionAndDevPorts,
    capturePane,
    paneCommand,
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
