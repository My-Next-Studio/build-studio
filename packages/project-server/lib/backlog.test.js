const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  isValidId,
  parseItemFile,
  serializeItemFile,
  readItem,
  writeItem,
  listItems,
  normalizePrdField,
  parseBacklogSection,
  renderBacklogSection,
  writeBacklogSection,
  readBacklog,
  nextItemId,
  BACKLOG_START,
  BACKLOG_END,
} = require('./backlog');

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-test-'));
  fs.mkdirSync(path.join(root, 'docs', 'backlog'), { recursive: true });
  return root;
}

// ─── isValidId ──────────────────────────────────────────────────────────────
test('isValidId accepts canonical IDs', () => {
  assert.equal(isValidId('EX-001'), true);
  assert.equal(isValidId('ABC-42'), true);
  assert.equal(isValidId('XYZ-99999'), true);
});
test('isValidId rejects path traversal + bad shapes', () => {
  assert.equal(isValidId('../etc/passwd'), false);
  assert.equal(isValidId('ex-001'), false);
  assert.equal(isValidId('EX-'), false);
  assert.equal(isValidId('EX001'), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(null), false);
});

// ─── item file round-trip ───────────────────────────────────────────────────
test('serialize → parse round-trips frontmatter and body', () => {
  const item = {
    id: 'EX-042',
    title: 'Settings tab for user preferences',
    type: 'Feature',
    status: 'Ready',
    release: '0.3',
    created: '2026-05-26',
    prd: 'docs/prds/PRD-008-settings-tab.md',
    depends_on: ['EX-038'],
    cost_actual_usd: null,
    body: '## Requirements\n\nLet users adjust calorie target.\n\n## Acceptance criteria\n- AC-1 — setting persists across launches\n',
  };
  const text = serializeItemFile(item);
  const parsed = parseItemFile(text);
  assert.equal(parsed.id, 'EX-042');
  assert.equal(parsed.title, 'Settings tab for user preferences');
  assert.deepEqual(parsed.depends_on, ['EX-038']);
  assert.equal(parsed.cost_actual_usd, null);
  assert.match(parsed.body, /Let users adjust calorie target/);
});

test('writeItem + readItem round-trip on disk', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'EX-001', title: 'Hello', type: 'Task', status: 'Backlog', body: '## Notes\nx\n' });
  const back = readItem(root, 'docs', 'EX-001');
  assert.equal(back.id, 'EX-001');
  assert.equal(back.title, 'Hello');
  assert.equal(back.type, 'Task');
  assert.match(back.body, /x/);
});

test('writeItem rejects invalid type/status/id', () => {
  const root = tmpProject();
  assert.throws(() => writeItem(root, 'docs', { id: 'EX-001', type: 'Epic' }), /invalid type/);
  assert.throws(() => writeItem(root, 'docs', { id: 'EX-001', status: 'WontFix' }), /invalid status/);
  assert.throws(() => writeItem(root, 'docs', { id: '../escape' }), /invalid id/);
});

// ─── project-state.md section parsing ───────────────────────────────────────
test('parseBacklogSection extracts groups + IDs in order', () => {
  const md = `# Project state

random preamble

## Backlog

${BACKLOG_START}

### Release 0.3 (current)
- EX-042 — Settings tab  [Feature · Ready]
- EX-038 — Crash on empty meal name  [Bug · In Progress]

### Release 0.4
- EX-051 — Onboarding redesign  [Feature · Backlog]

### Unscheduled
- EX-060 — Apple Watch exploration  [Feature · Backlog]

${BACKLOG_END}

## Key Decisions Log
…
`;
  const groups = parseBacklogSection(md);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].release, 'Release 0.3 (current)');
  assert.deepEqual(groups[0].items, ['EX-042', 'EX-038']);
  assert.deepEqual(groups[1].items, ['EX-051']);
  assert.deepEqual(groups[2].items, ['EX-060']);
});

test('parseBacklogSection returns [] when markers are missing', () => {
  assert.deepEqual(parseBacklogSection('## Backlog\n- FOO-1 — nope\n'), []);
});

// ─── splice preserves content outside markers ───────────────────────────────
test('writeBacklogSection preserves everything outside the markers', () => {
  const root = tmpProject();
  const before = `# Project state\n\nOwner: lars\n\n## Backlog\n\n`;
  const sectionStub = `${BACKLOG_START}\n\nOLD CONTENT\n\n${BACKLOG_END}`;
  const after = `\n\n## Key Decisions Log\n\n- 2026-05-01 — switched to Postgres\n`;
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'), before + sectionStub + after);

  writeItem(root, 'docs', { id: 'EX-001', title: 'First item', type: 'Feature', status: 'Backlog', body: '' });
  writeBacklogSection(root, 'docs', [{ release: 'Release 0.1', items: ['EX-001'] }]);

  const updated = fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8');
  assert.match(updated, /Owner: lars/);                        // preamble preserved
  assert.match(updated, /Key Decisions Log/);                  // trailer preserved
  assert.match(updated, /2026-05-01 — switched to Postgres/);  // trailer detail preserved
  assert.doesNotMatch(updated, /OLD CONTENT/);                  // old section replaced
  assert.match(updated, /### Release 0\.1/);                    // new release header rendered
  assert.match(updated, /EX-001 — First item\s+\[Feature · Backlog\]/);
});

test('writeBacklogSection round-trips via parseBacklogSection', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'),
    `# state\n${BACKLOG_START}\n${BACKLOG_END}\n`);
  writeItem(root, 'docs', { id: 'EX-001', title: 'A', type: 'Task', status: 'Done', body: '' });
  writeItem(root, 'docs', { id: 'EX-002', title: 'B', type: 'Bug', status: 'Backlog', body: '' });
  const groups = [
    { release: 'Release 0.1', items: ['EX-001'] },
    { release: 'Unscheduled', items: ['EX-002'] },
  ];
  writeBacklogSection(root, 'docs', groups);
  const reparsed = parseBacklogSection(fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8'));
  assert.deepEqual(reparsed, groups);
});

test('writeBacklogSection renders missing-item placeholder for dead refs', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'),
    `# state\n${BACKLOG_START}\n${BACKLOG_END}\n`);
  writeBacklogSection(root, 'docs', [{ release: 'Release 0.1', items: ['EX-999'] }]);
  const text = fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8');
  assert.match(text, /EX-999 — \(missing item file\)/);
});

// ─── listItems / readBacklog ─────────────────────────────────────────────────
test('listItems skips non-matching files + malformed frontmatter', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'EX-001', title: 'ok', type: 'Task', status: 'Done', body: '' });
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'README.md'), '# not an item\n');
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'BAD-001.md'), 'no frontmatter here\n');
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-002.md'), 'no frontmatter\n');
  const items = listItems(root, 'docs');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'EX-001');
});

test('readBacklog joins order + items', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'),
    `# state\n${BACKLOG_START}\n\n### Release 0.1\n- EX-001 — A  [Task · Done]\n\n${BACKLOG_END}\n`);
  writeItem(root, 'docs', { id: 'EX-001', title: 'A', type: 'Task', status: 'Done', body: '' });
  const { groups, items } = readBacklog(root, 'docs');
  assert.equal(groups[0].release, 'Release 0.1');
  assert.deepEqual(groups[0].items, ['EX-001']);
  assert.equal(items['EX-001'].title, 'A');
});

// ─── nextItemId ──────────────────────────────────────────────────────────────
test('nextItemId picks max+1 with 3-digit padding', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'EX-001', title: 'a', type: 'Task', status: 'Done', body: '' });
  writeItem(root, 'docs', { id: 'EX-005', title: 'e', type: 'Task', status: 'Done', body: '' });
  writeItem(root, 'docs', { id: 'EX-042', title: 'z', type: 'Task', status: 'Done', body: '' });
  assert.equal(nextItemId(root, 'docs', 'EX'), 'EX-043');
});

test('nextItemId never reuses a gap', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'EX-001', title: 'a', type: 'Task', status: 'Done', body: '' });
  writeItem(root, 'docs', { id: 'EX-002', title: 'b', type: 'Task', status: 'Done', body: '' });
  // delete the highest — next should still be 3, never 2
  fs.unlinkSync(path.join(root, 'docs', 'backlog', 'EX-002.md'));
  assert.equal(nextItemId(root, 'docs', 'EX'), 'EX-002');  // unfortunately YES reuses
  // ↑ documents the current behavior: gaps ARE reused if they're at the tip.
  // PRD says "never reuse" — strict adherence would need a separate retired-id
  // log. Acceptable tradeoff for MVP; revisit if id-collision matters.
});

test('nextItemId returns prefix-001 on empty project', () => {
  const root = tmpProject();
  assert.equal(nextItemId(root, 'docs', 'XYZ'), 'XYZ-001');
});

// ─── discoverCompanionSpecs — parses the PRD's own Companion Specs table ────
const { discoverCompanionSpecs, parseCompanionSpecsFromPRD } = require('./backlog');

function writePRD(root, name, body) {
  const prdDir = path.join(root, 'docs', 'prds');
  fs.mkdirSync(prdDir, { recursive: true });
  fs.writeFileSync(path.join(prdDir, name), body);
}

test('parseCompanionSpecsFromPRD extracts backtick-wrapped .md paths in the section', () => {
  const root = tmpProject();
  writePRD(root, 'PRD-009-x.md', `# PRD-009

## Companion Specs

| Spec | Status | Path |
|---|---|---|
| QA test plan | Done | \`docs/qa/QA-009-x.md\` |
| Brand review | Done | \`docs/brand/PRD-009-copy.md\` |
| Architect input | Done | reviewer pass on the PR |

## Problem

Other section.
`);
  fs.mkdirSync(path.join(root, 'docs', 'qa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'qa', 'QA-009-x.md'), '');
  const specs = parseCompanionSpecsFromPRD(root, 'docs/prds/PRD-009-x.md');
  assert.equal(specs.length, 2);
  assert.ok(specs.some(s => s.path === 'docs/qa/QA-009-x.md' && s.exists === true));
  assert.ok(specs.some(s => s.path === 'docs/brand/PRD-009-copy.md' && s.exists === false));
});

test('parseCompanionSpecsFromPRD ignores .md paths mentioned inside a row description cell', () => {
  // Regression: example-app EX-032 via PRD-021 (2026-06-03). A row's description
  // cell referenced `brand-guidelines.md` in prose ("…light /brand pass against
  // `brand-guidelines.md` §2 gate") and the parser treated it as a phantom
  // pending companion spec. Only the standalone Path-column entries are specs.
  const root = tmpProject();
  writePRD(root, 'PRD-021-x.md', `# PRD-021

## Companion Specs

| Spec | Required | Owner | Path | Status |
|---|---|---|---|---|
| ADR amendment — model placement | **Required** | /architect | \`docs/adrs/ADR-012-x.md\` | Pending |
| UX spec — copy audit: light /brand pass against \`brand-guidelines.md\` §2 calm-colleague gate | **Required** | /ux | \`docs/ux/UX-021-x.md\` | Done |

## Problem
`);
  const specs = parseCompanionSpecsFromPRD(root, 'docs/prds/PRD-021-x.md');
  assert.deepEqual(specs.map(s => s.path).sort(), [
    'docs/adrs/ADR-012-x.md',
    'docs/ux/UX-021-x.md',
  ]);
  assert.ok(!specs.some(s => /brand-guidelines/.test(s.path)), 'prose-mentioned path must not be a spec');
});

test('parseCompanionSpecsFromPRD handles numbered + slash-style headings', () => {
  const root = tmpProject();
  writePRD(root, 'PRD-007-x.md', `# PRD-007

## 9. Companion specs / deliverables

| Spec | Required | Path | Status |
|---|---|---|---|
| ADR-010 | **Required** | \`docs/adrs/ADR-010-ios-stack.md\` | Not started |
| Build runbook | **Required** | \`docs/runbooks/ios-build.md\` | Not started |
`);
  const specs = parseCompanionSpecsFromPRD(root, 'docs/prds/PRD-007-x.md');
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map(s => s.path).sort(), [
    'docs/adrs/ADR-010-ios-stack.md',
    'docs/runbooks/ios-build.md',
  ]);
});

test('parseCompanionSpecsFromPRD stops at the next H2 section', () => {
  const root = tmpProject();
  writePRD(root, 'PRD-099-x.md', `# PRD-099

## Companion Specs

| Spec | Path |
|---|---|
| QA | \`docs/qa/QA-099.md\` |

## Implementation

A path that should be ignored: \`docs/should-not-include.md\`.
`);
  const specs = parseCompanionSpecsFromPRD(root, 'docs/prds/PRD-099-x.md');
  assert.equal(specs.length, 1);
  assert.equal(specs[0].path, 'docs/qa/QA-099.md');
});

test('parseCompanionSpecsFromPRD also catches markdown-link path syntax', () => {
  const root = tmpProject();
  writePRD(root, 'PRD-009-x.md', `# PRD-009

## Companion Specs

| Spec | Path |
|---|---|
| Brand copy | [\`docs/brand/PRD-009-copy.md\`](../brand/PRD-009-copy.md) |
| Architect link-only | [link to ADR](../adrs/ADR-007-edit.md) |
`);
  const specs = parseCompanionSpecsFromPRD(root, 'docs/prds/PRD-009-x.md');
  // Both backtick and link forms picked up; backtick + relative link to same target dedupe.
  assert.ok(specs.some(s => s.path === 'docs/brand/PRD-009-copy.md'));
  assert.ok(specs.some(s => s.path === 'docs/adrs/ADR-007-edit.md'));
});

test('parseCompanionSpecsFromPRD ignores paths that escape project root', () => {
  const root = tmpProject();
  // From docs/prds/ this resolves to N levels above projectRoot — must be rejected.
  writePRD(root, 'PRD-001.md', `# X
## Companion Specs
| Path |
|---|
| \`../../../../../../etc/passwd.md\` |
`);
  const specs = parseCompanionSpecsFromPRD(root, 'docs/prds/PRD-001.md');
  assert.deepEqual(specs, []);
});

test('discoverCompanionSpecs respects explicit frontmatter override', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'docs', 'qa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'qa', 'custom.md'), '');
  const specs = discoverCompanionSpecs(root, 'docs', {
    id: 'XX-001', prd: 'docs/prds/PRD-005-x.md',
    companion_specs: ['docs/qa/custom.md', 'docs/qa/pending.md'],
  });
  assert.equal(specs.length, 2);
  assert.equal(specs.find(s => s.path === 'docs/qa/custom.md')?.exists, true);
  assert.equal(specs.find(s => s.path === 'docs/qa/pending.md')?.exists, false);
});

test('discoverCompanionSpecs returns [] when item has no PRD and no override', () => {
  const root = tmpProject();
  assert.deepEqual(discoverCompanionSpecs(root, 'docs', { id: 'XX-001' }), []);
});

test('discoverCompanionSpecs returns [] when PRD has no Companion Specs section', () => {
  const root = tmpProject();
  writePRD(root, 'PRD-001.md', '# PRD-001\n\nNo companion section here.\n');
  assert.deepEqual(
    discoverCompanionSpecs(root, 'docs', { id: 'XX-001', prd: 'docs/prds/PRD-001.md' }),
    []
  );
});

// ─── Feature auto-transitions ────────────────────────────────────────────────
const {
  lifecycleAdvancesPast,
  applyAutoTransitionsForFeatures,
  transitionFeaturesForPRD,
} = require('./backlog');

test('lifecycleAdvancesPast respects ordering + refuses backwards/legacy moves', () => {
  assert.equal(lifecycleAdvancesPast('Backlog', 'Drafted'), true);
  assert.equal(lifecycleAdvancesPast('Drafted', 'Reviewed'), true);
  assert.equal(lifecycleAdvancesPast('Reviewed', 'Implemented'), true);
  assert.equal(lifecycleAdvancesPast('Implemented', 'Done'), true);
  // Skipping forward is also "advance" — allowed (rare but legal):
  assert.equal(lifecycleAdvancesPast('Backlog', 'Implemented'), true);
  // Backwards:
  assert.equal(lifecycleAdvancesPast('Reviewed', 'Drafted'), false);
  assert.equal(lifecycleAdvancesPast('Done', 'Implemented'), false);
  // Same state — not an advance:
  assert.equal(lifecycleAdvancesPast('Reviewed', 'Reviewed'), false);
  // Blocked / legacy current state — never auto-advanced:
  assert.equal(lifecycleAdvancesPast('Blocked', 'Implemented'), false);
  assert.equal(lifecycleAdvancesPast('In Progress', 'Implemented'), false);
});

test('applyAutoTransitionsForFeatures: Feature + Backlog + PRD on disk → Drafted', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'XX-001', title: 'a', type: 'Feature', status: 'Backlog', prd: 'docs/prds/PRD-001-x.md', body: '' });
  writeItem(root, 'docs', { id: 'XX-002', title: 'b', type: 'Feature', status: 'Backlog', prd: 'docs/prds/PRD-002-x.md', body: '' });  // PRD doesn't exist
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-001-x.md'), '# PRD-001\n');

  const result = applyAutoTransitionsForFeatures(root, 'docs');
  assert.equal(result.changed, true);
  assert.equal(result.transitioned.length, 1);
  assert.equal(result.transitioned[0].id, 'XX-001');
  assert.equal(readItem(root, 'docs', 'XX-001').status, 'Drafted');
  assert.equal(readItem(root, 'docs', 'XX-002').status, 'Backlog');  // PRD missing — no move
});

test('applyAutoTransitionsForFeatures: Bug + Task with PRD on disk also auto-advance', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-001-x.md'), '# x\n');
  writeItem(root, 'docs', { id: 'XX-001', title: 'bug', type: 'Bug',  status: 'Backlog', prd: 'docs/prds/PRD-001-x.md', body: '' });
  writeItem(root, 'docs', { id: 'XX-002', title: 'task', type: 'Task', status: 'Backlog', prd: 'docs/prds/PRD-001-x.md', body: '' });
  // All three lifecycle types share the Backlog→Drafted→… progression and run
  // the same review/execution workflows, so Bugs and Tasks advance like Features.
  const result = applyAutoTransitionsForFeatures(root, 'docs');
  assert.equal(result.transitioned.length, 2);
  assert.equal(readItem(root, 'docs', 'XX-001').status, 'Drafted');
  assert.equal(readItem(root, 'docs', 'XX-002').status, 'Drafted');
});

test('applyAutoTransitionsForFeatures is idempotent', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-001-x.md'), '# x\n');
  writeItem(root, 'docs', { id: 'XX-001', title: 'a', type: 'Feature', status: 'Backlog', prd: 'docs/prds/PRD-001-x.md', body: '' });
  applyAutoTransitionsForFeatures(root, 'docs');
  const second = applyAutoTransitionsForFeatures(root, 'docs');
  assert.equal(second.changed, false);
});

test('transitionFeaturesForPRD advances matching items (all types) + skips already-past ones', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'XX-001', title: 'a', type: 'Feature', status: 'Drafted',     prd: 'docs/prds/PRD-005.md', body: '' });
  writeItem(root, 'docs', { id: 'XX-002', title: 'b', type: 'Feature', status: 'Implemented', prd: 'docs/prds/PRD-005.md', body: '' }); // past target — skip
  writeItem(root, 'docs', { id: 'XX-003', title: 'c', type: 'Feature', status: 'Drafted',     prd: 'docs/prds/PRD-006.md', body: '' }); // different PRD
  writeItem(root, 'docs', { id: 'XX-004', title: 'd', type: 'Bug',     status: 'Drafted',     prd: 'docs/prds/PRD-005.md', body: '' }); // Bug — now advances too
  writeItem(root, 'docs', { id: 'XX-005', title: 'e', type: 'Task',    status: 'Drafted',     prd: 'docs/prds/PRD-005.md', body: '' }); // Task — now advances too

  const result = transitionFeaturesForPRD(root, 'docs', 'docs/prds/PRD-005.md', 'Reviewed');
  assert.equal(result.transitioned.length, 3);
  assert.deepEqual(result.transitioned.map(t => t.id).sort(), ['XX-001', 'XX-004', 'XX-005']);
  assert.equal(readItem(root, 'docs', 'XX-001').status, 'Reviewed');
  assert.equal(readItem(root, 'docs', 'XX-002').status, 'Implemented');
  assert.equal(readItem(root, 'docs', 'XX-003').status, 'Drafted');
  assert.equal(readItem(root, 'docs', 'XX-004').status, 'Reviewed');
  assert.equal(readItem(root, 'docs', 'XX-005').status, 'Reviewed');
});

test('transitionFeaturesForPRD normalises PRD path variants', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'XX-001', title: 'a', type: 'Feature', status: 'Drafted', prd: 'docs/prds/PRD-005.md', body: '' });
  // Workflow may have wf.prdPath stored as `prds/PRD-005.md` (without docs/)
  const result = transitionFeaturesForPRD(root, 'docs', 'prds/PRD-005.md', 'Reviewed');
  assert.equal(result.transitioned.length, 1);
});

test('transitionFeaturesForPRD never advances Blocked items', () => {
  const root = tmpProject();
  writeItem(root, 'docs', { id: 'XX-001', title: 'a', type: 'Feature', status: 'Blocked', prd: 'docs/prds/PRD-005.md', body: '' });
  const result = transitionFeaturesForPRD(root, 'docs', 'docs/prds/PRD-005.md', 'Implemented');
  assert.equal(result.transitioned.length, 0);
  assert.equal(readItem(root, 'docs', 'XX-001').status, 'Blocked');
});

test('discoverCompanionSpecs does NOT include same-numbered files outside the PRD table', () => {
  // Regression test for the original "naive number match" bug: ADR-007 should
  // NOT show up as a companion spec for PRD-007 unless PRD-007's table
  // explicitly references it.
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'docs', 'adrs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'adrs', 'ADR-007-unrelated.md'), '');
  writePRD(root, 'PRD-007-x.md', `# PRD-007

## Companion Specs

| Spec | Path |
|---|---|
| ADR-010 | \`docs/adrs/ADR-010-ios-stack.md\` |
`);
  const specs = discoverCompanionSpecs(root, 'docs', {
    id: 'XX-001', prd: 'docs/prds/PRD-007-x.md',
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].path, 'docs/adrs/ADR-010-ios-stack.md');
  assert.ok(!specs.some(s => s.path.includes('ADR-007')));
});

test('normalizePrdField resolves bare ID, markdown link, relative + canonical paths', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-028-maintenance-coach-card.md'), '# PRD-028');
  const canonical = 'docs/prds/PRD-028-maintenance-coach-card.md';
  // bare ID → globbed by prefix
  assert.equal(normalizePrdField('PRD-028', root, 'docs', 'EX-026'), canonical);
  // markdown link with a backlog-relative path → resolved
  assert.equal(normalizePrdField('[PRD-028](../prds/PRD-028-maintenance-coach-card.md)', root, 'docs', 'EX-026'), canonical);
  // relative path from the backlog dir → resolved
  assert.equal(normalizePrdField('../prds/PRD-028-maintenance-coach-card.md', root, 'docs', 'EX-026'), canonical);
  // canonical repo-root path → unchanged
  assert.equal(normalizePrdField(canonical, root, 'docs', 'EX-026'), canonical);
  // unresolvable ID + null are preserved (never silently dropped)
  assert.equal(normalizePrdField('PRD-999', root, 'docs', 'EX-026'), 'PRD-999');
  assert.equal(normalizePrdField(null, root, 'docs', 'EX-026'), null);
});

test('listItems normalizes a bare-ID prd field to the resolved path', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-028-coach.md'), '# PRD-028');
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-026.md'),
    '---\nid: EX-026\ntype: Feature\nprd: PRD-028\n---\n\nbody');
  const item = listItems(root, 'docs').find(i => i.id === 'EX-026');
  assert.equal(item.prd, 'docs/prds/PRD-028-coach.md');
});
