const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { assertInside } = require('../path-guard');

// Directories no request may read from or write to, matched per path SEGMENT.
//
// The segment part matters: the older check here was /^(\.git|node_modules|...)/
// against the relative path, which is a plain prefix test. That both over-blocks
// (`.github/` starts with `.git`) and under-blocks (it only ever looks at the
// first segment, so `docs/.git/config` sailed past). Comparing segments is both
// stricter and more accurate.
const BLOCKED_SEGMENTS = new Set([
  '.git',          // hooks are executable; config controls where pushes go
  '.github',       // workflow files run in CI
  '.claude',       // agent command files — writing these steers future agents
  '.build-studio', // project config, including ports and model selection
  'node_modules',
  'dist',
  '.next',
]);

/** True when any segment of `relPath` is a blocked directory (or a .env file). */
function hitsBlockedPath(relPath) {
  return relPath.split(path.sep).some(
    (seg) => BLOCKED_SEGMENTS.has(seg) || seg === '.env' || seg.startsWith('.env.')
  );
}

function createFilesRouter(config, broadcast) {
  const router = express.Router();
  const { docsPath, projectRoot } = config;

  if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });

  const watcher = chokidar.watch(docsPath, { ignoreInitial: true, persistent: true, depth: 3 });
  watcher.on('all', (event, filePath) => {
    const rel = path.relative(docsPath, filePath);
    broadcast('change', { event, path: rel });
  });

  function walkMd(dir, base) {
    base = base || dir;
    const result = [];
    if (!fs.existsSync(dir)) return result;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...walkMd(full, base));
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        result.push({ path: path.relative(base, full), mtime: fs.statSync(full).mtimeMs });
      }
    }
    return result;
  }

  router.get('/files', (req, res) => {
    try { res.json({ files: walkMd(docsPath) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/file', (req, res) => {
    const relPath = req.query.path;
    if (!relPath) return res.status(400).json({ error: 'path required' });

    // First try docsPath-relative resolution (legacy callers — Spec tab + the
    // PRD viewer for docs/-prefixed paths).
    //
    // Escaping docs/ is not an error at this step, it just means "not a docs
    // file" — the projectRoot branch below is where docs/-external companion
    // specs legitimately resolve. Only a path escaping BOTH bases is refused,
    // which is why this catch falls through instead of responding.
    let docsAbs = null;
    try { docsAbs = assertInside(relPath, docsPath); } catch { /* try projectRoot */ }
    // The blocklist applies here too. docs/ being the intended-readable tree is
    // an argument about its .md files, not about a nested .git or a stray .env
    // that happens to sit inside it.
    if (docsAbs && hitsBlockedPath(path.relative(docsPath, docsAbs))) docsAbs = null;
    if (docsAbs && fs.existsSync(docsAbs) && fs.statSync(docsAbs).isFile()) {
      const content = fs.readFileSync(docsAbs, 'utf8');
      return res.json({ path: relPath, content, mtime: fs.statSync(docsAbs).mtimeMs });
    }

    // Fall back to projectRoot-relative for files outside docs/ — PRD
    // companion-spec tables can reference text files anywhere in the repo
    // (e.g. `ios/ExampleApp/Resources/Fonts/PROVENANCE.md`). Restrict to text
    // extensions; block sensitive directories.
    let projAbs;
    try { projAbs = assertInside(relPath, projectRoot); }
    catch { return res.status(403).json({ error: 'forbidden' }); }
    const projRel = path.relative(projectRoot, projAbs);
    if (hitsBlockedPath(projRel)) {
      return res.status(403).json({ error: 'forbidden directory' });
    }
    if (!/\.(md|markdown|txt)$/i.test(projAbs)) {
      return res.status(403).json({ error: 'unsupported file type — only .md / .txt readable outside docs/' });
    }
    if (!fs.existsSync(projAbs) || !fs.statSync(projAbs).isFile()) {
      return res.status(404).json({ error: 'not found' });
    }
    const content = fs.readFileSync(projAbs, 'utf8');
    res.json({ path: relPath, content, mtime: fs.statSync(projAbs).mtimeMs });
  });

  // The write path is guarded harder than the read path, because the two fail
  // differently: a bad read leaks a file, a bad write hands over the machine.
  // Until now this route checked only that the path was under projectRoot, and
  // carried none of the directory or extension limits the GET path had — so
  // writing `.git/hooks/pre-commit` was allowed by the guard working as
  // designed, and ran as you on the repo's next commit.
  router.put('/file', (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    let absPath;
    try { absPath = assertInside(filePath, projectRoot); }
    catch { return res.status(403).json({ error: 'path outside project' }); }
    const rel = path.relative(projectRoot, absPath);
    if (hitsBlockedPath(rel)) {
      return res.status(403).json({ error: 'forbidden directory' });
    }
    // Text only. This endpoint exists to save documents, and every extension it
    // refuses is one someone else's toolchain would eventually execute.
    if (!/\.(md|markdown|txt)$/i.test(absPath)) {
      return res.status(403).json({ error: 'unsupported file type — only .md / .txt writable' });
    }
    fs.writeFileSync(absPath, content, 'utf8');
    broadcast('change', { event: 'change', path: path.relative(docsPath, absPath) });
    res.json({ ok: true });
  });

  return { router, watcher };
}

module.exports = { createFilesRouter };
