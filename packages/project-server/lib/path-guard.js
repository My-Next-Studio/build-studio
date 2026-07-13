const path = require('path');

/**
 * Resolves `rel` against `baseDir` and throws if the result escapes the base.
 * Uses strict check: abs must equal baseDir or start with baseDir + path.sep.
 * This prevents prefix-spoofing (e.g. /foo/marketing-evil vs /foo/marketing).
 *
 * @param {string} rel  - relative path from user input (or an absolute path)
 * @param {string} baseDir - absolute, pre-resolved base directory
 * @returns {string} the resolved absolute path
 * @throws {Error} with code 'FORBIDDEN' if the path escapes baseDir
 */
function assertInside(rel, baseDir) {
  const abs = path.resolve(baseDir, rel);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) {
    const err = new Error(`Path '${rel}' resolves outside the allowed directory`);
    err.code = 'FORBIDDEN';
    throw err;
  }
  return abs;
}

module.exports = { assertInside };
