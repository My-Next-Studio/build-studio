'use strict';

/**
 * Make sure a project ignores a runtime file BEFORE the first write to it.
 *
 * Onboarding writes Build Studio's ignore patterns, but only when a project is
 * onboarded — a feature added later leaves every existing project without its
 * rule, and the first run leaves an untracked state file for the next sweep-all
 * commit to pick up. That happened with the drafting state in two projects.
 *
 * Adds ONE line, never the whole pattern list: rewriting a project's .gitignore
 * wholesale as a side effect of using a feature would be a surprise.
 *
 * @returns {boolean} true when the file changed and so needs committing — a
 *   modified .gitignore on the default branch blocks the next execution run.
 */

const fs = require('fs');
const path = require('path');

function ensureIgnoreRule(projectRoot, rule) {
  const gi = path.join(projectRoot, '.gitignore');
  let existing = '';
  try { existing = fs.readFileSync(gi, 'utf8'); } catch (_) { /* no file yet */ }
  if (existing.split('\n').some((l) => l.trim() === rule)) return false;
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gi, `${existing}${sep}${rule}\n`, 'utf8');
  return true;
}

module.exports = { ensureIgnoreRule };
