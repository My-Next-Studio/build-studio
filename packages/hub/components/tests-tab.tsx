'use client'

/**
 * Operations → Tests: test-suite health (project-server lib/suite-watch.js)
 * above the nightly run (lib/nightly.js). Each half shows only when the project
 * declares it.
 */

import { useCallback, useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { NightlyTab } from './nightly-tab'

type Metric = 'seconds' | 'tests' | 'lines'

interface Judged {
  metric: Metric
  state: 'no-data' | 'quiet' | 'ok' | 'over'
  latest: { id: string; at: string; value: number; head: string | null } | null
  median: number | null
  flag: { baseline: number; latest: number; overPct: number; since: { id: string; createdAt: string }; watching: { value: number; at: string; grown: boolean } | null } | null
  notice: boolean
  cap: number | null
  overCap: boolean
  trend: number[]
}

interface Series { key: string; label: string; source: 'gate' | 'nightly' | 'code'; metrics: Partial<Record<Metric, Judged>>; byPath?: Record<string, number> }

interface Pass { state: 'running' | 'filed' | 'done' | 'error' | 'lost'; itemId?: string; title?: string; error?: string; startedAt: string; sessionName?: string }

interface Suite {
  configured: boolean
  branch: string
  testPaths: string[]
  gateHistory: string | null
  gateHistoryFound: boolean
  series: Series[]
  flaky: { test: string; flaky: number; failed: number; of: number }[]
  review: { every: number; since: string; stories: { id: string; item: string | null; at: string }[]; due: boolean; pass: Pass | null }
  error?: string
}

const METRIC_LABEL: Record<Metric, string> = { seconds: 'Time', tests: 'Tests', lines: 'Lines' }
const METRICS: Metric[] = ['seconds', 'tests', 'lines']

const sectionHeader: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)',
}

function fmt(metric: Metric, v: number | null | undefined) {
  if (v == null) return '—'
  if (metric === 'seconds') {
    const s = Math.round(v)
    if (s < 120) return `${s}s`
    const m = Math.round(s / 60)
    return m < 120 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
  }
  return Math.round(v).toLocaleString()
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null
  const w = 54, h = 14
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const d = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 2) - 1}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }} aria-hidden>
      <polyline points={d} fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  )
}

function Cell({ m }: { m: Judged | undefined }) {
  if (!m) return <span style={{ color: 'var(--muted)' }}>—</span>
  const color = m.overCap ? 'var(--red)' : m.notice ? 'var(--orange)' : 'var(--text)'
  const title = [
    m.median != null ? `median ${fmt(m.metric, m.median)}` : null,
    m.flag ? `${m.flag.overPct}% over its baseline of ${fmt(m.metric, m.flag.baseline)}` : null,
    m.cap != null ? `cap ${fmt(m.metric, m.cap)}` : null,
    m.state === 'quiet' ? 'too few runs to judge yet' : null,
  ].filter(Boolean).join(' · ')
  return (
    <span title={title} style={{ display: 'flex', alignItems: 'center', gap: 6, color }}>
      <span>{fmt(m.metric, m.latest?.value)}</span>
      {m.flag && <span style={{ fontSize: 10 }}>+{m.flag.overPct}%</span>}
      {m.cap != null && <span style={{ fontSize: 10, color: m.overCap ? 'var(--red)' : 'var(--muted)' }}>/ {fmt(m.metric, m.cap)}</span>}
      <Spark values={m.trend} color={m.notice || m.overCap ? color : 'var(--muted)'} />
    </span>
  )
}

function SuiteHealth({ data, onChange }: { data: Suite; onChange: (d: Suite) => void }) {
  const api = useProjectApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(path: string, body: unknown, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return
    setBusy(true)
    setError(null)
    try {
      const d = await api.post(path, body)
      if (d.error) setError(d.error)
      else onChange(d)
    } finally {
      setBusy(false)
    }
  }

  const { review } = data
  const pass = review.pass
  const passOpen = pass && (pass.state === 'running' || pass.state === 'filed')
  const notices: { s: Series; m: Judged }[] = []
  for (const s of data.series) for (const m of Object.values(s.metrics)) if (m && (m.notice || m.overCap)) notices.push({ s, m })

  return (
    <div style={{ padding: '24px 32px 8px', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--mono)' }}>
      <div>
        <h1 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' }}>Test suite</h1>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Each story adds its own tests and nothing consolidates them. Every suite&apos;s time, test count and test code are judged against their own recent median (10% over flags), and against a cap where one is set.
        </p>
      </div>

      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(255,95,95,0.08)', border: '1px solid var(--red)', borderRadius: 4, color: 'var(--red)', fontSize: 11 }}>{error}</div>
      )}

      {/* Review */}
      <div style={{
        padding: '10px 14px', borderRadius: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        background: 'var(--surface)', border: `1px solid ${review.due ? 'var(--orange)' : 'var(--border)'}`,
      }}>
        <span style={sectionHeader}>Review</span>
        {pass?.state === 'running' ? (
          <span style={{ color: 'var(--accent)' }}>An agent is reading the suite for overlap{pass.sessionName ? ` (tmux ${pass.sessionName})` : ''}. This can take half an hour.</span>
        ) : pass?.state === 'filed' ? (
          <span>Filed as <b>{pass.itemId}</b> — {pass.title}. Draft and build it from the backlog; when it is implemented the baselines and the count restart.</span>
        ) : review.every > 0 ? (
          <>
            <span style={{ color: review.due ? 'var(--orange)' : 'var(--text-dim)' }}>
              {review.stories.length} of {review.every} stories since {new Date(review.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              {review.due ? ' — a review is due' : ''}
            </span>
            {review.stories.length > 0 && (
              <span style={{ color: 'var(--muted)' }} title={review.stories.map(s => s.item || s.id).join(', ')}>
                ({review.stories.slice(-4).map(s => s.item || s.id).join(', ')}{review.stories.length > 4 ? ', …' : ''})
              </span>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--text-dim)' }}>No scheduled review (review_every: 0).</span>
        )}
        <span style={{ flex: 1 }} />
        {!passOpen && (
          <button className="wf-btn" style={{ fontSize: 10, padding: '2px 10px' }} disabled={busy}
            onClick={() => act('/ops/suite/review', { reason: 'due' }, 'Start a review of the whole suite? One agent reads it for overlap (about half an hour) and its proposals are filed as a backlog Task. It changes no code.')}>
            Start review
          </button>
        )}
        {review.due && !passOpen && (
          <button className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }} disabled={busy} onClick={() => act('/ops/suite/review/skip', {})}>
            Skip this round
          </button>
        )}
        {(pass?.state === 'error' || pass?.state === 'lost') && (
          <span style={{ flexBasis: '100%', color: 'var(--red)' }}>The last review did not finish: {pass.error}</span>
        )}
      </div>

      {/* Notices */}
      {notices.map(({ s, m }) => (
        <div key={`${s.key}|${m.metric}`} style={{
          padding: '8px 14px', borderRadius: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: `1px solid ${m.overCap ? 'var(--red)' : 'var(--orange)'}`,
        }}>
          <span style={{ color: m.overCap ? 'var(--red)' : 'var(--orange)' }}>
            {s.label} — {METRIC_LABEL[m.metric].toLowerCase()} {m.overCap
              ? `${fmt(m.metric, m.latest?.value)} is over its cap of ${fmt(m.metric, m.cap)}`
              : `${fmt(m.metric, m.flag!.latest)} is ${m.flag!.overPct}% over its baseline of ${fmt(m.metric, m.flag!.baseline)}`}
          </span>
          {m.flag && <span style={{ color: 'var(--muted)' }}>since {new Date(m.flag.since.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
          <span style={{ flex: 1 }} />
          {!passOpen && (
            <button className="wf-btn" style={{ fontSize: 10, padding: '2px 10px' }} disabled={busy}
              onClick={() => act('/ops/suite/review', { reason: 'growth', focus: `${s.label} ${METRIC_LABEL[m.metric].toLowerCase()}` })}>
              Start review
            </button>
          )}
          {m.notice && m.flag && (
            <button className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }} disabled={busy}
              onClick={() => act('/ops/suite/watch', { key: s.key, metric: m.metric })}>
              Keep watching
            </button>
          )}
          {m.flag && (
            <button className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }} disabled={busy}
              onClick={() => act('/ops/suite/accept', { key: s.key }, `Accept ${s.label}'s current size as its new baseline? Later runs are judged against it.`)}>
              Accept new size
            </button>
          )}
        </div>
      ))}

      {/* Series */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px repeat(3, 1fr)', gap: 12, ...sectionHeader }}>
          <span>Suite</span>{METRICS.map(m => <span key={m}>{METRIC_LABEL[m]}</span>)}
        </div>
        {data.series.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Nothing measured yet.</div>
        )}
        {data.series.map(s => (
          <div key={s.key} style={{
            display: 'grid', gridTemplateColumns: '180px repeat(3, 1fr)', gap: 12, alignItems: 'center',
            padding: '6px 0', borderTop: '1px solid var(--border-subtle)', fontSize: 11,
          }}>
            <span title={s.key}>
              {s.label}
              <span style={{ color: 'var(--muted)', fontSize: 10 }}> {s.source === 'gate' ? 'merge gate' : s.source === 'nightly' ? 'nightly' : data.branch}</span>
            </span>
            {METRICS.map(m => <Cell key={m} m={s.metrics[m]} />)}
          </div>
        ))}
        {data.series.find(s => s.byPath)?.byPath && (
          <div style={{ fontSize: 10, color: 'var(--muted)', paddingTop: 2 }}>
            Test code by path: {Object.entries(data.series.find(s => s.byPath)!.byPath!).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n.toLocaleString()}`).join(' · ')}
          </div>
        )}
        {data.gateHistory && !data.gateHistoryFound && (
          <div style={{ fontSize: 10, color: 'var(--orange)', paddingTop: 4 }}>
            No merge-gate history at {data.gateHistory} yet. The gate needs to append one line per run for its steps to be measured.
          </div>
        )}
      </div>

      {/* Recurring flakiness */}
      {data.flaky.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={sectionHeader}>Keeps flaking — recent nightly runs</span>
          {data.flaky.map(f => (
            <div key={f.test} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, fontSize: 11 }}>
              <span style={{ color: 'var(--orange)' }}>{f.flaky + f.failed} of {f.of}{f.failed ? ` (${f.failed} red)` : ''}</span>
              <span>{f.test}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function TestsTab() {
  const api = useProjectApi()
  const [suite, setSuite] = useState<Suite | null>(null)

  const load = useCallback(async () => {
    const d: Suite = await api.get('/ops/suite').catch(() => null)
    if (d && !d.error) setSuite(d)
  }, [api])

  const reviewRunning = suite?.review.pass?.state === 'running'
  useEffect(() => {
    load()
    const id = setInterval(load, reviewRunning ? 10_000 : 60_000)
    return () => clearInterval(id)
  }, [load, reviewRunning])

  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      {suite?.configured && <SuiteHealth data={suite} onChange={setSuite} />}
      <NightlyTab />
    </div>
  )
}
