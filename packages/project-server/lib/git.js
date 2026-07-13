const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// Note: This module uses execSync for git/tmux shell commands, matching the
// existing example-web codebase patterns. All inputs are from project config
// (not user input). A future improvement could migrate to execFile.

function createGitOps(config) {
  const { projectRoot, worktreesPath } = config;

  function exec(cmd, opts = {}) {
    return execSync(cmd, { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString().trim();
  }

  return {
    createWorktree(branch) {
      const wtPath = path.join(worktreesPath, branch);
      if (fs.existsSync(wtPath)) return wtPath;
      fs.mkdirSync(worktreesPath, { recursive: true });
      try {
        exec(`git worktree add "${wtPath}" -b "${branch}"`);
      } catch (_) {
        exec(`git worktree add "${wtPath}" "${branch}"`);
      }
      for (const envFile of config.worktree_env_files || []) {
        const src = path.join(projectRoot, envFile);
        const dst = path.join(wtPath, envFile);
        const dstDir = path.dirname(dst);
        if (fs.existsSync(src) && fs.existsSync(dstDir)) {
          try { fs.copyFileSync(src, dst); } catch (_) {}
        }
      }
      return wtPath;
    },

    removeWorktree(branch) {
      const wtPath = path.join(worktreesPath, branch);
      try { exec(`git worktree remove "${wtPath}" --force`); } catch (_) {}
      try { exec(`git branch -D "${branch}"`); } catch (_) {}
    },

    listWorktrees() {
      if (!fs.existsSync(worktreesPath)) return [];
      return fs.readdirSync(worktreesPath, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => {
          const wtPath = path.join(worktreesPath, e.name);
          let taskSummary = null;
          const taskFile = path.join(wtPath, 'TASK.md');
          if (fs.existsSync(taskFile)) {
            taskSummary = fs.readFileSync(taskFile, 'utf8').split('\n')[0].replace(/^#+ /, '');
          }
          let lastCommit = null;
          try {
            lastCommit = execSync('git log -1 --format=%s', { cwd: wtPath, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
          } catch (_) {}
          return { branch: e.name, taskSummary, lastCommit };
        });
    },

    branchExists(branch) {
      try { exec(`git rev-parse --verify "${branch}"`); return true; } catch (_) { return false; }
    },

    commitsAhead(branch, base = 'main') {
      try { return parseInt(exec(`git rev-list --count ${base}..${branch}`)) || 0; } catch (_) { return 0; }
    },

    lastCommit(branch, base = 'main') {
      try { return exec(`git log --oneline -1 ${base}..${branch}`); } catch (_) { return ''; }
    },

    deleteBranch(branch, force = false) {
      try { exec(`git branch ${force ? '-D' : '-d'} "${branch}"`); } catch (_) {}
    },

    mergeBranch(branch, cwd, message) {
      execSync(`git merge "${branch}" --no-ff -m "${message}"`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    },

    abortMerge(cwd) {
      try { execSync('git merge --abort', { cwd, stdio: 'ignore' }); } catch (_) {}
    },

    createBranchFromMain(branch) {
      try { exec(`git branch -D "${branch}"`); } catch (_) {}
      exec(`git branch "${branch}" main`);
    },

    createBranchFrom(branch, source) {
      try { exec(`git branch -D "${branch}"`); } catch (_) {}
      exec(`git branch "${branch}" "${source}"`);
    },

    getStatus() {
      const git = {
        branch: '', clean: true,
        staged: 0, unstaged: 0, untracked: 0,
        stagedFiles: [], unstagedFiles: [], untrackedFiles: [],
        ahead: 0, behind: 0, worktrees: 0,
      };
      try {
        git.branch = exec('git branch --show-current');
        const status = exec('git status --porcelain');
        if (status) {
          git.clean = false;
          const lines = status.split('\n');
          // Porcelain format: XY <path>  where X=index status, Y=worktree status.
          // Path starts at column 3. Renames look like "R  old -> new" — keep new.
          const pathOf = (l) => {
            const raw = l.slice(3);
            const arrow = raw.indexOf(' -> ');
            return arrow !== -1 ? raw.slice(arrow + 4) : raw;
          };
          const stagedLines = lines.filter(l => l[0] !== ' ' && l[0] !== '?');
          const unstagedLines = lines.filter(l => l[1] === 'M' || l[1] === 'D');
          const untrackedLines = lines.filter(l => l.startsWith('??'));
          git.staged = stagedLines.length;
          git.unstaged = unstagedLines.length;
          git.untracked = untrackedLines.length;
          git.stagedFiles = stagedLines.map(pathOf);
          git.unstagedFiles = unstagedLines.map(pathOf);
          git.untrackedFiles = untrackedLines.map(pathOf);
        }
        try { git.ahead = parseInt(exec(`git rev-list --count origin/${git.branch}..${git.branch}`)) || 0; } catch (_) {}
        try { git.behind = parseInt(exec(`git rev-list --count ${git.branch}..origin/${git.branch}`)) || 0; } catch (_) {}
        try {
          const wts = exec('git worktree list --porcelain');
          git.worktrees = Math.max(0, (wts.match(/^worktree /gm) || []).length - 1);
        } catch (_) {}
      } catch (_) {}
      return git;
    },

    getRecentCommits(count = 10) {
      try { return exec(`git log --oneline -${count}`).split('\n').filter(Boolean); } catch (_) { return []; }
    },

    /**
     * Return commits on HEAD since an ISO timestamp, newest first.
     * Used by the monolithic-task commit ribbon UI (PRD-001).
     * Each entry: { sha, shortSha, subject, type, isoDate, additions, deletions }
     */
    commitsSince(sinceISO, max = 50) {
      if (!sinceISO || typeof sinceISO !== 'string') return [];
      const safeMax = Math.min(Math.max(parseInt(max) || 50, 1), 200);
      function gitFile(args) {
        return execFileSync('git', args, { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      }
      try {
        const log = gitFile(['log', `--since=${sinceISO}`, '--pretty=format:%H|%cI|%s', `-${safeMax}`]).trim();
        if (!log) return [];
        const out = [];
        for (const line of log.split('\n')) {
          const [sha, isoDate, ...rest] = line.split('|');
          if (!sha) continue;
          const subject = rest.join('|');
          const m = subject.match(/^(\w+)(?:\([^)]+\))?:/);
          const type = m ? m[1] : 'other';
          let additions = 0, deletions = 0;
          try {
            const stat = gitFile(['show', '--shortstat', '--format=', sha]);
            const sm = stat.match(/(\d+)\s+insertion[^,]*(?:,\s+(\d+)\s+deletion)?/);
            if (sm) {
              additions = parseInt(sm[1]) || 0;
              deletions = parseInt(sm[2] || '0') || 0;
            }
          } catch (_) {}
          out.push({ sha, shortSha: sha.slice(0, 7), subject, type, isoDate, additions, deletions });
        }
        return out;
      } catch (_) { return []; }
    },
  };
}

module.exports = { createGitOps };
