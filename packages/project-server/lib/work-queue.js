'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * The work queue: the owner's planned order of jobs for one project.
 * Plan: docs/plans/work-queue-and-remote-overview.md.
 *
 * An entry is a backlog item to take one phase further. Which phase is decided
 * when it starts, from the item's status unless the owner named one. The file
 * holds the pending entries, in the owner's order, and one current entry: the
 * job most recently started, whatever has become of it. There is no history;
 * the run's own record holds that.
 *
 * Local state, next to workflow-state.json, never committed:
 * `.build-studio/work-queue.json`.
 */

const FILE = 'work-queue.json';
const IGNORE_RULE = '.build-studio/work-queue.json';
const ACTIONS = ['draft', 'review', 'execute', 'bugfix'];

/** The workflow type each workflow action starts, and back. Draft is not a workflow. */
const WORKFLOW_TYPE = { review: 'review', execute: 'execution', bugfix: 'bugfix' };
const WORKFLOW_ACTION = { review: 'review', execution: 'execute', bugfix: 'bugfix' };

const empty = () => ({ v: 1, current: null, pending: [] });

function queuePath(statePath) {
  return path.join(statePath, FILE);
}

/** Read the queue. A missing or unreadable file reads as an empty queue. */
function loadQueue(statePath) {
  try {
    const q = JSON.parse(fs.readFileSync(queuePath(statePath), 'utf8'));
    if (!q || typeof q !== 'object' || !Array.isArray(q.pending)) return empty();
    return { v: 1, current: q.current || null, pending: q.pending };
  } catch (_) {
    return empty();
  }
}

/** Write it whole, through a temp file, so a crash never leaves half a queue. */
function saveQueue(statePath, queue) {
  fs.mkdirSync(statePath, { recursive: true });
  const file = queuePath(statePath);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function newEntry({ item, action, note }) {
  return {
    id: crypto.randomUUID(),
    item,
    ...(action ? { action } : {}),
    ...(note ? { note } : {}),
    addedAt: new Date().toISOString(),
  };
}

/** Insert at `position` (0-based; absent or out of range = the end). */
function insertAt(list, entry, position) {
  const at = Number.isInteger(position) && position >= 0 && position <= list.length ? position : list.length;
  return [...list.slice(0, at), entry, ...list.slice(at)];
}

/** Move a pending entry to `position`. Returns the new list, or null when the id is not pending. */
function moveTo(list, id, position) {
  const from = list.findIndex((e) => e.id === id);
  if (from < 0) return null;
  const entry = list[from];
  const rest = [...list.slice(0, from), ...list.slice(from + 1)];
  return insertAt(rest, entry, position);
}

/**
 * The phase an item takes next, from its status: no PRD → draft, Drafted →
 * review, Reviewed → execute, a Bug → bugfix. `explicit` wins when given.
 *
 * @returns {{ action: string } | { action: null, reason: string }}
 */
function nextAction(item, explicit) {
  if (explicit) return { action: explicit };
  if (!item) return { action: null, reason: 'the backlog item no longer exists' };
  if (item.type === 'Bug') {
    return ['Backlog', 'Blocked'].includes(item.status)
      ? { action: 'bugfix' }
      : { action: null, reason: `${item.id} is a Bug in "${item.status}": a bugfix starts from Backlog or Blocked` };
  }
  if (!item.prd) return { action: 'draft' };
  if (item.status === 'Drafted') return { action: 'review' };
  if (item.status === 'Reviewed') return { action: 'execute' };
  return { action: null, reason: `${item.id} is "${item.status || 'unset'}": nothing left for the queue to start` };
}

/** Does this started run's own phase count as finished? Only from authoritative state. */
function phaseFinished(action, item) {
  if (!item) return false;
  if (action === 'draft') return Boolean(item.prd);
  if (action === 'review') return ['Reviewed', 'Implemented', 'Done'].includes(item.status);
  if (action === 'execute') return ['Implemented', 'Done'].includes(item.status);
  if (action === 'bugfix') return item.status === 'Done';
  return false;
}

/**
 * The current entry's state, for a reader: what its run is doing now.
 *
 * `wf` is the active workflow (or null), `draft` the drafting session state
 * `{ session, agentRunning }`, `item` the entry's backlog item as stored.
 *
 * @returns {{ state: string, detail?: string, step?: string }}
 *   state: running | waiting_for_owner | ready_to_merge | finished | stopped
 */
function currentState(current, { wf, draft, item, needsAttention }) {
  if (!current || !current.run) return null;
  const run = current.run;
  if (run.kind === 'workflow') {
    if (wf && wf.id === run.id) {
      if (wf.currentStep === 'completed') return { state: 'finished', detail: 'the workflow completed; close it to free the slot' };
      if (wf.currentStep === 'merge_to_main') return { state: 'ready_to_merge', step: wf.currentStep };
      if (needsAttention) return { state: 'waiting_for_owner', step: wf.currentStep, detail: needsAttention.title };
      return { state: 'running', step: wf.currentStep };
    }
    return phaseFinished(current.action, item)
      ? { state: 'finished' }
      : { state: 'stopped', detail: 'the run is no longer active and its phase did not finish (cancelled?)' };
  }
  if (run.kind === 'draft') {
    const session = draft && draft.session;
    if (draft && draft.agentRunning) return { state: 'running', detail: 'drafting' };
    if (phaseFinished('draft', item)) return { state: 'finished' };
    return session && session.endedAt
      ? { state: 'stopped', detail: 'the draft ended without a PRD' }
      : { state: 'waiting_for_owner', detail: 'the drafting session is open but its agent is not running' };
  }
  return null;
}

/**
 * Record that a run started for `itemId`, linking it to its queue entry: the
 * given entry, or else the first pending entry for that item. The entry
 * becomes current and leaves the pending list; the previous current entry
 * drops off. Returns the linked entry, or null when no entry matched (the run
 * was started outside the queue for an item that is not queued).
 */
function linkStartedRun(statePath, { itemId, entryId, action, run }) {
  const queue = loadQueue(statePath);
  const index = entryId
    ? queue.pending.findIndex((e) => e.id === entryId)
    : queue.pending.findIndex((e) => e.item === itemId);
  if (index < 0) return null;
  const entry = queue.pending[index];
  const current = { ...entry, action, startedAt: new Date().toISOString(), run };
  queue.pending = [...queue.pending.slice(0, index), ...queue.pending.slice(index + 1)];
  queue.current = current;
  saveQueue(statePath, queue);
  return current;
}

module.exports = {
  ACTIONS, WORKFLOW_TYPE, WORKFLOW_ACTION, IGNORE_RULE,
  loadQueue, saveQueue, newEntry, insertAt, moveTo, nextAction, phaseFinished, currentState, linkStartedRun,
};
