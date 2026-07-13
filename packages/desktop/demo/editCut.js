#!/usr/bin/env node
// Demo Recording — Step 2: apply timestamped speed edits to an EDL.
//
//   node packages/desktop/demo/editCut.js <edl.json> <edits.json> [--render]
//
// edits.json is a list of speed adjustments against the CURRENT cut's output
// timeline, e.g.:
//   [ { "from": 15, "to": 60, "factor": 2,   "note": "speed up" },
//     { "from": 160,"to": 164,"factor": 0.5, "note": "linger" } ]
// factor > 1 speeds a range up, < 1 slows it down. Clips are split at the
// boundaries; sources are never modified. Writes the next edl.vN.json (and, with
// --render, the matching rough-cut.vN.mp4 + chapters).

const fs = require('fs');
const path = require('path');
const { applyEdits, renderEdl, writeChapters } = require('./edl');

function parseArgs(argv) {
  const a = { edl: null, edits: null, render: false, ffmpeg: process.env.FFMPEG || 'ffmpeg', out: null };
  const pos = [];
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--render') a.render = true;
    else if (x === '--ffmpeg') a.ffmpeg = argv[++i];
    else if (x === '--out') a.out = argv[++i];
    else if (!x.startsWith('--')) pos.push(x);
  }
  a.edl = pos[0]; a.edits = pos[1];
  return a;
}

function nextVersion(dir) {
  let n = 1;
  while (fs.existsSync(path.join(dir, `edl.v${n}.json`)) || fs.existsSync(path.join(dir, `rough-cut.v${n}.mp4`))) n++;
  return n;
}

const args = parseArgs(process.argv);
if (!args.edl || !args.edits) { console.error('Usage: node editCut.js <edl.json> <edits.json> [--render]'); process.exit(1); }
const edlPath = path.resolve(args.edl);
const edl = JSON.parse(fs.readFileSync(edlPath, 'utf8'));
const edits = JSON.parse(fs.readFileSync(path.resolve(args.edits), 'utf8'));
const dir = path.dirname(edlPath);

const next = applyEdits(edl, edits);
const version = nextVersion(dir);
next.version = version;
const outEdl = args.out ? path.resolve(args.out) : path.join(dir, `edl.v${version}.json`);
fs.writeFileSync(outEdl, JSON.stringify(next, null, 2));

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`Applied ${edits.length} edits → ${path.basename(outEdl)}`);
console.log(`  clips ${edl.clips.length} → ${next.clips.length}, projected ${fmt(next.projectedTotalSec)}`);

if (args.render) {
  const outMp4 = path.join(dir, `rough-cut.v${version}.mp4`);
  console.log(`Rendering ${path.basename(outMp4)}…`);
  const actual = renderEdl(dir, next, outMp4, { ffmpeg: args.ffmpeg });
  const nCh = writeChapters(next, path.join(dir, `chapters.v${version}.txt`));
  console.log(`\n✓ ${path.basename(outMp4)}  (${fmt(actual)}, ${nCh} chapters)`);
} else {
  console.log(`  render with: node renderEdl.js ${path.basename(outEdl)}`);
}
