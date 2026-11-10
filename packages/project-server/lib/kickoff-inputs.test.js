'use strict';

// The guide to docs/inputs/ that kickoff prompts carry (lib/kickoff-inputs.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeInputs, inputsGuide, LONG_INPUT_LINES } = require('./kickoff-inputs');

function inputsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-inputs-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// A .docx is a zip: binary, with NUL bytes early on.
const DOCX = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64), Buffer.from('word/document.xml')]);
const longBrief = Array.from({ length: 4200 }, (_, i) => `Line ${i + 1} of the brief, with some words to give it width.`).join('\n') + '\n';

test('names the read-first file, and says to follow it', () => {
  const dir = inputsDir({ '00 - Read First.md': '# Read first\n', 'Brief.md': 'short\n' });
  try {
    const g = inputsGuide(dir);
    assert.match(g, /Read `docs\/inputs\/00 - Read First\.md` first/);
    assert.match(g, /which file governs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recognises the common index names, and nothing else', () => {
  const { READ_FIRST_NAME } = require('./kickoff-inputs');
  for (const n of ['00 - Read First.md', 'README.md', 'readme.txt', 'Read first.md', 'index.md', 'Start here.md', '0_overview.md']) {
    assert.ok(READ_FIRST_NAME.test(n), n);
  }
  for (const n of ['Kickoff Brief.md', 'Reading list.md', '10 - Notes.md', 'indexing-plan.md']) {
    assert.ok(!READ_FIRST_NAME.test(n), n);
  }
});

test('a long brief is read in chunks, to the end', () => {
  const dir = inputsDir({ 'Kickoff Brief.md': longBrief });
  try {
    const [e] = describeInputs(dir);
    assert.equal(e.lines, 4200);
    assert.ok(e.long);
    assert.ok(e.chunkLines >= 100 && e.chunkLines <= 1000, String(e.chunkLines));
    const g = inputsGuide(dir);
    assert.match(g, /4,200 lines/);
    assert.match(g, new RegExp(`consecutive chunks of about ${e.chunkLines} lines, to the last line`));
    assert.match(g, /which long files you read to the end/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a short file is simply read in full', () => {
  const dir = inputsDir({ 'Note.md': 'a\nb\n' });
  try {
    const [e] = describeInputs(dir);
    assert.equal(e.lines, 2);
    assert.ok(!e.long);
    assert.ok(e.lines < LONG_INPUT_LINES);
    assert.match(inputsGuide(dir), /`docs\/inputs\/Note\.md` \| 2 lines, 1 KB \| Read in full\. \|/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a .docx is flagged as unreadable, never as the read-first file', () => {
  const dir = inputsDir({ '00 Vision.docx': DOCX, 'Brief.md': 'x\n' });
  try {
    const docx = describeInputs(dir).find((e) => e.file.endsWith('.docx'));
    assert.equal(docx.kind, 'unreadable');
    assert.equal(docx.readFirst, false);
    const g = inputsGuide(dir);
    assert.match(g, /Cannot be read as text\. Do not guess at its contents/);
    assert.match(g, /which files you could not read/);
    assert.doesNotMatch(g, /first: it describes/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PDFs and images are readable; hidden files are skipped; subfolders are walked', () => {
  const dir = inputsDir({
    'spec.pdf': Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(16)]),
    '.DS_Store': Buffer.alloc(8),
    'refs/screen.png': Buffer.concat([Buffer.from('\x89PNG'), Buffer.alloc(16)]),
  });
  try {
    const files = describeInputs(dir);
    assert.deepEqual(files.map((f) => [f.file, f.kind]), [['refs/screen.png', 'readable-binary'], ['spec.pdf', 'readable-binary']]);
    assert.doesNotMatch(inputsGuide(dir), /could not read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('files the kickoff writes are marked as such', () => {
  const dir = inputsDir({ 'owner-interview.md': '# Interview\n' });
  try {
    assert.match(inputsGuide(dir), /owner-interview\.md` \(written during this kickoff\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an empty or missing folder gives no guide', () => {
  const dir = inputsDir({});
  try {
    assert.equal(inputsGuide(dir), '');
    assert.equal(inputsGuide(path.join(dir, 'missing')), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
