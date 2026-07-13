#!/usr/bin/env node
// Demo Recording — Step 2 hook: render an (edited) EDL.
//
//   node packages/desktop/demo/renderEdl.js <edl.json> [--out file.mp4] [--ffmpeg path]
//
// After watching a rough cut you (or I) tweak the EDL — change a clip's `speed`,
// set `inSec`/`outSec` to trim, reorder/drop/duplicate clips, fix a `label` —
// then re-render here. The recording dir is inferred from the EDL's location.
// Sources are read-only, so every version is reproducible and reversible.

const fs = require('fs');
const path = require('path');
const { renderEdl, writeChapters, probeDuration } = require('./edl');

function parseArgs(argv) {
  const a = { edl: null, out: null, ffmpeg: process.env.FFMPEG || 'ffmpeg', crf: 20, preset: 'veryfast' };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--out') a.out = argv[++i];
    else if (x === '--crf') a.crf = Number(argv[++i]);
    else if (x === '--preset') a.preset = argv[++i];
    else if (x === '--ffmpeg') a.ffmpeg = argv[++i];
    else if (!x.startsWith('--')) a.edl = x;
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.edl) { console.error('Usage: node renderEdl.js <edl.json> [--out file.mp4]'); process.exit(1); }
const edlPath = path.resolve(args.edl);
if (!fs.existsSync(edlPath)) { console.error(`No EDL at ${edlPath}`); process.exit(1); }
const edl = JSON.parse(fs.readFileSync(edlPath, 'utf8'));
const dir = path.dirname(edlPath);

const base = path.basename(edlPath).replace(/^edl\./, '').replace(/\.json$/, '') || 'edit';
const outPath = args.out ? path.resolve(args.out) : path.join(dir, `rough-cut.${base}.mp4`);

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`Rendering ${edl.clips.length} clips from ${path.basename(edlPath)}…`);
const actual = renderEdl(dir, edl, outPath, { ffmpeg: args.ffmpeg, crf: args.crf, preset: args.preset });
const nCh = writeChapters(edl, path.join(dir, `chapters.${base}.txt`));
console.log(`\n✓ ${path.basename(outPath)}  (${fmt(actual)}, ${nCh} chapters)`);
