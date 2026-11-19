'use client'

/**
 * Operations → Nightly: a project's scheduled test run (project-server
 * lib/nightly.js). Shown where `nightly:` is declared in the project config;
 * turned on, and its time chosen, here.
 */

import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useProjectApi } from '@/lib/use-project-api'

type Outcome = 'passed' | 'flaky' | 'failed' | 'error' | 'empty'

interface Summary {
  startedAt: string
  finishedAt?: string
  head?: string
  headAtEnd?: string
  branch?: string
  dirtyWorkingTree?: boolean
  passed?: number
  failed?: number
  flaky?: number
  skipped?: number
  durationSec?: number
  failures?: string[]
  flakes?: string[]
  error?: string
}

interface Run {
  id: string
  startedAt: string
  summary: Summary | null
  outcome: Outcome | null
}

interface Recurring { test: string; failed: number; flaky: number; runs: number; lastSeen: string }

interface Decision { at: string; slot: number; action: 'start' | 'skip' | 'wait'; reason: string | null }

interface Nightly {
  configured: boolean
  label: string
  cmd: string
  branch: string
  statusDir: string
  schedule: { enabled: boolean; at: string; nextAt: string | null; lastDecision: Decision | null }
  current: { state: 'idle' | 'starting' | 'running'; startedAt: string | null; pid: number | null }
  latest: Run | null
  runs: Run[]
  recurring: Recurring[]
  typicalDurationSec: number | null
  ownLogTail: string
  error?: string
}

interface Investigation {
  state: 'none' | 'running' | 'complete' | 'error' | 'lost'
  markdown?: string
  error?: string
  startedAt?: string
  sessionName?: string | null
}

const OUTCOME: Record<Outcome, { color: string; label: string }> = {
  passed: { color: 'var(--green)', label: 'passed' },
  flaky: { color: 'var(--orange)', label: 'flaky' },
  failed: { color: 'var(--red)', label: 'failed' },
  error: { color: 'var(--red)', label: 'could not run' },
  empty: { color: 'var(--muted)', label: 'no tests' },
}

const sectionHeader: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)',
}

function fmtDuration(secs: number | null | undefined) {
  if (secs == null) return '—'
  const s = Math.round(secs)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Badge({ outcome }: { outcome: Outcome | null }) {
  const c = outcome ? OUTCOME[outcome] : { color: 'var(--muted)', label: 'unfinished' }
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color: c.color, padding: '1px 6px', border: `1px solid ${c.color}`,
      borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>{c.label}</span>
  )
}

function counts(s: Summary | null) {
  if (!s) return '—'
  if (s.error) return 'no tests ran'
  return `${s.passed ?? 0} passed · ${s.failed ?? 0} failed · ${s.flaky ?? 0} flaky${s.skipped ? ` · ${s.skipped} skipped` : ''}`
}

/** "feed.spec.ts:428 › chromium › name" → file:line and name, for two-tone display. */
function TestName({ name }: { name: string }) {
  const parts = name.split(' › ')
  const where = parts[0]
  const title = parts.slice(parts.length > 2 ? 2 : 1).join(' › ')
  return (
    <span style={{ minWidth: 0 }}>
      <span style={{ color: 'var(--text)' }}>{title || name}</span>
      {title && <span style={{ color: 'var(--muted)' }}> — {where}</span>}
    </span>
  )
}

export function NightlyTab() {
  const api = useProjectApi()
  const [data, setData] = useState<Nightly | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [timeDraft, setTimeDraft] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [inv, setInv] = useState<Investigation | null>(null)

  const load = useCallback(async () => {
    try {
      const d: Nightly = await api.get('/ops/nightly')
      if (d.error) setError(d.error)
      else setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load')
    }
  }, [api])

  const active = data?.current.state !== undefined && data.current.state !== 'idle'
  useEffect(() => {
    load()
    const id = setInterval(load, active ? 5_000 : 30_000)
    return () => clearInterval(id)
  }, [load, active])

  const selected = data?.runs.find(r => r.id === selectedId) || data?.latest || null

  // The selected run's investigation, polled while an agent is on it.
  // Keyed on the id, not the run object: the list poll replaces the object
  // every few seconds and would otherwise restart this effect each time.
  const selectedRunId = selected?.summary ? selected.id : null
  const invRunning = inv?.state === 'running'
  useEffect(() => {
    if (!selectedRunId) { setInv(null); return }
    let cancelled = false
    const fetchInv = async () => {
      const d: Investigation = await api.get(`/ops/nightly/runs/${selectedRunId}/investigation`).catch(() => null)
      if (!cancelled && d) setInv(d)
    }
    fetchInv()
    if (!invRunning) return () => { cancelled = true }
    const id = setInterval(fetchInv, 5_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [api, selectedRunId, invRunning])

  useEffect(() => { setLog(null) }, [selectedRunId])

  async function act(fn: () => Promise<{ error?: string } & Partial<Nightly>>) {
    setBusy(true)
    setError(null)
    try {
      const d = await fn()
      if (d && d.error) setError(d.error)
      else if (d && d.configured) setData(d as Nightly)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveSchedule = (enabled: boolean, at: string) =>
    act(() => api.post('/ops/nightly/schedule', { enabled, at })).then(() => setTimeDraft(null))

  const runNow = () => {
    const typical = data?.typicalDurationSec ? ` It usually takes ${fmtDuration(data.typicalDurationSec)}.` : ''
    if (!confirm(`Start a full ${data?.label ?? 'nightly'} run now?${typical} It uses this checkout and the services it starts, so avoid running it while you test by hand.`)) return
    act(() => api.post('/ops/nightly/run', {}))
  }

  async function investigate(run: Run) {
    setError(null)
    const d = await api.post(`/ops/nightly/runs/${run.id}/investigate`, {})
    if (d.error) setError(d.error)
    else setInv({ state: 'running', sessionName: d.sessionName })
  }

  async function showLog(run: Run) {
    if (log !== null) { setLog(null); return }
    const d = await api.get(`/ops/nightly/runs/${run.id}/log?lines=300`)
    setLog(d.tail || '(the run wrote no log)')
  }

  if (!data) {
    return <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', fontSize: 11, color: error ? 'var(--red)' : 'var(--text-dim)' }}>{error || 'Loading…'}</div>
  }
  if (!data.configured) {
    return (
      <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        No nightly run is declared for this project. Add <code>nightly: {'{'} cmd, status_dir {'}'}</code> to <code>.build-studio/config.yaml</code>.
      </div>
    )
  }

  const { schedule, current } = data
  const time = timeDraft ?? schedule.at
  const elapsedSec = current.startedAt ? (Date.now() - Date.parse(current.startedAt)) / 1000 : null
  const s = selected?.summary ?? null
  const canInvestigate = !!selected && !!s && selected.outcome !== 'passed'

  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'var(--mono)', overflow: 'auto' }}>
      {/* Heading + Run now */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' }}>{data.label}</h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Runs <code>{data.cmd}</code> on <code>{data.branch}</code> once a day — skipped when {data.branch} has not changed since the last run, and held while a workflow is at work.
          </p>
        </div>
        <button onClick={runNow} disabled={busy || active} className="wf-btn" style={{ whiteSpace: 'nowrap' }}>
          {current.state === 'running' ? '▶ Running…' : current.state === 'starting' ? '⏳ Starting…' : '▶ Run now'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(255,95,95,0.08)', border: '1px solid var(--red)', borderRadius: 4, color: 'var(--red)', fontSize: 11 }}>
          {error}
        </div>
      )}

      {/* Schedule */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={schedule.enabled} disabled={busy} onChange={e => saveSchedule(e.target.checked, time)} />
          Run every night at
        </label>
        <input
          type="time" value={time} disabled={busy}
          onChange={e => setTimeDraft(e.target.value)}
          style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' }}
        />
        {timeDraft !== null && timeDraft !== schedule.at && (
          <button className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }} disabled={busy} onClick={() => saveSchedule(schedule.enabled, timeDraft)}>Save</button>
        )}
        <span style={{ color: 'var(--muted)' }}>
          {schedule.enabled
            ? `next ${fmtWhen(schedule.nextAt)} · while Build Studio is running; a missed night runs when it is back`
            : 'off on this machine'}
        </span>
        {schedule.enabled && schedule.lastDecision && (
          <span style={{ flexBasis: '100%', color: schedule.lastDecision.action === 'wait' ? 'var(--orange)' : 'var(--text-dim)' }}>
            {schedule.lastDecision.action === 'start' ? `Started on schedule ${fmtWhen(schedule.lastDecision.at)}`
              : schedule.lastDecision.action === 'skip' ? `Skipped ${fmtWhen(schedule.lastDecision.at)}: ${schedule.lastDecision.reason}`
              : `Due, ${schedule.lastDecision.reason}`}
          </span>
        )}
      </div>

      {/* In progress */}
      {active && (
        <div style={{ padding: '10px 14px', border: '1px solid var(--accent)', borderRadius: 6, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <span style={{ color: 'var(--accent)' }}>{current.state === 'starting' ? 'Starting…' : 'Running'}</span>
            <span style={{ color: 'var(--muted)' }}>
              {elapsedSec != null ? ` · ${fmtDuration(elapsedSec)}` : ''}
              {data.typicalDurationSec ? ` of about ${fmtDuration(data.typicalDurationSec)}` : ''}
              {current.pid ? ` · pid ${current.pid}` : ''}
            </span>
          </div>
          {elapsedSec != null && data.typicalDurationSec && (
            <div style={{ height: 3, background: 'var(--surface2)', borderRadius: 2 }}>
              <div style={{ height: 3, borderRadius: 2, background: 'var(--accent)', width: `${Math.min(100, (elapsedSec / data.typicalDurationSec) * 100)}%` }} />
            </div>
          )}
          {data.ownLogTail && (
            <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{data.ownLogTail}</pre>
          )}
        </div>
      )}

      {/* Selected run (the latest by default) */}
      {selected ? (
        <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
            <span style={sectionHeader}>{selected.id === data.latest?.id ? 'Latest run' : 'Run'}</span>
            <Badge outcome={selected.outcome} />
            <span>{fmtWhen(selected.startedAt)}</span>
            <span style={{ color: 'var(--muted)' }}>
              {fmtDuration(s?.durationSec)}
              {s?.head ? ` · ${s.branch ?? ''}@${s.head}` : ''}
              {s?.headAtEnd && s.head && s.headAtEnd !== s.head ? ` → ${s.headAtEnd}` : ''}
            </span>
            {s?.dirtyWorkingTree && (
              <span title="The run tested uncommitted changes as well as the commit" style={{ color: 'var(--orange)' }}>dirty tree</span>
            )}
            <span style={{ flex: 1 }} />
            {selected.summary && (
              <button className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => showLog(selected)}>
                {log !== null ? 'Hide log' : 'Log'}
              </button>
            )}
            {canInvestigate && (
              <button className="wf-btn" style={{ fontSize: 10, padding: '2px 10px' }} disabled={inv?.state === 'running'} onClick={() => investigate(selected)}>
                {inv?.state === 'running' ? 'Investigating…' : inv?.state === 'complete' ? 'Investigate again' : 'Investigate'}
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: s?.error ? 'var(--red)' : 'var(--text-dim)' }}>{s?.error ?? counts(s)}</div>

          {s?.failures && s.failures.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={sectionHeader}>Failed</span>
              {s.failures.map(f => (
                <div key={f} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                  <span style={{ color: 'var(--red)', flexShrink: 0 }}>✖</span><TestName name={f} />
                </div>
              ))}
            </div>
          )}
          {s?.flakes && s.flakes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={sectionHeader}>Flaky — passed only on retry</span>
              {s.flakes.map(f => (
                <div key={f} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                  <span style={{ color: 'var(--orange)', flexShrink: 0 }}>~</span><TestName name={f} />
                </div>
              ))}
            </div>
          )}

          {log !== null && (
            <pre style={{
              margin: 0, maxHeight: 320, overflow: 'auto', padding: '8px 10px', borderRadius: 4,
              background: 'var(--surface2)', border: '1px solid var(--border)',
              fontSize: 10, lineHeight: 1.45, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{log}</pre>
          )}

          {inv && inv.state !== 'none' && (
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={sectionHeader}>Investigation</span>
              {inv.state === 'running' && (
                <span style={{ fontSize: 11, color: 'var(--accent)' }}>
                  An agent is reading the report, the log and the traces{inv.sessionName ? ` (tmux ${inv.sessionName})` : ''}. This takes a few minutes.
                </span>
              )}
              {inv.state === 'error' && <span style={{ fontSize: 11, color: 'var(--red)' }}>{inv.error}</span>}
              {inv.state === 'lost' && <span style={{ fontSize: 11, color: 'var(--orange)' }}>The investigation stopped without a result (most likely a project-server restart). Start it again.</span>}
              {inv.state === 'complete' && inv.markdown && (
                <div className="md-rendered" style={{ fontSize: 12 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{inv.markdown}</ReactMarkdown>
                </div>
              )}
            </div>
          )}
        </div>
      ) : !active && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No runs yet. Turn the schedule on, or press Run now.</div>
      )}

      {/* History */}
      {data.runs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={sectionHeader}>History · {data.runs.length} kept</span>
            {/* Oldest → newest, left to right, like a trend line. */}
            <span style={{ display: 'flex', gap: 2 }}>
              {[...data.runs].reverse().map(r => (
                <span key={r.id} title={`${fmtWhen(r.startedAt)} — ${r.outcome ? OUTCOME[r.outcome].label : 'unfinished'}`} style={{
                  width: 8, height: 8, borderRadius: 2,
                  background: r.outcome ? OUTCOME[r.outcome].color : 'var(--surface3)',
                  opacity: r.outcome === 'error' ? 0.5 : 1,
                }} />
              ))}
            </span>
          </div>
          {data.runs.map(r => {
            const isSel = selected?.id === r.id
            return (
              <button key={r.id} onClick={() => setSelectedId(r.id)} style={{
                display: 'grid', gridTemplateColumns: '100px 150px 1fr 70px 110px', gap: 12, alignItems: 'center',
                padding: '6px 12px', textAlign: 'left', cursor: 'pointer',
                background: isSel ? 'var(--surface2)' : 'var(--surface)',
                border: `1px solid ${isSel ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 5,
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
              }}>
                <Badge outcome={r.outcome} />
                <span style={{ color: 'var(--text-dim)' }}>{fmtWhen(r.startedAt)}</span>
                <span style={{ color: r.summary?.failed ? 'var(--red)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.summary?.error ?? counts(r.summary)}
                </span>
                <span style={{ color: 'var(--muted)' }}>{fmtDuration(r.summary?.durationSec)}</span>
                <span style={{ color: 'var(--muted)' }}>
                  {r.summary?.head ?? ''}{r.summary?.dirtyWorkingTree ? ' *' : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Recurring */}
      {data.recurring.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={sectionHeader}>Keeps coming back</span>
          {data.recurring.map(r => (
            <div key={r.test} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, fontSize: 11 }}>
              <span style={{ color: 'var(--muted)' }}>
                {r.failed > 0 && <span style={{ color: 'var(--red)' }}>{r.failed}× red </span>}
                {r.flaky > 0 && <span style={{ color: 'var(--orange)' }}>{r.flaky}× flaky </span>}
                of {r.runs}
              </span>
              <TestName name={r.test} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
