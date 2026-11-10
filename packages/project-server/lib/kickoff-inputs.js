'use strict';

/**
 * How to read docs/inputs/: a short guide built from the folder itself, put
 * into every prompt that reads the inputs.
 *
 * "Read all files in docs/inputs/" was the whole instruction. It breaks in three
 * ways on real inputs:
 *   - a brief of several thousand lines does not fit one read, and an agent that
 *     reads the first chunk tends to stop there, missing the chapters that come
 *     last;
 *   - a folder can hold an index file (a "read first") that says which file
 *     governs where they disagree, and nothing pointed agents at it;
 *   - binary files such as .docx cannot be read as text, and an agent that
 *     cannot open one guesses at it from its name.
 *
 * The guide names the read-first file when there is one, gives each file's size
 * and how to read it, and lists the files that cannot be read so agents report
 * them instead of guessing.
 */

const fs = require('fs');
const path = require('path');

/** Above either limit a file is "long": read in chunks, to the end. */
const LONG_INPUT_LINES = 1000;
const LONG_INPUT_BYTES = 40 * 1024;
/** Target size of one chunk, so each read stays well inside a CLI's read limit. */
const CHUNK_TARGET_BYTES = 40 * 1024;

/** Binary formats an agent CLI can read natively. */
const READABLE_BINARY = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** An index file by its name: "00 - Read First.md", "README.md", "index.md", "Start here.md". */
const READ_FIRST_NAME = /^(?:0+[\s._-]|read[\s._-]*(?:me[\s._-]*)?first\b|readme\b|index\b|start[\s._-]*here\b)/i;

/** Files Build Studio itself writes into docs/inputs/ during kickoff. */
const GENERATED = /^(?:owner-interview\.md|owner-consultation-round-\d+\.md)$/;

const MAX_ROWS = 60;

function listFiles(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // .DS_Store, .gitkeep
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** A NUL byte in the first 8 KB means binary (a .docx is a zip, for one). */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Describe each file in `inputsDir`.
 * @returns {{ file: string, bytes: number, kind: 'text'|'readable-binary'|'unreadable', lines?: number,
 *             long?: boolean, chunkLines?: number, readFirst: boolean, generated: boolean }[]}
 */
function describeInputs(inputsDir) {
  return listFiles(inputsDir).map((file) => {
    const abs = path.join(inputsDir, file);
    const base = path.basename(file);
    const entry = { file, bytes: 0, kind: 'text', readFirst: READ_FIRST_NAME.test(base), generated: GENERATED.test(base) };
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return { ...entry, kind: 'unreadable' }; }
    entry.bytes = buf.length;
    if (READABLE_BINARY.has(path.extname(base).toLowerCase())) return { ...entry, kind: 'readable-binary', readFirst: false };
    if (looksBinary(buf)) return { ...entry, kind: 'unreadable', readFirst: false };
    const text = buf.toString('utf8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const long = lines > LONG_INPUT_LINES || buf.length > LONG_INPUT_BYTES;
    const avg = lines > 0 ? buf.length / lines : 1;
    const chunkLines = long ? Math.max(100, Math.min(1000, Math.floor(CHUNK_TARGET_BYTES / avg / 100) * 100)) : undefined;
    return { ...entry, lines, long, ...(long ? { chunkLines } : {}) };
  });
}

function kb(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function howToRead(e) {
  if (e.kind === 'unreadable') return 'Cannot be read as text. Do not guess at its contents from its name: list it in your feedback as unread.';
  if (e.kind === 'readable-binary') return 'Read in full.';
  if (e.long) return `Long: read all of it in consecutive chunks of about ${e.chunkLines} lines, to the last line. Do not stop after the first chunks; what governs scope can come last.`;
  return 'Read in full.';
}

/**
 * The guide, as prompt text. `inputsRel` is how agents name the folder.
 * Empty string when the folder has no files.
 */
function inputsGuide(inputsDir, inputsRel = 'docs/inputs') {
  const files = describeInputs(inputsDir);
  if (files.length === 0) return '';
  const readFirst = files.filter((f) => f.readFirst && f.kind === 'text');
  const shown = files.slice(0, MAX_ROWS);
  const rows = shown.map((e) => {
    const size = e.kind === 'text' ? `${e.lines.toLocaleString('en-US')} lines, ${kb(e.bytes)}` : kb(e.bytes);
    const note = e.generated ? ' (written during this kickoff)' : '';
    return `| \`${inputsRel}/${e.file}\`${note} | ${size} | ${howToRead(e)} |`;
  });
  const parts = ['## How to read the inputs', ''];
  if (readFirst.length) {
    const names = readFirst.map((f) => `\`${inputsRel}/${f.file}\``).join(' and ');
    parts.push(`Read ${names} first: it describes the other inputs. Follow what it says about which file governs where they disagree, and about what this kickoff must and must not do.`, '');
  }
  parts.push('| File | Size | How to read it |', '|---|---|---|', ...rows);
  if (files.length > shown.length) parts.push('', `…and ${files.length - shown.length} more files in \`${inputsRel}/\`.`);
  const long = files.filter((f) => f.long).length;
  const unreadable = files.filter((f) => f.kind === 'unreadable').length;
  if (long || unreadable) {
    parts.push('', `In your feedback, say ${[long ? 'which long files you read to the end' : '', unreadable ? 'which files you could not read' : ''].filter(Boolean).join(' and ')}.`);
  }
  return parts.join('\n');
}

module.exports = {
  describeInputs, inputsGuide,
  LONG_INPUT_LINES, LONG_INPUT_BYTES, READ_FIRST_NAME,
};
