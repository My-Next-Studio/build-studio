#!/usr/bin/env node
// Demo Recording — Step 1: automated first-pass rough cut.
//
//   node packages/desktop/demo/roughCut.js <recording-dir> [options]
//
// Reads <recording-dir>/manifest.json, plans an EDL that targets ≤5 min
// (manual interactive video speed-ramped; automation runs as timelapse), writes
// a versioned EDL + rough-cut mp4 + chapters. Source clips are never touched —
// re-run any time, or hand the EDL to renderEdl.js for comment-driven re-cuts.
//
// Options:
//   --target <sec>        target duration (default 300 = 5 min)
//   --manual-share <0..1> fraction of the budget for manual video (default 0.6)
//   --manual-max-speed <n> cap on manual speed-up (default 6)
//   --ffmpeg <path>       ffmpeg binary (default: $FFMPEG or "ffmpeg")

const fs = require('fs');
const path = require('path');
const { buildAutoEdl, renderEdl, writeChapters, round } = require('./edl');

function parseArgs(argv) {
  const a = { dir: null, target: 300, manualShare: 0.6, manualMaxSpeed: 6, ffmpeg: process.env.FFMPEG || 'ffmpeg' };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--target') a.target = Number(argv[++i]);
    else if (x === '--manual-share') a.manualShare = Number(argv[++i]);
    else if (x === '--manual-max-speed') a.manualMaxSpeed = Number(argv[++i]);
    else if (x === '--ffmpeg') a.ffmpeg = argv[++i];
    else if (!x.startsWith('--')) a.dir = x;
  }
  return a;
}

function nextVersion(dir) {
  let n = 1;
  while (fs.existsSync(path.join(dir, `rough-cut.v${n}.mp4`)) || fs.existsSync(path.join(dir, `edl.v${n}.json`))) n++;
  return n;
}

const args = parseArgs(process.argv);
if (!args.dir) { console.error('Usage: node roughCut.js <recording-dir> [--target 300] [--manual-share 0.6]'); process.exit(1); }
const dir = path.resolve(args.dir);
const manifestPath = path.join(dir, 'manifest.json');
if (!fs.existsSync(manifestPath)) { console.error(`No manifest.json in ${dir}`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`Planning rough cut for ${path.basename(dir)} (target ${fmt(args.target)})…`);

const edl = buildAutoEdl(dir, manifest, args);
const version = nextVersion(dir);
edl.version = version;

console.log(`  source: manual ${fmt(edl.sourceManualSec)} + ${edl.sourceAutoFrames} timelapse frames`);
console.log(`  plan:   manual ×${edl.manualSpeed} speed, automation @${edl.autoFps}fps`);
console.log(`  clips:  ${edl.clips.length}, projected ${fmt(edl.projectedTotalSec)}`);

const edlPath = path.join(dir, `edl.v${version}.json`);
fs.writeFileSync(edlPath, JSON.stringify(edl, null, 2));

const outPath = path.join(dir, `rough-cut.v${version}.mp4`);
console.log(`Rendering ${path.basename(outPath)}…`);
const actual = renderEdl(dir, edl, outPath, { ffmpeg: args.ffmpeg });

const chaptersPath = path.join(dir, `chapters.v${version}.txt`);
const nCh = writeChapters(edl, chaptersPath);

console.log(`\n✓ ${path.basename(outPath)}  (${fmt(actual)}, ${nCh} chapters)`);
console.log(`  EDL:      ${path.basename(edlPath)}   ← edit + re-render with renderEdl.js (Step 2)`);
console.log(`  chapters: ${path.basename(chaptersPath)}`);
if (actual > args.target * 1.1) console.log(`  note: over target — raise --manual-max-speed or lower --manual-share to tighten.`);
