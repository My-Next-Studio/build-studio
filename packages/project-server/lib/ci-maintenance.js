'use strict';

/**
 * The maintenance pass behind a CI runtime notice. Design:
 * docs/plans/test-suite-drift.md.
 *
 *   Start      one analysis agent reads the CI timings, the workflow file, the
 *              gates and tests it runs and where they came from, and writes
 *              its proposals to a result file. It changes nothing else.
 *   Filed      the server files the result as a backlog Task. The owner clicks
 *              Draft on it, and the PM writes the PRD with them. From there it
 *              is an ordinary PRD: review, execution, QA, merge.
 *   Done       when that item reaches Implemented (its PRD merged), the CI
 *              runtime baseline restarts for every workflow, so the next runs
 *              are judged against the suite's new size, not the old one.
 *
 * A backlog item rather than a PRD written by the agent (owner decision,
 * 2026-10-27): drafting already knows each project's PRD conventions, and the
 * owner chooses which cuts to make before a PRD exists.
 *
 * The server files the item, not the agent, so the item's type, its wording
 * about the baseline, and the record linking it back here are not left to an
 * agent remembering to include them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runOneShot: defaultRunOneShot, getOneShotStatus: defaultGetOneShotStatus } = require('./oneshot');
const backlog = require('./backlog');
const { scopedCommit: defaultScopedCommit } = require('./scoped-commit');
const { fmtDuration } = require('./ci-runtime');

/** Reading a large suite and its history takes a while; ten minutes was not enough for one site. */
const MAX_DURATION_MS = 40 * 60 * 1000;
const TICK_MS = 60 * 1000;
/** Statuses that mean the item's PRD has merged. */
const MERGED = ['Implemented', 'Done'];

function stateFileFor(ciStoreFile) {
  return ciStoreFile.replace(/\.json$/, '.maintenance.json');
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || null; } catch (_) { return null; }
}

function writeState(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

const mins = (secs) => Math.round((secs || 0) / 60);

/** Where the runner time of a run goes, largest first. */
function stepTable(steps, limit = 25) {
  return Object.entries(steps || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, s]) => `- ${k}: ${mins(s)} min`)
    .join('\n') || '- (no step timings recorded)';
}

/**
 * The analysis agent's instruction.
 * @param {object} o
 * @param {object} o.workflow  one entry of ciRuntime.get().workflows
 * @param {object} o.latestRun the stored run record (with steps) of o.workflow.latest
 */
function composeMaintenancePrompt({ repo, workflow, latestRun, resultFile }) {
  const f = workflow.flag;
  const grown = f && f.grownSteps.length
    ? f.grownSteps.map((s) => `- ${s.step}: ${mins(s.beforeSeconds)} → ${mins(s.nowSeconds)} min`).join('\n')
    : '- (no single step stands out; the growth is spread)';
  return [
    '== CI test-suite maintenance analysis ==',
    "This project's CI has grown. Every workflow run is scoped to one PRD, so tests and gates only ever get",
    'added: each PRD adds its own gate or performance test, and nobody consolidates them. Your job is to find',
    'what can be merged, cut, scoped down or moved off the push path, without losing coverage.',
    '',
    'ANALYSIS ONLY. Do not edit, create, delete, commit or push anything except the result file below.',
    'The owner and the PM turn your proposals into a PRD, which then goes through the normal review, build',
    'and QA. Do not write the PRD yourself.',
    '',
    `Repo: ${repo}`,
    `CI workflow: ${workflow.name}`,
    f
      ? `Runner time: ${fmtDuration(f.latestSeconds)} now, against a baseline of ${fmtDuration(f.baselineSeconds)} (${f.overPct}% over), since the push of ${f.since.createdAt.slice(0, 10)}${f.since.sha ? ` (${f.since.sha.slice(0, 9)})` : ''}.`
      : `Runner time: median ${fmtDuration(workflow.medianSeconds)} over recent successful pushes.`,
    'Runner time is the sum of the jobs\' own durations, not the wall clock.',
    '',
    'Steps that grew most since the baseline:',
    grown,
    '',
    `Where the runner time goes in the latest successful run${latestRun && latestRun.url ? ` (${latestRun.url})` : ''}:`,
    stepTable(latestRun && latestRun.steps),
    '',
    'Do this:',
    `1. Read the workflow file under .github/workflows/ that defines "${workflow.name}", and every script, gate`
      + ' and test suite its expensive steps run.',
    '2. For each expensive check, find what it verifies and where it came from:'
      + " `git log --diff-filter=A --format='%h %ad %s' --date=short -- <file>` names the commit, usually with"
      + ' the PRD or ticket that added it. Read that PRD\'s acceptance criteria when the reason is unclear.',
    '3. Look for overlap: the same pages audited by more than one gate, the same metric measured twice, a'
      + ' browser test repeating what a unit test already proves, a per-PRD gate a site-wide one already'
      + ' covers, slow fixtures run on every push for content that rarely changes.',
    '4. Propose changes, biggest saving first. Each is one of: merge, cut, scope down, or move to a scheduled'
      + ' run. For every test or gate a proposal removes or narrows, name the test that still covers that'
      + ' acceptance criterion afterwards. A proposal that loses the last test of an AC is not a saving: leave'
      + ' it out, or say what would have to replace it. Estimate the runner minutes each one saves from the'
      + ' timings above.',
    '5. Say what you looked at and decided to leave alone, and why, so the review does not redo it.',
    '',
    `Write your result as JSON to ${resultFile}:`,
    '{',
    '  "title": "<backlog item title, under 80 characters, starting with the workflow name>",',
    '  "summary": "<2-3 sentences: where the time goes and what the proposals save in total>",',
    '  "estimatedSavingsMinutes": <number>,',
    '  "body": "<markdown with these sections: ## Why (the numbers), ## Proposals (a table: change | kind |',
    '           saves | coverage kept by), ## Left alone, ## Acceptance (CI runner time back within budget,',
    '           and no acceptance criterion loses its last test)>"',
    '}',
  ].join('\n');
}

/**
 * Where the filed item goes: the top of the backlog, before the first item of
 * the first release (owner decision, 2026-10-30). The backlog refuses an item
 * with no position, and a pass has no owner to ask. An empty backlog gets a
 * "Maintenance" release.
 */
function topOfBacklog(projectRoot, docsPath) {
  return backlog.topOfBacklog(projectRoot, docsPath, 'Maintenance');
}

/**
 * @param {object} config     the loaded project config
 * @param {object} ciRuntime  from createCiRuntime
 * @param {object} [deps]     injectable runner, backlog, commit, state file, clock
 */
function createCiMaintenance(config, ciRuntime, deps = {}) {
  const runOneShot = deps.runOneShot || defaultRunOneShot;
  const getOneShotStatus = deps.getOneShotStatus || defaultGetOneShotStatus;
  const createItem = deps.createItem || backlog.createItem;
  const readItem = deps.readItem || backlog.readItem;
  const scopedCommit = deps.scopedCommit || defaultScopedCommit;
  const now = deps.now || (() => Date.now());
  const projectRoot = config.projectRoot;
  const docsPath = config.docs_path || './docs';
  const repo = (config.deployment && config.deployment.repo) || null;
  const file = deps.stateFile || (ciRuntime.storeFile ? stateFileFor(ciRuntime.storeFile) : null);

  const iso = () => new Date(now()).toISOString();
  const read = () => (file ? readState(file) : null);
  const write = (s) => { if (file) writeState(file, s); return s; };

  /** The pass on record, or null. */
  function status() {
    return read();
  }

  /** Start the analysis for one over-budget (or any measured) workflow. */
  function start(workflowName) {
    if (!repo || !ciRuntime.enabled) throw Object.assign(new Error('CI runtime is not measured for this project'), { status: 400 });
    const cur = read();
    if (cur && (cur.state === 'running' || cur.state === 'filed')) {
      throw Object.assign(new Error(cur.state === 'running'
        ? 'A maintenance pass is already running.'
        : `A maintenance pass is already filed as ${cur.itemId}. Draft and build that one first.`), { status: 409 });
    }
    // The analysis finished but filing it failed: file the result on disk
    // (tick() picks it up) instead of spending another run on the same answer.
    if (cur && cur.state === 'error' && cur.workflow === workflowName && cur.resultFile && fs.existsSync(cur.resultFile)) {
      const { error: _error, ...rest } = cur;
      return write({ ...rest, state: 'running' });
    }
    const workflow = ciRuntime.get().workflows.find((w) => w.name === workflowName);
    if (!workflow) throw Object.assign(new Error(`no CI runtime recorded for ${workflowName}`), { status: 404 });

    const resultDir = path.join(projectRoot, 'tmp', 'ci-maintenance');
    fs.mkdirSync(resultDir, { recursive: true });
    const resultFile = path.join(resultDir, `${crypto.randomBytes(8).toString('hex')}.json`);
    const latestRun = workflow.latest ? ciRuntime.run(workflow.latest.id) : null;

    let result;
    try {
      result = runOneShot({
        projectRoot,
        prompt: composeMaintenancePrompt({ repo, workflow, latestRun, resultFile }),
        label: 'ci-maintenance',
        maxDurationMs: MAX_DURATION_MS,
        agentDefaults: config.agent_defaults,
      });
    } catch (e) {
      if (e.code === 'CONFLICT') {
        throw Object.assign(new Error('Another one-shot agent (a CI investigation, say) is running in this project. Try again when it finishes.'), { status: 409 });
      }
      throw e;
    }
    return write({
      state: 'running', workflow: workflowName, runId: result.runId, resultFile,
      startedAt: iso(), flag: workflow.flag || null,
    });
  }

  /** File the agent's result as a backlog Task and commit it. */
  async function fileItem(cur) {
    let r;
    try { r = JSON.parse(fs.readFileSync(cur.resultFile, 'utf8')); } catch (e) {
      return write({ ...cur, state: 'error', error: `the analysis left no readable result (${e.message})` });
    }
    const f = cur.flag;
    const intro = [
      `Filed by a CI maintenance pass on ${cur.startedAt.slice(0, 10)} for the **${cur.workflow}** workflow`
        + (f ? `: ${fmtDuration(f.latestSeconds)} of runner time against a baseline of ${fmtDuration(f.baselineSeconds)} (${f.overPct}% over).` : '.'),
      r.estimatedSavingsMinutes ? `Estimated saving: about ${r.estimatedSavingsMinutes} runner minutes per push.` : '',
      'When this item reaches Implemented, Build Studio restarts the CI runtime baseline, so the runs after it are'
        + ' judged against the new size.',
    ].filter(Boolean).join(' ');
    const title = String(r.title || `${cur.workflow} CI: test-suite maintenance`).slice(0, 120);
    const body = `${intro}\n\n${r.summary ? `${r.summary}\n\n` : ''}${r.body || ''}`;

    let created;
    try {
      created = createItem(projectRoot, docsPath, { title, type: 'Task', body, config, ...topOfBacklog(projectRoot, docsPath) });
    } catch (e) {
      return write({ ...cur, state: 'error', error: `could not file the backlog item: ${e.message}` });
    }
    if (fs.existsSync(path.join(projectRoot, '.git'))) {
      const rel = (p) => path.relative(projectRoot, p);
      const c = await scopedCommit(projectRoot, [
        rel(backlog.itemFilePath(projectRoot, docsPath, created.id)),
        rel(backlog.backlogIndexPath(projectRoot, docsPath)),
      ], `docs(${created.id}): add CI maintenance pass to the backlog`);
      if (!c.committed) console.warn(`[ci-maintenance] ${created.id} filed but not committed: ${c.reason}`);
    }
    try { fs.unlinkSync(cur.resultFile); } catch (_) { /* already gone */ }
    console.log(`[ci-maintenance] filed ${created.id} for ${cur.workflow}`);
    return write({ ...cur, state: 'filed', itemId: created.id, title, filedAt: iso() });
  }

  let ticking = false;
  /** Move the pass on record forward. Safe to call often; never throws. */
  async function tick() {
    if (ticking) return read();
    ticking = true;
    try {
      const cur = read();
      if (!cur) return null;
      if (cur.state === 'running') {
        const entry = getOneShotStatus(cur.runId);
        if (entry && entry.state === 'running') return cur;
        if (entry && (entry.state === 'error' || entry.state === 'timeout')) {
          return write({ ...cur, state: 'error', error: entry.state === 'timeout' ? 'the analysis timed out' : String(entry.stderr || 'the analysis failed').slice(0, 300) });
        }
        // Complete, or no run in memory (a server restart): the result file decides.
        if (fs.existsSync(cur.resultFile)) return await fileItem(cur);
        return write({ ...cur, state: entry ? 'error' : 'lost', error: entry ? 'the analysis finished without writing a result' : 'the analysis did not survive a restart' });
      }
      if (cur.state === 'filed') {
        let item = null;
        try { item = readItem(projectRoot, docsPath, cur.itemId); } catch (_) { item = null; }
        if (!item) return write({ ...cur, state: 'error', error: `${cur.itemId} is no longer in the backlog` });
        if (MERGED.includes(item.status)) {
          const at = iso();
          const workflows = ciRuntime.markBaseline(at, 'maintenance');
          console.log(`[ci-maintenance] ${cur.itemId} is ${item.status}: CI runtime baseline restarted for ${workflows.join(', ')}`);
          return write({ ...cur, state: 'done', doneAt: at });
        }
      }
      return cur;
    } catch (e) {
      console.warn(`[ci-maintenance] tick failed: ${e.message}`);
      return read();
    } finally {
      ticking = false;
    }
  }

  let timer = null;
  function startTicking() {
    if (timer || !repo || !ciRuntime.enabled) return;
    timer = setInterval(() => { tick(); }, TICK_MS);
    if (timer.unref) timer.unref();
    tick();
  }

  return { start, status, tick, startTicking };
}

module.exports = { createCiMaintenance, composeMaintenancePrompt, stateFileFor, MERGED };
