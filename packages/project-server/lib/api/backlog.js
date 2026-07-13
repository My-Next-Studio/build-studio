/**
 * Backlog API (PRD-004) — read path.
 *
 * Endpoints:
 *   GET  /api/backlog              → { groups, items }
 *                                    `groups` is the canonical order from
 *                                    project-state.md's BACKLOG section.
 *                                    `items` is { id → frontmatter+body }.
 *   GET  /api/backlog/items/:id    → single item
 *
 * Write endpoints (POST/PUT/DELETE/reorder) are deliberately deferred — this
 * router ships the read path first so the UI tab can render real data before
 * we wire up mutations.
 */
const express = require('express');
const {
  readBacklog, readItem, writeItem, isValidId, discoverCompanionSpecs,
  writeBacklogSection, listItems, applyAutoTransitionsForFeatures, parseBacklogSection,
  VALID_STATUSES,
} = require('../backlog');
const fs = require('fs');
const path = require('path');

function createBacklogRouter(config) {
  const router = express.Router();
  const docsPath = config.docs_path || './docs';

  // Hydrate every item in the map with its companion_specs list. Auto-discovery
  // by PRD-number is cheap (a few readdirs) and keeps the items' frontmatter
  // free of redundant lists — frontmatter only needs `companion_specs:` when
  // the operator wants to override the auto-discovered set.
  function hydrate(items) {
    const out = {};
    for (const [id, item] of Object.entries(items)) {
      out[id] = { ...item, companion_specs: discoverCompanionSpecs(config.projectRoot, docsPath, item) };
    }
    return out;
  }

  router.get('/backlog', (req, res) => {
    try {
      // Run the file-presence auto-transition first (Feature + Backlog + PRD
      // file exists → Drafted). If anything moved, re-render the order block
      // so the display lines pick up the new statuses immediately.
      const auto = applyAutoTransitionsForFeatures(config.projectRoot, docsPath);
      if (auto.changed) {
        // Re-parse current groups (order is unchanged) and re-render to refresh
        // the [Type · Status] suffixes in project-state.md.
        const statePath = path.join(config.projectRoot, docsPath, 'project-state.md');
        if (fs.existsSync(statePath)) {
          const content = fs.readFileSync(statePath, 'utf8');
          const groups = parseBacklogSection(content);
          if (groups.length > 0) writeBacklogSection(config.projectRoot, docsPath, groups);
        }
      }

      const { groups, items } = readBacklog(config.projectRoot, docsPath);
      res.json({ groups, items: hydrate(items), autoTransitioned: auto.transitioned });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/backlog/items/:id', (req, res) => {
    const id = req.params.id;
    if (!isValidId(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const item = readItem(config.projectRoot, docsPath, id);
      if (!item) return res.status(404).json({ error: 'not found' });
      const companion_specs = discoverCompanionSpecs(config.projectRoot, docsPath, item);
      res.json({ item: { ...item, companion_specs } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Reorder items — applies a new groups[] structure.
   *
   * Body shape:
   *   { groups: [{ release: "...", items: [id, id, ...] }, ...] }
   *
   * Behavior:
   *   1. Validate body shape + every ID is well-formed.
   *   2. For each item whose release changed compared to its file's current
   *      `release:` frontmatter, rewrite the file with the new release.
   *      Items not mentioned in any group are left untouched.
   *   3. Re-render the BACKLOG section in project-state.md from the new
   *      groups using current item titles/types/statuses.
   *
   * Failure mode: if file-update step succeeds for some items and fails for
   * one, that item's file is in the new release but project-state.md hasn't
   * been rewritten yet — the orphan-lint command will catch the divergence.
   * Single-user workflow makes this risk small; revisit with a tmp+rename
   * scheme if multi-writer scenarios appear.
   */
  router.post('/backlog/reorder', (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.groups)) {
      return res.status(400).json({ error: 'body.groups must be an array' });
    }
    for (const g of body.groups) {
      if (!g || typeof g.release !== 'string' || !Array.isArray(g.items)) {
        return res.status(400).json({ error: 'each group must be { release: string, items: string[] }' });
      }
      for (const id of g.items) {
        if (!isValidId(id)) return res.status(400).json({ error: `invalid id in group "${g.release}": ${id}` });
      }
    }

    try {
      // Map id → new release for items mentioned in the payload.
      const newReleaseById = new Map();
      for (const g of body.groups) {
        for (const id of g.items) newReleaseById.set(id, g.release);
      }

      // Update any item file whose release changed.
      const existing = listItems(config.projectRoot, docsPath);
      let updatedCount = 0;
      for (const item of existing) {
        const newRelease = newReleaseById.get(item.id);
        if (newRelease == null) continue;  // not in payload — leave untouched
        if (item.release === newRelease) continue;  // no change
        writeItem(config.projectRoot, docsPath, { ...item, release: newRelease });
        updatedCount++;
      }

      // Re-render the BACKLOG section.
      writeBacklogSection(config.projectRoot, docsPath, body.groups);

      const { groups, items } = readBacklog(config.projectRoot, docsPath);
      res.json({ groups, items: hydrate(items), updatedCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Patch an item's status. Operator-driven transitions — the workflow-driven
   * lifecycle hooks (workflow.js → advanceLinkedFeatures) handle the
   * automated path; this endpoint covers manual moves:
   *   - Implemented → Done (the operator's final-verification gate)
   *   - any → Blocked (raised when external dependency stalls progress)
   *   - Blocked → any (unblock)
   *   - corrections / Bug + Task lifecycle (not yet automated)
   *
   * Body shape: { status: "<one of VALID_STATUSES>" }
   *
   * No forward-only check — operator overrides should be possible (e.g.
   * Done → Backlog if a regression is found). The strict-mode safeguards
   * fire on workflow advance, not on explicit operator edits.
   */
  router.patch('/backlog/items/:id', (req, res) => {
    const id = req.params.id;
    if (!isValidId(id)) return res.status(400).json({ error: 'invalid id' });
    const body = req.body || {};
    if (typeof body.status !== 'string') {
      return res.status(400).json({ error: 'body.status (string) is required' });
    }
    if (!VALID_STATUSES.includes(body.status)) {
      return res.status(400).json({
        error: `invalid status "${body.status}". Valid: ${VALID_STATUSES.join(', ')}`,
      });
    }
    try {
      const existing = readItem(config.projectRoot, docsPath, id);
      if (!existing) return res.status(404).json({ error: 'not found' });
      if (existing.status === body.status) {
        // No-op — return current state without re-writing.
        return res.json({ item: { ...existing, companion_specs: discoverCompanionSpecs(config.projectRoot, docsPath, existing) } });
      }

      // Read the current BACKLOG section so we can both re-render display
      // lines AND, when status moves to Done, move the item into a "Shipped"
      // release group if one exists in this project. The Shipped convention
      // is per-project — example-app groups done items into a "Shipped"
      // release, example-ios keeps done items in their original release. Detect
      // the convention by looking for any release whose name contains
      // "shipped" (case-insensitive). When absent, the item's release
      // doesn't change — the operator can drag-reorder manually if they
      // want a different grouping.
      const statePath = path.join(config.projectRoot, docsPath, 'project-state.md');
      let groups = [];
      if (fs.existsSync(statePath)) {
        groups = parseBacklogSection(fs.readFileSync(statePath, 'utf8'));
      }

      const updatedItem = { ...existing, status: body.status };
      let movedToShipped = false;
      if (body.status === 'Done') {
        const shippedGroup = groups.find(g => /shipped/i.test(g.release));
        if (shippedGroup && existing.release !== shippedGroup.release) {
          updatedItem.release = shippedGroup.release;
          // Pull the id out of whatever group it's currently in, append to Shipped.
          for (const g of groups) g.items = g.items.filter(x => x !== id);
          shippedGroup.items.push(id);
          movedToShipped = true;
        }
      }

      writeItem(config.projectRoot, docsPath, updatedItem);

      if (groups.length > 0) {
        writeBacklogSection(config.projectRoot, docsPath, groups);
      }

      const updated = readItem(config.projectRoot, docsPath, id);
      res.json({
        item: { ...updated, companion_specs: discoverCompanionSpecs(config.projectRoot, docsPath, updated) },
        movedToShipped,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createBacklogRouter };
