'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGateBlocked } = require('./gate-blocked');

// The two real incidents this exists for. In both the code was fine, the check
// never executed, and the fix loop was handed work nobody could complete.
const NO_BROWSER = `**Approved:** no
**Tests passed:** 7/7
**Gate could not run:** agent.browsers.getForUrl("http://localhost:5173/") → No browser is available`;

const NO_SERVER = `**Tests passed:** 7/7
**Gate could not run:** playwright-cli open http://localhost:5173 → net::ERR_CONNECTION_REFUSED`;

test('an unrunnable check is recognised and its reason captured', () => {
  for (const fb of [NO_BROWSER, NO_SERVER]) {
    const r = parseGateBlocked(fb);
    assert.ok(r && r.blocked, 'should detect');
    assert.match(r.reason, /No browser is available|ERR_CONNECTION_REFUSED/);
  }
});

test('a gate that RAN and failed is NOT diverted — that is the fix loop', () => {
  // The whole risk of this feature: becoming an escape hatch from real failures.
  const real = `**Approved:** no
**Blocking:** 2

### Failures
- testExportPrecision failed: expected 112.1, got 112.09999999999999`;
  assert.equal(parseGateBlocked(real), null);
});

test('prose about being blocked does not trip it', () => {
  const prose = `The build was blocked earlier. A gate could not run in round 2,
but it runs now. Gate could not run: is discussed in the notes.`;
  assert.equal(parseGateBlocked(prose), null);
});

test('the marker is recognised anywhere in the report, not only at the top', () => {
  const late = `## QA\n\nRan the suite.\n\n**Gate could not run:** xcodebuild → simulator unreachable\n\nDone.`;
  assert.match(parseGateBlocked(late).reason, /simulator unreachable/);
});

test('a marker with no reason is not actionable and is ignored', () => {
  assert.equal(parseGateBlocked('**Gate could not run:**   '), null);
});

test('empty and missing feedback are safe', () => {
  for (const v of ['', null, undefined]) assert.equal(parseGateBlocked(v), null);
});

// ── the marker written as a filled-in field ──────────────────────────────────
//
// Agents treat the marker as a FIELD rather than a line to omit, and fill it
// with a negative. Seen live 2026-09-13 in a real run: the suite executed
// fully, 664/665 passed, one genuine blocking finding — exactly the case the
// fix loop exists for — and the run could not advance because of this:
const N_A_ALONGSIDE_A_REAL_FINDING = `**Tests passed:** 664/665
**Approved:** no
**Blocking:** 1
**Gate could not run:** N/A — suite executed fully; no environment blockers.`;

test('a negative written into the marker does not block the run', () => {
  assert.equal(parseGateBlocked(N_A_ALONGSIDE_A_REAL_FINDING), null,
    'the agent certified the environment as fine — that must route to the fix loop, not to the owner');
});

test('the common ways an agent writes "nothing blocked" all read as absent', () => {
  for (const reason of ['N/A', 'n/a', 'na', 'none', 'None.', 'nothing', 'null',
                        'no', '-', '--', '—', 'N/A — everything ran', 'none: all checks executed']) {
    assert.equal(parseGateBlocked(`**Gate could not run:** ${reason}`), null,
      `"${reason}" should not block`);
  }
});

// The expensive direction. A swallowed REAL blocker is worse than a false one:
// the run proceeds into a fix loop against a broken environment, which is the
// exact failure this module was written to prevent. These must keep blocking
// even though each begins with a word that appears in the negative list.
test('a real blocker that merely STARTS with a negative word still blocks', () => {
  for (const reason of [
    'no browser is available',
    'No simulator matching the pinned id is in the device list',
    'nothing was listening on port 4000',
    'none of the three services came up',
  ]) {
    const got = parseGateBlocked(`**Gate could not run:** ${reason}`);
    assert.ok(got && got.blocked, `"${reason}" must still block`);
    assert.equal(got.reason, reason);
  }
});
