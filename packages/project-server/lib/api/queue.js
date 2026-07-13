const express = require('express');
const fs = require('fs');
const path = require('path');

function createQueueRouter(config, broadcast) {
  const router = express.Router();
  const { docsPath } = config;

  function parseQueueFile() {
    const file = path.join(docsPath, 'instructions-queue.md');
    if (!fs.existsSync(file)) return [];
    const entries = [];
    let current = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^## \[([^\]]+)\] → (.+)$/);
      if (m) {
        if (current) entries.push(current);
        current = { id: m[1], timestamp: m[1], roles: m[2].split(',').map(r => r.trim()), lines: [] };
      } else if (current) current.lines.push(line);
    }
    if (current) entries.push(current);
    return entries.map(e => ({ ...e, instruction: e.lines.join('\n').trim() })).reverse();
  }

  router.post('/instructions', (req, res) => {
    const { roles, instruction } = req.body;
    if (!roles || !Array.isArray(roles) || roles.length === 0)
      return res.status(400).json({ error: 'roles array required' });
    if (!instruction || !instruction.trim())
      return res.status(400).json({ error: 'instruction text required' });
    const queueFile = path.join(docsPath, 'instructions-queue.md');
    const timestamp = new Date().toISOString();
    if (!fs.existsSync(queueFile)) fs.writeFileSync(queueFile, '# Instruction Queue\n', 'utf8');
    fs.appendFileSync(queueFile, `\n## [${timestamp}] → ${roles.join(', ')}\n${instruction.trim()}\n`, 'utf8');
    res.json({ ok: true, timestamp });
  });

  router.get('/queue', (req, res) => res.json({ entries: parseQueueFile() }));

  router.delete('/queue/:id', (req, res) => {
    const file = path.join(docsPath, 'instructions-queue.md');
    if (!fs.existsSync(file)) return res.json({ ok: true });
    const id = decodeURIComponent(req.params.id);
    const entries = parseQueueFile().filter(e => e.id !== id);
    const content = entries.slice().reverse().map(e =>
      `\n## [${e.id}] → ${e.roles.join(', ')}\n${e.instruction}\n`
    ).join('');
    fs.writeFileSync(file, '# Instruction Queue\n' + content, 'utf8');
    res.json({ ok: true });
  });

  function parseExecutionPlan() {
    const file = path.join(docsPath, 'execution-plan.md');
    if (!fs.existsSync(file)) return { content: null, config: null };
    const content = fs.readFileSync(file, 'utf8');
    const m = content.match(/## Execution Config[\s\S]*?```json\n([\s\S]*?)\n```/);
    let cfg = null;
    if (m) try { cfg = JSON.parse(m[1]); } catch (_) {}
    return { content, config: cfg };
  }

  router.get('/execution-plan', (req, res) => res.json(parseExecutionPlan()));

  router.post('/execution-plan', (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const file = path.join(docsPath, 'execution-plan.md');
    fs.writeFileSync(file, content, 'utf8');
    broadcast('change', { event: 'change', path: 'execution-plan.md' });
    res.json({ ok: true });
  });

  router.delete('/execution-plan', (req, res) => {
    const file = path.join(docsPath, 'execution-plan.md');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    broadcast('change', { event: 'change', path: 'execution-plan.md' });
    res.json({ ok: true });
  });

  return { router, parseExecutionPlan };
}

module.exports = { createQueueRouter };
