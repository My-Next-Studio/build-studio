const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

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
    const docsAbs = path.resolve(docsPath, relPath);
    if (docsAbs.startsWith(docsPath) && fs.existsSync(docsAbs) && fs.statSync(docsAbs).isFile()) {
      const content = fs.readFileSync(docsAbs, 'utf8');
      return res.json({ path: relPath, content, mtime: fs.statSync(docsAbs).mtimeMs });
    }

    // Fall back to projectRoot-relative for files outside docs/ — PRD
    // companion-spec tables can reference text files anywhere in the repo
    // (e.g. `ios/ExampleApp/Resources/Fonts/PROVENANCE.md`). Restrict to text
    // extensions; block sensitive directories.
    const projAbs = path.resolve(projectRoot, relPath);
    if (!projAbs.startsWith(projectRoot)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const projRel = path.relative(projectRoot, projAbs);
    if (/^(\.git|node_modules|dist|\.next|\.env)/.test(projRel)) {
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

  router.put('/file', (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const absPath = path.resolve(projectRoot, filePath);
    if (!absPath.startsWith(projectRoot)) return res.status(403).json({ error: 'path outside project' });
    fs.writeFileSync(absPath, content, 'utf8');
    broadcast('change', { event: 'change', path: path.relative(docsPath, absPath) });
    res.json({ ok: true });
  });

  return { router, watcher };
}

module.exports = { createFilesRouter };
