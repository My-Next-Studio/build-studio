import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { recordingDir } from '@/lib/demo/recordings'

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
}

// Serves a file from within a recording folder, with HTTP range support so the
// <video> player can seek. `file` is restricted to safe names inside the dir.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const file = new URL(req.url).searchParams.get('file') || ''
  if (!/^[\w./-]+$/.test(file) || file.includes('..')) return new Response('bad file', { status: 400 })
  let dir: string
  try { dir = recordingDir(id) } catch { return new Response('bad id', { status: 400 }) }
  const full = path.join(dir, file)
  if (!full.startsWith(dir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return new Response('not found', { status: 404 })

  const stat = fs.statSync(full)
  const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream'
  const range = req.headers.get('range')
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    if (m) {
      const start = parseInt(m[1], 10)
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
      const stream = fs.createReadStream(full, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': type },
      })
    }
  }
  return new Response(Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream, {
    status: 200,
    headers: { 'Content-Length': String(stat.size), 'Content-Type': type, 'Accept-Ranges': 'bytes' },
  })
}
