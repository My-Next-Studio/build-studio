// External-app recording (server-only). Phase 2a: iOS Simulator via
// `xcrun simctl io booted recordVideo` — native, crisp, no screen-record
// permission, records the simulator regardless of focus. The resulting folder
// flows through the same Demos post-production as dashboard recordings.

import fs from 'fs'
import path from 'path'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { resolveBaseDir } from './recordings'
import { probeDuration, probeDurationDecode } from './edl'

interface DemoEvent { t: string; elapsedMs: number; label: string; type: string }
interface ActiveRec {
  dir: string; startMs: number; project: string | null; source: string; segFile: string; events: DemoEvent[]
  proc?: ChildProcess          // simulator: simctl child (SIGINT to stop)
  stream?: fs.WriteStream      // window: chunks streamed from the renderer's MediaRecorder
}

// Single in-flight recording per hub process.
let active: ActiveRec | null = null

function tsFolder(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

export function bootedSimulators(): { udid: string; name: string }[] {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], { encoding: 'utf8' })
    const res: { udid: string; name: string }[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s+(.+?)\s+\(([0-9A-Fa-f-]{36})\)\s+\(Booted\)/)
      if (m) res.push({ name: m[1].trim(), udid: m[2] })
    }
    return res
  } catch { return [] }
}

export function recordingStatus() {
  if (!active) return { recording: false as const, booted: bootedSimulators() }
  return {
    recording: true as const, source: active.source, project: active.project,
    elapsedMs: Date.now() - active.startMs,
    markers: active.events.filter((e) => e.type !== 'system').length,
    dir: path.basename(active.dir),
  }
}

export function startSimulator({ project }: { project?: string | null } = {}) {
  if (active) throw new Error('A recording is already in progress.')
  const sims = bootedSimulators()
  if (!sims.length) throw new Error('No booted simulator — boot one in Simulator.app first.')
  const startMs = Date.now()
  const dir = path.join(resolveBaseDir(), tsFolder(new Date(startMs)))
  fs.mkdirSync(path.join(dir, 'manual'), { recursive: true })
  const segFile = path.join(dir, 'manual', 'segment-01.mp4')
  const proc = spawn('xcrun', ['simctl', 'io', 'booted', 'recordVideo', '--codec', 'h264', '--force', segFile], { stdio: ['ignore', 'ignore', 'pipe'] })
  proc.on('error', () => {})
  const iso = new Date(startMs).toISOString()
  active = {
    dir, proc, startMs, project: project || sims[0].name, source: 'ios-simulator', segFile,
    events: [
      { t: iso, elapsedMs: 0, label: 'setup_started', type: 'system' },
      { t: iso, elapsedMs: 0, label: 'recording_started', type: 'system' },
    ],
  }
  return recordingStatus()
}

// Phase 2b: window/screen capture. The renderer's MediaRecorder (over a source
// the user picked, granted by main's display handler) streams webm chunks here.
export function startWindow({ project }: { project?: string | null } = {}) {
  if (active) throw new Error('A recording is already in progress.')
  const startMs = Date.now()
  const dir = path.join(resolveBaseDir(), tsFolder(new Date(startMs)))
  fs.mkdirSync(path.join(dir, 'manual'), { recursive: true })
  const segFile = path.join(dir, 'manual', 'segment-01.webm')
  const iso = new Date(startMs).toISOString()
  active = {
    dir, startMs, project: project || 'screen capture', source: 'window', segFile,
    stream: fs.createWriteStream(segFile),
    events: [
      { t: iso, elapsedMs: 0, label: 'setup_started', type: 'system' },
      { t: iso, elapsedMs: 0, label: 'recording_started', type: 'system' },
    ],
  }
  return recordingStatus()
}

export function appendChunk(buf: Buffer) {
  if (active && active.stream && buf && buf.length) active.stream.write(buf)
}

export function addMarker({ label = 'highlight', type = 'highlight' }: { label?: string; type?: string } = {}) {
  if (!active) throw new Error('No active recording.')
  const nowMs = Date.now()
  active.events.push({ t: new Date(nowMs).toISOString(), elapsedMs: nowMs - active.startMs, label, type })
  return recordingStatus()
}

export async function stopRecording() {
  if (!active) return { recording: false }
  const a = active; active = null
  const endMs = Date.now()
  if (a.proc) {
    // simulator: simctl recordVideo finalizes the mp4 on SIGINT.
    await new Promise<void>((resolve) => {
      let done = false
      a.proc!.on('exit', () => { if (!done) { done = true; resolve() } })
      try { a.proc!.kill('SIGINT') } catch { resolve() }
      setTimeout(() => { if (!done) { done = true; try { a.proc!.kill('SIGKILL') } catch { /* */ } resolve() } }, 10000)
    })
  } else if (a.stream) {
    // window: close the chunk stream once the renderer's last chunk is written.
    await new Promise<void>((resolve) => { a.stream!.end(() => resolve()) })
  }
  await new Promise((r) => setTimeout(r, 300)) // let the file flush
  // webm (window capture) has no duration header → decode-probe; mp4 → fast probe.
  const durSec = !fs.existsSync(a.segFile) ? 0 : a.segFile.endsWith('.webm') ? probeDurationDecode(a.segFile) : probeDuration(a.segFile)
  const durMs = Math.round(durSec * 1000)
  a.events.push({ t: new Date(endMs).toISOString(), elapsedMs: endMs - a.startMs, label: 'recording_stopped', type: 'system' })
  const manifest = {
    version: 1, project: a.project, kind: 'external', source: a.source,
    createdAtIso: new Date(a.startMs).toISOString(), startedAtMs: a.startMs, endedAtMs: endMs, durationMs: durMs,
    output: { width: 1920, height: 1080, fps: 30, codec: 'h264', pixfmt: 'yuv420p' },
    events: a.events,
    segments: [{ kind: 'manual', file: path.relative(a.dir, a.segFile), startMs: a.startMs, endMs, startElapsedMs: 0, endElapsedMs: durMs, source: a.source, mime: a.segFile.endsWith('.webm') ? 'video/webm' : 'video/mp4' }],
  }
  fs.writeFileSync(path.join(a.dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { recording: false, dir: path.basename(a.dir), durationSec: durSec }
}
