// Demo Recording — Edit Decision List (EDL): plan + render.
//
// An EDL is an ordered list of clips that reference the UNTOUCHED source
// (manual webm segments + automation timelapse frame dirs) with per-clip
// in/out, speed, and fps. Rendering reads the EDL + sources → a new mp4.
// Nothing in the recording folder's source media is ever modified, so you can
// regenerate / re-cut endlessly (Step 1 auto-plan, Step 2 comment-driven edits).
//
// Pure ffmpeg + Node. Used by roughCut.js (Step 1) and renderEdl.js (Step 2).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT_W = 1920, OUT_H = 1080, OUT_FPS = 30;
// Letterbox/pad any source (manual is ~2461x1301, frames vary) to clean 1080p.
function vfBase(w = OUT_W, h = OUT_H) {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;
}

function round(n, p = 1) { const f = 10 ** p; return Math.round(n * f) / f; }
function pad(n, w = 3) { return String(n).padStart(w, '0'); }

function run(bin, argv) {
  const res = spawnSync(bin, argv, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (res.status !== 0) {
    throw new Error(`${path.basename(bin)} failed (${res.status}):\n${(res.stderr || '').split('\n').slice(-15).join('\n')}`);
  }
  return res.stdout;
}

// MediaRecorder webm carries no duration header (live stream) → ffprobe reports
// 0. Decode to null and read the last reported timestamp for the true duration.
function probeDurationDecode(ffmpeg, file) {
  const res = spawnSync(ffmpeg, ['-i', file, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const out = (res.stderr || '') + (res.stdout || '');
  const ms = [...out.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!ms.length) return 0;
  const m = ms[ms.length - 1];
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function probeDuration(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  try {
    const out = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : 0;
  } catch { return 0; }
}

function prettyLabel(label) {
  return String(label || '')
    .replace(/^(step_started:|agent_started:|agent_completed:)/, '')
    .replace(/[:_]/g, ' ').replace(/\bpct\b/, '%').replace(/\s+/g, ' ').trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

// Nearest phase/step/result marker at or before a segment's start — used to
// label clips (chapters + a handle for Step 2 comments / Step 3 narration).
function labelAt(manifest, elapsedMs) {
  const cands = (manifest.events || []).filter(
    (e) => ['phase', 'step', 'result'].includes(e.type) && (e.elapsedMs || 0) <= elapsedMs + 500
  );
  if (!cands.length) return null;
  const last = cands[cands.length - 1];
  return prettyLabel(last.label);
}

/**
 * Step 1 planner: build an EDL that targets `target` seconds.
 * Manual (interactive) gets `manualShare` of the budget via a uniform speed
 * ramp (clamped to manualMaxSpeed); automation timelapse frames get the rest
 * via a computed playback fps (clamped to a sane range).
 */
function buildAutoEdl(dir, manifest, opts = {}) {
  const { target = 300, manualShare = 0.6, manualMaxSpeed = 6, autoFpsMin = 8, autoFpsMax = 48, ffmpeg = 'ffmpeg' } = opts;
  const segs = [...(manifest.segments || [])].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

  let manualTotal = 0, autoFrames = 0;
  const measured = segs.map((s) => {
    if (s.kind === 'manual') {
      const src = path.join(dir, s.file);
      const dur = fs.existsSync(src) ? probeDurationDecode(ffmpeg, src) : 0;
      manualTotal += dur;
      return { ...s, realDur: dur };
    }
    const segDir = path.join(dir, s.dir);
    const frames = fs.existsSync(segDir) ? fs.readdirSync(segDir).filter((f) => /^frame-\d+\.jpg$/.test(f)).length : 0;
    autoFrames += frames;
    return { ...s, frames };
  });

  const manualBudget = target * manualShare;
  const autoBudget = target * (1 - manualShare);
  let manualSpeed = manualTotal > 0 ? Math.max(1, manualTotal / manualBudget) : 1;
  manualSpeed = Math.min(manualSpeed, manualMaxSpeed);
  let autoFps = autoFrames > 0 ? autoFrames / autoBudget : 24;
  autoFps = Math.min(Math.max(autoFps, autoFpsMin), autoFpsMax);

  const clips = [];
  for (const m of measured) {
    if (m.kind === 'manual') {
      if (!m.realDur || m.realDur < 0.2) continue; // drop empty/aborted segments
      clips.push({
        kind: 'manual', source: m.file, sourceDurationSec: round(m.realDur),
        inSec: 0, outSec: round(m.realDur), speed: round(manualSpeed, 2),
        outDurationSec: round(m.realDur / manualSpeed), label: labelAt(manifest, m.startElapsedMs) || 'Working in the dashboard',
      });
    } else {
      if (!m.frames) continue;
      clips.push({
        kind: 'automation', source: m.dir, frameCount: m.frames,
        captureIntervalSec: m.intervalSec, fps: round(autoFps, 2),
        outDurationSec: round(m.frames / autoFps),
        label: labelAt(manifest, m.startElapsedMs) || `${m.workflowType || 'Automation'} running`,
      });
    }
  }

  const projectedTotalSec = round(clips.reduce((a, c) => a + c.outDurationSec, 0));
  return {
    version: null, kind: 'rough-cut', recording: path.basename(dir),
    target, manualSpeed: round(manualSpeed, 2), autoFps: round(autoFps, 2),
    sourceManualSec: round(manualTotal), sourceAutoFrames: autoFrames,
    projectedTotalSec, output: { width: OUT_W, height: OUT_H, fps: OUT_FPS },
    clips,
  };
}

// Build a sub-clip of `c` covering output offsets [o1,o2] (within the clip)
// with its speed/fps multiplied by `factor` (>1 faster, <1 slower).
function subClip(c, o1, o2, factor) {
  if (c.kind === 'manual') {
    const baseSpeed = c.speed || 1, baseIn = c.inSec || 0;
    const srcIn = baseIn + o1 * baseSpeed, srcOut = baseIn + o2 * baseSpeed;
    const speed = round(baseSpeed * factor, 3);
    return {
      kind: 'manual', source: c.source, sourceDurationSec: c.sourceDurationSec,
      inSec: round(srcIn, 3), outSec: round(srcOut, 3), speed,
      outDurationSec: round((srcOut - srcIn) / speed, 3), label: c.label,
    };
  }
  const baseFps = c.fps, f0 = c.startFrame || 1;
  const startFrame = Math.round(f0 + o1 * baseFps);
  const frameCount = Math.max(1, Math.round((o2 - o1) * baseFps));
  const fps = round(baseFps * factor, 3);
  return {
    kind: 'automation', source: c.source, startFrame, frameCount,
    captureIntervalSec: c.captureIntervalSec, fps,
    outDurationSec: round(frameCount / fps, 3), label: c.label,
  };
}

/**
 * Step 2: apply speed edits expressed against the CURRENT output timeline.
 * edits: [{ from, to, factor, note? }] in output seconds (factor >1 speeds up,
 * <1 slows down). Clips are split at edit boundaries; unaffected spans pass
 * through at factor 1. Reads/writes only the EDL — sources are untouched.
 */
function applyEdits(edl, edits) {
  const out = { ...edl, version: null, kind: 'edit', basedOn: edl.version, clips: [] };
  let t = 0;
  for (const c of edl.clips) {
    const dur = c.outDurationSec || 0;
    const start = t, end = t + dur; t = end;
    const local = [];
    const bounds = new Set([0, dur]);
    for (const e of edits) {
      const a = Math.max(e.from, start), b = Math.min(e.to, end);
      if (b - a > 0.05) { const la = a - start, lb = b - start; bounds.add(la); bounds.add(lb); local.push({ a: la, b: lb, factor: e.factor }); }
    }
    const pts = [...bounds].filter((x) => x >= -1e-6 && x <= dur + 1e-6).sort((x, y) => x - y);
    for (let i = 0; i < pts.length - 1; i++) {
      const o1 = pts[i], o2 = pts[i + 1];
      if (o2 - o1 < 0.03) continue;
      const mid = (o1 + o2) / 2;
      const ed = local.find((e) => mid >= e.a && mid <= e.b);
      out.clips.push(subClip(c, o1, o2, ed ? ed.factor : 1));
    }
  }
  out.projectedTotalSec = round(out.clips.reduce((a, c) => a + (c.outDurationSec || 0), 0));
  return out;
}

/** Render an EDL to outPath. Reads only source media under `dir`. */
function renderEdl(dir, edl, outPath, opts = {}) {
  const { ffmpeg = 'ffmpeg', keep = false, crf = 20, preset = 'veryfast' } = opts;
  const fps = (edl.output && edl.output.fps) || OUT_FPS;
  const w = (edl.output && edl.output.width) || OUT_W;
  const h = (edl.output && edl.output.height) || OUT_H;
  const VF = vfBase(w, h);
  const build = path.join(dir, '._roughcut_build');
  fs.mkdirSync(build, { recursive: true });

  const parts = [];
  edl.clips.forEach((c, i) => {
    const out = path.join(build, `clip-${pad(i)}.mp4`);
    if (c.kind === 'manual') {
      const src = path.join(dir, c.source);
      if (!fs.existsSync(src)) { console.warn(`  skip ${c.source} (missing)`); return; }
      const speed = c.speed || 1;
      // Source-time window via input seek (-ss) + duration (-t), both before -i
      // so trimming happens in SOURCE time, then setpts applies the speed.
      const inSec = c.inSec || 0;
      const len = (c.outSec != null ? c.outSec : (c.sourceDurationSec || 0)) - inSec;
      const lenArg = len > 0 ? ['-t', String(round(len, 3))] : [];
      run(ffmpeg, [
        '-y', '-fflags', '+genpts', '-ss', String(round(inSec, 3)), ...lenArg, '-i', src,
        '-vf', `setpts=(PTS-STARTPTS)/${speed},${VF}`, '-an', '-r', String(fps),
        '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', out,
      ]);
    } else {
      const segDir = path.join(dir, c.source);
      if (!fs.existsSync(segDir)) { console.warn(`  skip ${c.source} (missing)`); return; }
      // Frame window: start at startFrame, keep frameCount frames, timed at fps.
      const startFrame = c.startFrame || 1;
      const fc = c.frameCount || 0;
      const selectVf = fc > 0 ? `select='lt(n\\,${fc})',setpts=N/${c.fps}/TB,` : '';
      run(ffmpeg, [
        '-y', '-framerate', String(c.fps), '-start_number', String(startFrame),
        '-i', path.join(segDir, 'frame-%06d.jpg'),
        '-vf', `${selectVf}${VF}`, '-r', String(fps),
        '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', out,
      ]);
    }
    parts.push(out);
  });

  if (!parts.length) throw new Error('EDL produced no renderable clips');
  if (parts.length === 1) {
    fs.copyFileSync(parts[0], outPath);
  } else {
    const list = path.join(build, 'concat.txt');
    fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outPath]);
  }
  if (!keep) fs.rmSync(build, { recursive: true, force: true });
  return probeDuration(ffmpeg, outPath);
}

/** YouTube-style chapters from EDL clip labels, on the OUTPUT timeline. */
function writeChapters(edl, chaptersPath) {
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
  };
  const lines = [];
  const seen = new Set();
  let t = 0, lastLabel = null;
  for (const c of edl.clips) {
    const ts = fmt(t);
    if (c.label && c.label !== lastLabel && !seen.has(ts)) {
      lines.push(`${ts} ${c.label}`); seen.add(ts); lastLabel = c.label;
    }
    t += c.outDurationSec || 0;
  }
  if (lines.length && !lines[0].startsWith('00:00')) lines.unshift('00:00 Intro');
  fs.writeFileSync(chaptersPath, lines.join('\n') + '\n');
  return lines.length;
}

module.exports = { buildAutoEdl, applyEdits, renderEdl, writeChapters, probeDuration, probeDurationDecode, round };
