// Demo recordings discovery + summaries (server-only).

import fs from 'fs'
import path from 'path'
import { probeDuration } from './edl'

// Output base: env → user setting → next-to-projects heuristic → ~/Movies
// fallback. Resolution lives in @build-studio/shared so the hub (read path) and
// the recorder (write path, demoRecorder.js) can never resolve different folders.
export function resolveBaseDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { demoRecordings } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  return demoRecordings.resolveDemoRecordingsDir()
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
