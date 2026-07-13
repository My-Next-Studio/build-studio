const express = require('express');
const fs = require('fs');
const path = require('path');

function createRunbooksRouter(config) {
  const router = express.Router();
  const runbooksDir = path.join(config.projectRoot, 'docs', 'runbooks');

  router.get('/runbooks', (req, res) => {
    if (!fs.existsSync(runbooksDir)) return res.json({ runbooks: [] });
    try {
      const files = fs.readdirSync(runbooksDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const abs = path.join(runbooksDir, f);
          const content = fs.readFileSync(abs, 'utf8');
          // Extract title from first markdown heading
          const titleMatch = content.match(/^#\s+(.+)$/m);
          return {
            filename: f,
            title: titleMatch ? titleMatch[1].trim() : f.replace('.md', ''),
            mtime: fs.statSync(abs).mtimeMs,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
      res.json({ runbooks: files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/runbook', (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const abs = path.resolve(runbooksDir, filename);
    if (!abs.startsWith(runbooksDir)) return res.status(403).json({ error: 'forbidden' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ filename, content });
  });

  return router;
}

module.exports = { createRunbooksRouter };
