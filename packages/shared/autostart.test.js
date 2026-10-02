'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const autostart = require('./autostart');

const P = (name) => ({ name, path: `/projects/${name}` });
const projects = ['a', 'b', 'c', 'd'].map(P);

test('launch starts active workflows and last session, nothing else', () => {
  const isActive = (p) => p.name === 'c';
  assert.deepEqual(autostart.projectsToAutoStart(projects, { lastSession: ['a'], isActive }), ['a', 'c']);
});

test('with no recorded session only active workflows start', () => {
  const isActive = (p) => p.name === 'd';
  assert.deepEqual(autostart.projectsToAutoStart(projects, { lastSession: null, isActive }), ['d']);
  assert.deepEqual(autostart.projectsToAutoStart(projects, { lastSession: null, isActive: () => false }), []);
});

test('a last-session name no longer in the registry is ignored', () => {
  assert.deepEqual(autostart.projectsToAutoStart(projects, { lastSession: ['gone', 'b'], isActive: () => false }), ['b']);
});

test('quit stops idle running servers and keeps those with an active workflow', () => {
  const isRunning = (p) => p.name !== 'd';
  const isActive = (p) => p.name === 'b';
  assert.deepEqual(autostart.projectsToStopAtQuit(projects, { isRunning, isActive }), ['a', 'c']);
});

test('an active workflow is one whose state is not completed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-'));
  const proj = (name, state) => {
    const dir = path.join(root, name, '.build-studio');
    fs.mkdirSync(dir, { recursive: true });
    if (state !== undefined) fs.writeFileSync(path.join(dir, 'workflow-state.json'), typeof state === 'string' ? state : JSON.stringify(state));
    return path.join(root, name);
  };
  assert.equal(autostart.hasActiveWorkflow(proj('running', { currentStep: 'qa_validation' })), true);
  assert.equal(autostart.hasActiveWorkflow(proj('done', { currentStep: 'completed' })), false);
  assert.equal(autostart.hasActiveWorkflow(proj('none')), false);
  assert.equal(autostart.hasActiveWorkflow(proj('corrupt', '{not json')), false);
});

test('the last session round-trips, and a missing or bad file reads as null', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-')), 'last-session.json');
  assert.equal(autostart.readLastSession(file), null);
  autostart.writeLastSession(['fazon', 'launch-studio'], file);
  assert.deepEqual(autostart.readLastSession(file), ['fazon', 'launch-studio']);
  fs.writeFileSync(file, '{"running": "nope"}');
  assert.equal(autostart.readLastSession(file), null);
});
