// Demo recordings discovery + summaries (server-only).

import fs from 'fs'
import path from 'path'
import os from 'os'
import { probeDuration } from './edl'

function commonParent(paths: string[]): string | null {
  if (!paths.length) return null
  const split = paths.map((p) => path.resolve(p).split(path.sep))
  const first = split[0]; const out: string[] = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (split.every((s) => s[i] === seg)) out.push(seg); else break
  }
  return out.join(path.sep) || null
}

// Output base: env → next to the managed projects (sibling of build-studio on
// the external drive) → ~/Movies fallback. Mirrors demoRecorder.resolveBaseDir.
export function resolveBaseDir(): string {
  if (process.env.DEMO_RECORDINGS_DIR) return process.env.DEMO_RECORDINGS_DIR
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
    const projects = registry.list().map((p: any) => p.path).filter(Boolean)
    const parent = commonParent(projects)
    if (parent && parent.split(path.sep).filter(Boolean).length >= 2) return path.join(parent, 'demo-recordings')
  } catch { /* registry not resolvable */ }
  return path.join(os.homedir(), 'Movies', 'build-studio-demos')
}

function safeJoin(base: string, id: string): string {
  // Prevent path traversal — id must be a single timestamp-style folder name.
  if (!/^[\w.-]+$/.test(id)) throw new Error('invalid recording id')
  const p = path.join(base, id)
  if (!p.startsWith(base + path.sep)) throw new Error('invalid recording id')
  return p
}

function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
function versionsOf(dir: string, prefix: string, ext: string): { version: number; file: string }[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map((f) => { const m = f.match(new RegExp(`^${prefix}\\.v(\\d+)\\.${ext}$`)); return m ? { version: +m[1], file: f } : null })
    .filter(Boolean as any).sort((a: any, b: any) => a.version - b.version) as any
}

export function listRecordings() {
  const base = resolveBaseDir()
  if (!fs.existsSync(base)) return { base, recordings: [] }
  const recordings = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(base, d.name)
      const manifest = readJson(path.join(dir, 'manifest.json'))
      const cuts = versionsOf(dir, 'rough-cut', 'mp4')
      const hasNotes = fs.existsSync(path.join(dir, 'notes.json'))
      const hasMaster = fs.existsSync(path.join(dir, 'upload-master.mp4'))
      return {
        id: d.name,
        date: d.name,
        project: manifest?.project || null,
        kind: manifest ? 'dashboard' : 'external',
        durationMs: manifest?.durationMs || null,
        cutCount: cuts.length,
        latestCut: cuts.length ? cuts[cuts.length - 1].file : null,
        hasNotes, hasMaster,
      }
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1)) // newest first
  return { base, recordings }
}

export function getRecording(id: string) {
  const base = resolveBaseDir()
  const dir = safeJoin(base, id)
  if (!fs.existsSync(dir)) return null
  const manifest = readJson(path.join(dir, 'manifest.json'))
  const cuts = versionsOf(dir, 'rough-cut', 'mp4').map((c) => ({ ...c, durationSec: probeDuration(path.join(dir, c.file)) }))
  const edls = versionsOf(dir, 'edl', 'json')
  const notes = readJson(path.join(dir, 'notes.json'))?.notes || []
  const latestEdl = edls.length ? edls[edls.length - 1] : null
  return {
    id, dir, project: manifest?.project || null,
    kind: manifest ? 'dashboard' : 'external',
    durationMs: manifest?.durationMs || null,
    eventCount: manifest?.events?.length || 0,
    cuts, edls, latestEdl, notes,
    hasMaster: fs.existsSync(path.join(dir, 'upload-master.mp4')),
    hasManus: fs.readdirSync(dir).some((f) => /^manus\.v\d+\.md$/.test(f)),
  }
}

export function recordingDir(id: string): string {
  return safeJoin(resolveBaseDir(), id)
}

export function nextVersion(dir: string): number {
  let n = 1
  while (fs.existsSync(path.join(dir, `edl.v${n}.json`)) || fs.existsSync(path.join(dir, `rough-cut.v${n}.mp4`))) n++
  return n
}
