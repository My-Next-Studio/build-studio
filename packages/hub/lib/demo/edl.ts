// Demo post-production core (server-only — uses fs/child_process).
// Canonical copy for the in-app Demos tab. The `packages/desktop/demo/*.js`
// CLIs are the standalone terminal equivalents (logic mirrored; extract a shared
// package later to dedupe). Never import this from a client component.

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

export const OUT_W = 1920, OUT_H = 1080, OUT_FPS = 30
const FFMPEG = process.env.FFMPEG || 'ffmpeg'

export interface EdlClip {
  kind: 'manual' | 'automation'
  source: string
  // manual
  sourceDurationSec?: number
  inSec?: number
  outSec?: number
  speed?: number
  // automation
  frameCount?: number
  startFrame?: number
  fps?: number
  captureIntervalSec?: number
  outDurationSec: number
  label?: string
}
export interface Edl {
  version: number | null
  kind: string
  recording?: string
  target?: number
  output?: { width: number; height: number; fps: number }
  projectedTotalSec?: number
  clips: EdlClip[]
  [k: string]: unknown
}
export interface Edit { from: number; to: number; factor?: number; cut?: boolean; note?: string }

function vfBase(w = OUT_W, h = OUT_H) {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`
}
const round = (n: number, p = 1) => { const f = 10 ** p; return Math.round(n * f) / f }
const pad = (n: number, w = 6) => String(n).padStart(w, '0')

function run(bin: string, argv: string[]) {
  const res = spawnSync(bin, argv, { encoding: 'utf8', maxBuffer: 1 << 27 })
  if (res.status !== 0) throw new Error(`${path.basename(bin)} failed (${res.status}):\n${(res.stderr || '').split('\n').slice(-12).join('\n')}`)
  return res.stdout
}

export function probeDuration(file: string) {
  const ffprobe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  try {
    const out = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
    const d = parseFloat(out.trim()); return Number.isFinite(d) ? d : 0
  } catch { return 0 }
}
// MediaRecorder webm has no duration header → decode to null and read last ts.
export function probeDurationDecode(file: string) {
  const res = spawnSync(FFMPEG, ['-i', file, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 27 })
  const out = (res.stderr || '') + (res.stdout || '')
  const ms = [...out.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  if (!ms.length) return 0
  const m = ms[ms.length - 1]
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
}

function prettyLabel(label: string) {
  return String(label || '').replace(/^(step_started:|agent_started:|agent_completed:)/, '')
    .replace(/[:_]/g, ' ').replace(/\bpct\b/, '%').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase())
}
function labelAt(manifest: any, elapsedMs: number) {
  const cands = (manifest.events || []).filter((e: any) => ['phase', 'step', 'result'].includes(e.type) && (e.elapsedMs || 0) <= elapsedMs + 500)
  return cands.length ? prettyLabel(cands[cands.length - 1].label) : null
}

const AUTO_INTERVAL_SEC: Record<string, number> = { review: 2, execution: 5, kickoff: 3, onboarding: 3 }

export function buildAutoEdl(dir: string, manifest: any, opts: { target?: number; manualShare?: number; manualMaxSpeed?: number; autoFpsMin?: number; autoFpsMax?: number } = {}): Edl {
  const { target = 300, manualShare = 0.6, manualMaxSpeed = 6, autoFpsMin = 8, autoFpsMax = 48 } = opts
  const segs = [...(manifest.segments || [])].sort((a: any, b: any) => (a.startMs || 0) - (b.startMs || 0))
  let manualTotal = 0, autoFrames = 0
  const measured = segs.map((s: any) => {
    if (s.kind === 'manual') {
      const src = path.join(dir, s.file)
      const dur = fs.existsSync(src) ? probeDurationDecode(src) : 0
      manualTotal += dur; return { ...s, realDur: dur }
    }
    const segDir = path.join(dir, s.dir)
    const frames = fs.existsSync(segDir) ? fs.readdirSync(segDir).filter((f) => /^frame-\d+\.jpg$/.test(f)).length : 0
    autoFrames += frames; return { ...s, frames }
  })
  // External recordings have no automation frames → give the whole budget to
  // the single video instead of reserving 40% for a timelapse that doesn't exist.
  const effManualShare = autoFrames > 0 ? manualShare : 1
  const manualBudget = target * effManualShare, autoBudget = target * (1 - effManualShare)
  let manualSpeed = manualTotal > 0 ? Math.max(1, manualTotal / manualBudget) : 1
  manualSpeed = Math.min(manualSpeed, manualMaxSpeed)
  let autoFps = autoFrames > 0 ? autoFrames / autoBudget : 24
  autoFps = Math.min(Math.max(autoFps, autoFpsMin), autoFpsMax)

  const clips: EdlClip[] = []
  for (const m of measured as any[]) {
    if (m.kind === 'manual') {
      if (!m.realDur || m.realDur < 0.2) continue
      clips.push({ kind: 'manual', source: m.file, sourceDurationSec: round(m.realDur), inSec: 0, outSec: round(m.realDur), speed: round(manualSpeed, 2), outDurationSec: round(m.realDur / manualSpeed), label: labelAt(manifest, m.startElapsedMs) || 'Working in the dashboard' })
    } else {
      if (!m.frames) continue
      clips.push({ kind: 'automation', source: m.dir, frameCount: m.frames, captureIntervalSec: m.intervalSec, fps: round(autoFps, 2), outDurationSec: round(m.frames / autoFps), label: labelAt(manifest, m.startElapsedMs) || `${m.workflowType || 'Automation'} running` })
    }
  }
  return {
    version: null, kind: 'rough-cut', recording: path.basename(dir), target,
    manualSpeed: round(manualSpeed, 2), autoFps: round(autoFps, 2),
    sourceManualSec: round(manualTotal), sourceAutoFrames: autoFrames,
    projectedTotalSec: round(clips.reduce((a, c) => a + c.outDurationSec, 0)),
    output: { width: OUT_W, height: OUT_H, fps: OUT_FPS }, clips,
  }
}

function subClip(c: EdlClip, o1: number, o2: number, factor: number): EdlClip {
  if (c.kind === 'manual') {
    const baseSpeed = c.speed || 1, baseIn = c.inSec || 0
    const srcIn = baseIn + o1 * baseSpeed, srcOut = baseIn + o2 * baseSpeed
    const speed = round(baseSpeed * factor, 3)
    return { kind: 'manual', source: c.source, sourceDurationSec: c.sourceDurationSec, inSec: round(srcIn, 3), outSec: round(srcOut, 3), speed, outDurationSec: round((srcOut - srcIn) / speed, 3), label: c.label }
  }
  const baseFps = c.fps || 12, f0 = c.startFrame || 1
  const startFrame = Math.round(f0 + o1 * baseFps)
  const frameCount = Math.max(1, Math.round((o2 - o1) * baseFps))
  const fps = round(baseFps * factor, 3)
  return { kind: 'automation', source: c.source, startFrame, frameCount, captureIntervalSec: c.captureIntervalSec, fps, outDurationSec: round(frameCount / fps, 3), label: c.label }
}

/** Apply edits (speed factor, or `cut:true` to drop a range) against the current output timeline. */
export function applyEdits(edl: Edl, edits: Edit[]): Edl {
  const out: Edl = { ...edl, version: null, kind: 'edit', basedOn: edl.version, clips: [] }
  let t = 0
  for (const c of edl.clips) {
    const dur = c.outDurationSec || 0
    const start = t, end = t + dur; t = end
    const local: { a: number; b: number; factor: number; cut: boolean }[] = []
    const bounds = new Set<number>([0, dur])
    for (const e of edits) {
      const a = Math.max(e.from, start), b = Math.min(e.to, end)
      if (b - a > 0.05) { bounds.add(a - start); bounds.add(b - start); local.push({ a: a - start, b: b - start, factor: e.factor ?? 1, cut: !!e.cut }) }
    }
    const pts = [...bounds].filter((x) => x >= -1e-6 && x <= dur + 1e-6).sort((x, y) => x - y)
    for (let i = 0; i < pts.length - 1; i++) {
      const o1 = pts[i], o2 = pts[i + 1]
      if (o2 - o1 < 0.03) continue
      const mid = (o1 + o2) / 2
      const ed = local.find((e) => mid >= e.a && mid <= e.b)
      if (ed && ed.cut) continue // drop this range
      out.clips.push(subClip(c, o1, o2, ed ? ed.factor : 1))
    }
  }
  out.projectedTotalSec = round(out.clips.reduce((a, c) => a + (c.outDurationSec || 0), 0))
  return out
}

export function renderEdl(dir: string, edl: Edl, outPath: string, opts: { crf?: number; preset?: string } = {}) {
  const { crf = 20, preset = 'veryfast' } = opts
  const fps = edl.output?.fps || OUT_FPS, w = edl.output?.width || OUT_W, h = edl.output?.height || OUT_H
  const VF = vfBase(w, h)
  const build = path.join(dir, '._roughcut_build')
  fs.mkdirSync(build, { recursive: true })
  const parts: string[] = []
  edl.clips.forEach((c, i) => {
    const out = path.join(build, `clip-${pad(i, 3)}.mp4`)
    if (c.kind === 'manual') {
      const src = path.join(dir, c.source)
      if (!fs.existsSync(src)) return
      const inSec = c.inSec || 0
      const len = ((c.outSec != null ? c.outSec : (c.sourceDurationSec || 0)) - inSec)
      const lenArg = len > 0 ? ['-t', String(round(len, 3))] : []
      run(FFMPEG, ['-y', '-fflags', '+genpts', '-ss', String(round(inSec, 3)), ...lenArg, '-i', src, '-vf', `setpts=(PTS-STARTPTS)/${c.speed || 1},${VF}`, '-an', '-r', String(fps), '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', out])
    } else {
      const segDir = path.join(dir, c.source)
      if (!fs.existsSync(segDir)) return
      const startFrame = c.startFrame || 1, fc = c.frameCount || 0
      const selectVf = fc > 0 ? `select='lt(n\\,${fc})',setpts=N/${c.fps}/TB,` : ''
      run(FFMPEG, ['-y', '-framerate', String(c.fps), '-start_number', String(startFrame), '-i', path.join(segDir, 'frame-%06d.jpg'), '-vf', `${selectVf}${VF}`, '-r', String(fps), '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', out])
    }
    parts.push(out)
  })
  if (!parts.length) throw new Error('EDL produced no renderable clips')
  if (parts.length === 1) fs.copyFileSync(parts[0], outPath)
  else {
    const list = path.join(build, 'concat.txt')
    fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outPath])
  }
  fs.rmSync(build, { recursive: true, force: true })
  return probeDuration(outPath)
}

export function writeChapters(edl: Edl, chaptersPath: string) {
  const fmt = (sec: number) => { const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; const p = (n: number) => String(n).padStart(2, '0'); return h > 0 ? `${p(h)}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}` }
  const lines: string[] = []; const seen = new Set<string>(); let t = 0, last: string | null = null
  for (const c of edl.clips) {
    const ts = fmt(t)
    if (c.label && c.label !== last && !seen.has(ts)) { lines.push(`${ts} ${c.label}`); seen.add(ts); last = c.label }
    t += c.outDurationSec || 0
  }
  if (lines.length && !lines[0].startsWith('00:00')) lines.unshift('00:00 Intro')
  fs.writeFileSync(chaptersPath, lines.join('\n') + '\n')
  return lines.length
}
