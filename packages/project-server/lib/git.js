const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { gitMergeNoFf } = require('./git-merge');

// Commands carrying an interpolated value go through `execGit` (argv form, no
// shell). `exec` — the shell form — is kept only for fixed command strings.
// The old note here claimed all inputs came from project config; branch names
// actually come from workflow state and backlog item ids, so a name containing
// `;` or `$(…)` was command execution.

/**
 * Parse `git status --porcelain` into counts and path lists.
 *
 * The subtlety, and the reason this is a named function with tests rather than
 * four lines inline: **the format is columnar.** Each line is `XY <path>`, X
 * being the index status and Y the worktree status, so a leading space is DATA
 * — " M docs/a.md" means "modified, not staged" — and the path always begins at
 * column 3.
 *
 * That made it quietly incompatible with a `.trim()` applied to the whole
 * command output, which is right for every other read in this file (a branch
 * name, a rev count) and wrong here. Trimming stripped the leading space from
 * the FIRST line only, so exactly one file per status listing came out
 * misparsed: " M docs/a.md" became "M docs/a.md", which then read as
 * index-status 'M' — filed under STAGED rather than modified — and
 * `slice(3)` ate its first letter, displaying "ocs/a.md". Hence a staged box
 * showing "2e" for "e2e" and "ocs" for "docs", and only ever one row at a time.
 *
 * @param {string} output  raw, UNTRIMMED stdout
 * @returns {object|null}  null when the tree is clean
 */
function parsePorcelain(output) {
  // Only blank lines are dropped. A line of spaces is not valid porcelain, and
  // dropping it here beats letting it through as a phantom staged file — which
  // is what a trailing newline would otherwise produce, since `undefined !== ' '`.
  const lines = String(output || '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  // Renames arrive as "R  old -> new"; the new path is the one that exists.
  const pathOf = (l) => {
    const raw = l.slice(3);
    const arrow = raw.indexOf(' -> ');
    return arrow !== -1 ? raw.slice(arrow + 4) : raw;
  };
  const stagedLines = lines.filter((l) => l[0] !== ' ' && l[0] !== '?');
  const unstagedLines = lines.filter((l) => l[1] === 'M' || l[1] === 'D');
  const untrackedLines = lines.filter((l) => l.startsWith('??'));

  return {
    staged: stagedLines.length,
    unstaged: unstagedLines.length,
    untracked: untrackedLines.length,
    stagedFiles: stagedLines.map(pathOf),
    unstagedFiles: unstagedLines.map(pathOf),
    untrackedFiles: untrackedLines.map(pathOf),
  };
}

function createGitOps(config) {
  const { projectRoot, worktreesPath } = config;

  /**
   * Run git with an ARGUMENT LIST — no shell, so no interpolation to escape.
   *
   * Every value these commands take is attacker-adjacent in the sense that
   * matters here: branch names come from workflow state and item ids, and a
   * name containing `;` or `$(…)` in a shell string is command execution. The
   * quoting in the old call sites was also inconsistent — `git rev-list --count
   * ${base}..${branch}` interpolated both unquoted.
   *
   * Prefer this for anything with an interpolated value. `exec` (shell form)
   * remains for fixed command strings only.
   */
  function execGit(args, opts = {}) {
    const { trim = true, ...execOpts } = opts;
    const out = execFileSync('git', args, {
      cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', ...execOpts,
    });
    return trim ? String(out).trim() : String(out);
  }

  function exec(cmd, opts = {}) {
    // `trim` is ours, not execSync's — pull it out before spreading the rest.
    // Trimming is right for the single-value reads that dominate here (a branch
    // name, a rev count), and WRONG for anything columnar. See parsePorcelain.
    const { trim = true, ...execOpts } = opts;
    const out = execSync(cmd, { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], ...execOpts }).toString();
    return trim ? out.trim() : out;
  }

  return {
    createWorktree(branch) {
      const wtPath = path.join(worktreesPath, branch);
      if (fs.existsSync(wtPath)) return wtPath;
      fs.mkdirSync(worktreesPath, { recursive: true });
      try {
        execGit(['worktree', 'add', wtPath, '-b', branch]);
      } catch (_) {
        execGit(['worktree', 'add', wtPath, branch]);
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
      try { execGit(['worktree', 'remove', wtPath, '--force']); } catch (_) {}
      try { execGit(['branch', '-D', branch]); } catch (_) {}
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
      try { execGit(['rev-parse', '--verify', branch]); return true; } catch (_) { return false; }
    },

    commitsAhead(branch, base = 'main') {
      try { return parseInt(execGit(['rev-list', '--count', `${base}..${branch}`])) || 0; } catch (_) { return 0; }
    },

    lastCommit(branch, base = 'main') {
      try { return execGit(['log', '--oneline', '-1', `${base}..${branch}`]); } catch (_) { return ''; }
    },

    deleteBranch(branch, force = false) {
      try { execGit(['branch', force ? '-D' : '-d', branch]); } catch (_) {}
    },

    // Async: a project's pre-merge-commit hook runs inside the merge and can
    // take minutes (see git-merge.js). Callers must await it.
    mergeBranch(branch, cwd, message) {
      return gitMergeNoFf(cwd, branch, message);
    },

    abortMerge(cwd) {
      try { execSync('git merge --abort', { cwd, stdio: 'ignore' }); } catch (_) {}
    },

    createBranchFromMain(branch) {
      try { execGit(['branch', '-D', branch]); } catch (_) {}
      execGit(['branch', branch, 'main']);
    },

    createBranchFrom(branch, source) {
      try { execGit(['branch', '-D', branch]); } catch (_) {}
      execGit(['branch', branch, source]);
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
        // trim:false is load-bearing — see parsePorcelain.
        const parsed = parsePorcelain(exec('git status --porcelain', { trim: false }));
        if (parsed) {
          git.clean = false;
          Object.assign(git, parsed);
        }
        try { git.ahead = parseInt(execGit(['rev-list', '--count', `origin/${git.branch}..${git.branch}`])) || 0; } catch (_) {}
        try { git.behind = parseInt(execGit(['rev-list', '--count', `${git.branch}..origin/${git.branch}`])) || 0; } catch (_) {}
        try {
          const wts = exec('git worktree list --porcelain');
          git.worktrees = Math.max(0, (wts.match(/^worktree /gm) || []).length - 1);
        } catch (_) {}
      } catch (_) {}
      return git;
    },

    getRecentCommits(count = 10) {
      try { return execGit(['log', '--oneline', `-${count}`]).split('\n').filter(Boolean); } catch (_) { return []; }
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

module.exports = { createGitOps, parsePorcelain };
