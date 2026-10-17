'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Owner checks saved for later (owner request, 2026-10-17).
 *
 * A run's owner_checks step lists the manual checks it recommends, and the end
 * of a run is often not the moment to do them. "Save for later" there completes
 * the run and keeps its checks here, one entry per backlog item, until the
 * owner marks them done or skips them from the Queue tab — before a release,
 * say. Nothing here gates anything: the run completes either way, and the item
 * can still be moved to Done in the backlog.
 *
 * Local state, next to workflow-state.json, never committed:
 * `.build-studio/saved-owner-checks.json`.
 */

const FILE = 'saved-owner-checks.json';
const IGNORE_RULE = '.build-studio/saved-owner-checks.json';

const filePath = (statePath) => path.join(statePath, FILE);

/** The saved entries, oldest first. A missing or unreadable file reads as none. */
function loadSaved(statePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(statePath), 'utf8'));
    return Array.isArray(data && data.entries) ? data.entries : [];
  } catch (_) {
    return [];
  }
}

function writeSaved(statePath, entries) {
  fs.mkdirSync(statePath, { recursive: true });
  const file = filePath(statePath);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Keep a finished run's checks for later. A second run for the same item adds
 * its new checks to that item's entry rather than making a second one.
 *
 * @param run  the workflow: `itemId`, `id`, `type`, `prdPath`
 * @param checks  [{ text, step }] as the owner_checks step shows them
 * @returns the saved entry, or null when there was nothing to save
 */
function saveForLater(statePath, run, checks) {
  const list = (checks || []).filter((c) => c && c.text);
  if (!list.length) return null;
  const entries = loadSaved(statePath);
  const item = run.itemId || null;
  const at = new Date().toISOString();
  let entry = item ? entries.find((e) => e.item === item) : null;
  if (entry) {
    for (const c of list) {
      if (!entry.checks.some((x) => x.text === c.text)) entry.checks.push({ text: c.text, step: c.step || null, runId: run.id });
    }
    entry.updatedAt = at;
    if (!entry.runIds.includes(run.id)) entry.runIds.push(run.id);
  } else {
    entry = {
      id: crypto.randomUUID(),
      item,
      runType: run.type || null,
      prdPath: run.prdPath || null,
      runIds: [run.id],
      savedAt: at,
      checks: list.map((c) => ({ text: c.text, step: c.step || null, runId: run.id })),
    };
    entries.push(entry);
  }
  writeSaved(statePath, entries);
  return entry;
}

/** Remove an entry, whether its checks were done or skipped. Returns it, or null when absent. */
function removeSaved(statePath, id) {
  const entries = loadSaved(statePath);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  writeSaved(statePath, entries.filter((e) => e.id !== id));
  return entry;
}

module.exports = { IGNORE_RULE, loadSaved, saveForLater, removeSaved };
