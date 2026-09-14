import { NextResponse } from 'next/server'
import http from 'http'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')

// Cross-project agent scorecard.
//
// Each project-server keeps its own append-only record; this fans out and
// stacks them. The fan-out is the product, not a convenience: a single
// project's rows say almost nothing, because there is no baseline to read them
// against. The same role in two projects, side by side, is what separates "this
// model is weak at X" from "this project's command file is stale" — and the
// latter is a file you can open.
//
// A project that is stopped or slow is reported as unreachable rather than
// omitted. Silently dropping it would understate every total and, worse, make
// the roster look complete.

interface ScorecardRow {
  project: string
  role: string
  step: string
  agents: number
  errored: number
  runs: number
  tokens: { in: number; out: number; cacheRead: number; cacheCreate: number }
  costUSD: number
  pricedAgents: number
  unpricedAgents: number
  unmeasuredAgents: number
  findings: { blocking: number; medium: number; low: number }
  verdicts: number
  roundsToConverge: number | null
  medianDurationMs: number | null
  clis: string[]
  models: string[]
}

function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid JSON')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

export async function GET(req: Request) {
  const seed = new URL(req.url).searchParams.get('seed') === '1'
  let projects: { name: string; port: number }[] = []
  try {
    const listed = registry.list()
    if (Array.isArray(listed)) projects = listed
  } catch (e) {
    console.error('[scorecard] registry.list() failed', e)
  }

  const settled = await Promise.allSettled(
    projects.map(async (p) => {
      const q = seed ? '?seed=1' : ''
      const body = await httpGetJson(`http://localhost:${p.port}/api/workflow/scorecard${q}`, 8000) as {
        rows?: ScorecardRow[]; agents?: number; seededFromSnapshots?: number; usageTrustedFrom?: string
      }
      return { name: p.name, body }
    }),
  )

  const rows: ScorecardRow[] = []
  const unreachable: string[] = []
  let usageTrustedFrom: string | null = null
  let seededFromSnapshots = 0

  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') { unreachable.push(projects[i].name); return }
    const { name, body } = r.value
    if (!body || !Array.isArray(body.rows)) { unreachable.push(name); return }
    for (const row of body.rows) rows.push({ ...row, project: row.project || name })
    seededFromSnapshots += body.seededFromSnapshots || 0
    if (body.usageTrustedFrom) usageTrustedFrom = body.usageTrustedFrom
  })

  // Roles seen in more than one project — the comparable set, and the only part
  // of this that can answer the question it was built for.
  const byRole = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!byRole.has(r.role)) byRole.set(r.role, new Set())
    byRole.get(r.role)!.add(r.project)
  }
  const comparableRoles = [...byRole.entries()]
    .filter(([, ps]) => ps.size > 1)
    .map(([role, ps]) => ({ role, projects: [...ps].sort() }))
    .sort((a, b) => b.projects.length - a.projects.length || a.role.localeCompare(b.role))

  return NextResponse.json({
    rows,
    comparableRoles,
    unreachable,
    seededFromSnapshots,
    usageTrustedFrom,
    projects: projects.length,
  })
}
