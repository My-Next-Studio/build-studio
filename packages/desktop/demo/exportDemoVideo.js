#!/usr/bin/env node
// Demo Recording — export helper (standalone, run OUTSIDE the app).
//
//   node packages/desktop/demo/exportDemoVideo.js <recording-dir> [options]
//
// Reads <recording-dir>/manifest.json and produces, with ffmpeg:
//   • manual-segments.mp4      — the smooth manual window-video segments
//   • automation-timelapse.mp4 — the low-frequency screenshot timelapse(s)
//   • combined-demo-draft.mp4  — everything stitched in timeline order
//   • chapters.txt             — YouTube chapter markers from the phase events
//
// Output is H.264 / 1920x1080 / 30fps / yuv420p (req 7) — ready for a YouTube
// edit pass (cut, speed-ramp, add voiceover/text).
//
// Options:
//   --timelapse-fps <n>  stills/sec for the timelapse (default 20; higher = faster)
//   --fps <n>            output frame rate (default 30)
//   --keep-intermediates keep the per-segment ._build/ files
//   --ffmpeg <path>      ffmpeg binary (default: $FFMPEG or "ffmpeg")

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = { dir: null, timelapseFps: 20, fps: 30, keep: false, ffmpeg: process.env.FFMPEG || 'ffmpeg' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timelapse-fps') args.timelapseFps = Number(argv[++i]);
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--keep-intermediates') args.keep = true;
    else if (a === '--ffmpeg') args.ffmpeg = argv[++i];
    else if (!a.startsWith('--')) args.dir = a;
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.dir) {
  console.error('Usage: node exportDemoVideo.js <recording-dir> [--timelapse-fps 20] [--fps 30] [--keep-intermediates]');
  process.exit(1);
}
const DIR = path.resolve(args.dir);
const manifestPath = path.join(DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`No manifest.json in ${DIR}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const ffmpeg = args.ffmpeg;
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

const W = manifest.output?.width || 1920;
const H = manifest.output?.height || 1080;
const FPS = args.fps;
const VF = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;

const buildDir = path.join(DIR, '._build');
fs.mkdirSync(buildDir, { recursive: true });

function run(bin, argv) {
  const res = spawnSync(bin, argv, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${path.basename(bin)} failed (${res.status}):\n${(res.stderr || '').split('\n').slice(-12).join('\n')}`);
  }
  return res.stdout;
}

function probeDuration(file) {
  try {
    const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : 0;
  } catch { return 0; }
}

function encodeManual(seg, outFile) {
  const src = path.join(DIR, seg.file);
  if (!fs.existsSync(src) || fs.statSync(src).size < 1024) return false;
  run(ffmpeg, ['-y', '-i', src, '-vf', VF, '-r', String(FPS), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outFile]);
  return true;
}

function encodeAutomation(seg, outFile) {
  const segDir = path.join(DIR, seg.dir);
  if (!fs.existsSync(segDir)) return false;
  const frames = fs.readdirSync(segDir).filter((f) => /^frame-\d+\.jpg$/.test(f));
  if (frames.length === 0) return false;
  run(ffmpeg, [
    '-y', '-framerate', String(args.timelapseFps),
    '-i', path.join(segDir, 'frame-%06d.jpg'),
    '-vf', VF, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outFile,
  ]);
  return true;
}

function concat(files, outFile) {
  if (files.length === 0) return false;
  if (files.length === 1) { fs.copyFileSync(files[0], outFile); return true; }
  const listFile = path.join(buildDir, `concat-${path.basename(outFile)}.txt`);
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile]);
  return true;
}

// ── Encode each segment in timeline order ────────────────────────────────────
const segments = [...(manifest.segments || [])].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
const built = []; // { seg, file, outStart, outDur }
let timelineOut = 0;

console.log(`Exporting ${segments.length} segment(s) from ${DIR}`);
for (let i = 0; i < segments.length; i++) {
  const seg = segments[i];
  const outFile = path.join(buildDir, `seg-${String(i).padStart(3, '0')}-${seg.kind}.mp4`);
  let ok = false;
  try {
    ok = seg.kind === 'manual' ? encodeManual(seg, outFile) : encodeAutomation(seg, outFile);
  } catch (e) {
    console.warn(`  segment ${i} (${seg.kind}) failed: ${e.message}`);
  }
  if (!ok) { console.log(`  segment ${i} (${seg.kind}): skipped (no usable frames/video)`); continue; }
  const dur = probeDuration(outFile);
  built.push({ seg, file: outFile, outStart: timelineOut, outDur: dur });
  timelineOut += dur;
  console.log(`  segment ${i} (${seg.kind}): ${dur.toFixed(1)}s`);
}

if (built.length === 0) {
  console.error('Nothing to export — no usable segments.');
  process.exit(1);
}

// ── Assemble the three deliverables ──────────────────────────────────────────
const manualFiles = built.filter((b) => b.seg.kind === 'manual').map((b) => b.file);
const autoFiles = built.filter((b) => b.seg.kind === 'automation').map((b) => b.file);
const allFiles = built.map((b) => b.file);

if (concat(manualFiles, path.join(DIR, 'manual-segments.mp4'))) console.log('✓ manual-segments.mp4');
if (concat(autoFiles, path.join(DIR, 'automation-timelapse.mp4'))) console.log('✓ automation-timelapse.mp4');
if (concat(allFiles, path.join(DIR, 'combined-demo-draft.mp4'))) console.log('✓ combined-demo-draft.mp4');

// ── chapters.txt — map wall-clock phase events onto the combined timeline ────
function wallToOut(elapsedMs) {
  // Find the segment whose wall-clock window contains this event, then map
  // proportionally into that segment's output duration.
  for (const b of built) {
    const sStart = b.seg.startElapsedMs ?? 0;
    const sEnd = b.seg.endElapsedMs ?? (sStart + (b.outDur * 1000));
    if (elapsedMs >= sStart && elapsedMs <= sEnd && sEnd > sStart) {
      const frac = (elapsedMs - sStart) / (sEnd - sStart);
      return b.outStart + frac * b.outDur;
    }
  }
  // Before/after any segment → clamp to nearest edge.
  if (built.length && elapsedMs < (built[0].seg.startElapsedMs ?? 0)) return 0;
  return timelineOut;
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

const CHAPTER_TYPES = new Set(['phase', 'step', 'result', 'system']);
const seen = new Set();
const chapters = [];
for (const ev of manifest.events || []) {
  if (!CHAPTER_TYPES.has(ev.type)) continue;
  const at = wallToOut(ev.elapsedMs || 0);
  const ts = fmt(at);
  if (seen.has(ts)) continue; // YouTube requires unique, increasing timestamps
  seen.add(ts);
  chapters.push({ at, line: `${ts} ${prettyLabel(ev.label)}` });
}
chapters.sort((a, b) => a.at - b.at);
// YouTube needs the first chapter at 00:00.
if (chapters.length && !chapters[0].line.startsWith('00:00')) chapters.unshift({ at: 0, line: '00:00 Intro' });
fs.writeFileSync(path.join(DIR, 'chapters.txt'), chapters.map((c) => c.line).join('\n') + '\n');
console.log(`✓ chapters.txt (${chapters.length} markers)`);

function prettyLabel(label) {
  return String(label)
    .replace(/[:_]/g, ' ')
    .replace(/\bpct\b/, '%')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

if (!args.keep) fs.rmSync(buildDir, { recursive: true, force: true });
console.log(`\nDone → ${DIR}`);
