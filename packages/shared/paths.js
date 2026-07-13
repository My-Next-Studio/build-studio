const os = require('os');
const path = require('path');

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Shells do this before a CLI ever sees the argument, but paths typed into
 * the hub UI (New Project / Onboard dialogs) arrive verbatim — without
 * expansion, `~/projects/x` resolves relative to the server's cwd and
 * creates a literal `~` directory there.
 */
function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** expandTilde + resolve to an absolute path in one step. */
function resolveUserPath(p) {
  return path.resolve(expandTilde(p));
}

module.exports = { expandTilde, resolveUserPath };
