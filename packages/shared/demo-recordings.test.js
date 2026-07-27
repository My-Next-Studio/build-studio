const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the real ~/.build-studio by pointing HOME at a fresh temp dir
// BEFORE requiring the module (constants.js reads os.homedir() at require time).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-demo-rec-'));
process.env.HOME = tmpHome;
delete process.env.DEMO_RECORDINGS_DIR;

const demoRec = require('./demo-recordings');

test('commonParent: shared prefix of sibling paths', () => {
  assert.equal(demoRec.commonParent(['/a/b/c', '/a/b/d']), '/a/b');
  assert.equal(demoRec.commonParent(['/a/b']), '/a/b');
  assert.equal(demoRec.commonParent([]), null);
  assert.equal(demoRec.commonParent(['/a/b', '/x/y']), null);
});

test('env var wins over everything', () => {
  demoRec.setConfiguredDir('/some/configured/dir');
  process.env.DEMO_RECORDINGS_DIR = '/env/override';
  assert.equal(demoRec.resolveDemoRecordingsDir(), '/env/override');
  assert.equal(demoRec.resolveDemoRecordingsInfo().source, 'env');
  delete process.env.DEMO_RECORDINGS_DIR;
  demoRec.setConfiguredDir(null);
});

test('configured setting is used and expands ~', () => {
  demoRec.setConfiguredDir('~/demos-here');
  assert.equal(demoRec.getConfiguredDir(), path.join(tmpHome, 'demos-here'));
  assert.equal(demoRec.resolveDemoRecordingsDir(), path.join(tmpHome, 'demos-here'));
  const info = demoRec.resolveDemoRecordingsInfo();
  assert.equal(info.source, 'config');
  assert.equal(info.configured, '~/demos-here'); // raw value preserved
});

test('clearing the setting falls back to the ~/Movies default (no projects registered)', () => {
  demoRec.setConfiguredDir('');
  assert.equal(demoRec.getConfiguredDir(), null);
  assert.equal(demoRec.resolveDemoRecordingsDir(), path.join(tmpHome, 'Movies', 'build-studio-demos'));
  assert.equal(demoRec.resolveDemoRecordingsInfo().source, 'default');
});
