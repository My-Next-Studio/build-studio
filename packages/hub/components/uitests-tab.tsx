'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

interface UITestRun {
  id: string
  startedAt: string
  completedAt: string | null
  status: 'running' | 'passed' | 'failed' | 'errored' | 'cancelled'
  passed: number | null
  failed: number | null
  skipped: number | null
  durationSeconds: number | null
  logPath: string
  pid: number | null
  scheme: string | null
  destination: string | null
}

interface ListResponse {
  runs: UITestRun[]
  active: UITestRun | null
}

export function UITestsTab() {
  const api = useProjectApi()
  const [runs, setRuns] = useState<UITestRun[]>([])
  const [active, setActive] = useState<UITestRun | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [logTail, setLogTail] = useState<string>('')
  const [tailLoading, setTailLoading] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data: ListResponse = await api.get('/ops/uitests/runs')
      setRuns(data.runs || [])
      setActive(data.active || null)
      if (data.active && !selectedId) setSelectedId(data.active.id)
    } catch (e) {
      // tab disabled / endpoint missing
      setError(e instanceof Error ? e.message : 'Could not load runs')
    }
  }, [api, selectedId])

  // Refresh more often while ANY run is active. Use a stable boolean rather than the
  // `active` object — the list poll replaces the active reference on every tick, which
  // would otherwise tear down and recreate this interval every ~6s.
  const isAnyRunActive = active != null
  useEffect(() => {
    load()
    const interval = isAnyRunActive ? 6_000 : 30_000
    const id = setInterval(load, interval)
    return () => clearInterval(id)
  }, [load, isAnyRunActive])

  // When the user picks a different run, clear stale log content + show the loading
  // placeholder. Triggered ONLY by selection change — not by every list-poll tick.
  useEffect(() => {
    setLogTail('')
    if (selectedId) setTailLoading(true)
  }, [selectedId])

  // Fetch + poll the log tail for the selected run. Depend on a stable boolean
  // (`isSelectedRunning`) derived from the selected run's status, NOT on the full
  // `runs` array — the list poll mutates `runs` every few seconds and would otherwise
  // tear this effect down constantly, causing the loading placeholder to flicker
  // back into view on every list refresh (observed 2026-05-26).
  const selectedRun = runs.find(r => r.id === selectedId) || (active?.id === selectedId ? active : null)
  const isSelectedRunning = selectedRun?.status === 'running'
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    const fetchTail = async () => {
      try {
        const data: { tail: string } = await api.get(`/ops/uitests/runs/${selectedId}/log?lines=200`)
        if (!cancelled) { setLogTail(data.tail || ''); setTailLoading(false) }
      } catch {
        if (!cancelled) { setLogTail('(log unavailable)'); setTailLoading(false) }
      }
    }
    fetchTail()
    if (isSelectedRunning) {
      const id = setInterval(fetchTail, 5_000)
      return () => { cancelled = true; clearInterval(id) }
    }
    return () => { cancelled = true }
  }, [api, selectedId, isSelectedRunning])

  async function launchRun() {
    setLaunching(true)
    setError(null)
    try {
      const r: { run?: UITestRun; error?: string } = await api.post('/ops/uitests/run', {})
      if (r.error) { setError(r.error); return }
      if (r.run) {
        setSelectedId(r.run.id)
        await load()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Launch failed')
    } finally {
      setLaunching(false)
    }
  }

  async function cancelRun(id: string) {
    if (!confirm(`Cancel run ${id.slice(0, 8)}? This will kill the in-flight xcodebuild process.`)) return
    try {
      await api.post(`/ops/uitests/runs/${id}/cancel`, {})
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed')
    }
  }

  function statusBadge(r: UITestRun) {
    const map: Record<string, { color: string; label: string }> = {
      running:   { color: 'var(--blue, #4a9eff)', label: 'running' },
      passed:    { color: 'var(--green)', label: 'passed' },
      failed:    { color: 'var(--red)', label: 'failed' },
      errored:   { color: 'var(--orange)', label: 'errored' },
      cancelled: { color: 'var(--text-dim)', label: 'cancelled' },
    }
    const c = map[r.status] || map.errored
    return <span style={{
      fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, color: c.color,
      padding: '1px 6px', border: `1px solid ${c.color}`, borderRadius: 3,
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{c.label}</span>
  }

  function fmtDuration(secs: number | null) {
    if (secs == null) return '—'
    if (secs < 60) return `${secs}s`
    const m = Math.floor(secs / 60), s = secs % 60
    return `${m}m ${s}s`
  }
  function fmtCounts(r: UITestRun) {
    if (r.passed == null && r.failed == null) return '—'
    return `${r.passed ?? 0}P · ${r.failed ?? 0}F${r.skipped ? ` · ${r.skipped}S` : ''}`
  }

  const selected = runs.find(r => r.id === selectedId) || (active?.id === selectedId ? active : null)
  const isRunActive = active != null && active.status === 'running'

  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--mono)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' }}>UITests</h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Run the full XCUITest suite (regression) before pushing to remote. Day-to-day PRD execution only runs new UITests; this is the gate before CI/CD.
          </p>
        </div>
        <button
          onClick={launchRun}
          disabled={launching || isRunActive}
          style={{
            padding: '8px 18px', borderRadius: 6,
            background: isRunActive ? 'var(--surface3)' : 'var(--accent)',
            color: isRunActive ? 'var(--text-dim)' : 'var(--bg)',
            border: 'none', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
            cursor: isRunActive ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
          {isRunActive ? '▶ Run in progress…' : launching ? '⏳ Launching…' : '▶ Run full UITest suite'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(255,95,95,0.08)', border: '1px solid var(--red)', borderRadius: 4, color: 'var(--red)', fontSize: 11 }}>
          {error}
        </div>
      )}

      {/* History list */}
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)',
        marginTop: 8,
      }}>Recent runs · {runs.length} {runs.length === 5 ? '(max — older runs auto-pruned)' : ''}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {runs.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '8px 0' }}>
            No runs yet. Click ▶ Run full UITest suite to start.
          </div>
        )}
        {runs.map(r => {
          const isSelected = selectedId === r.id
          return (
            <button key={r.id}
              onClick={() => setSelectedId(r.id)}
              style={{
                display: 'grid', gridTemplateColumns: '80px 90px 90px 1fr auto', gap: 12, alignItems: 'center',
                padding: '8px 12px', textAlign: 'left',
                background: isSelected ? 'var(--surface2)' : 'var(--surface)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 5, fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
              }}>
              {statusBadge(r)}
              <span style={{ color: 'var(--text-dim)' }}>{new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span>{fmtDuration(r.durationSeconds)}</span>
              <span style={{ color: r.failed ? 'var(--red)' : 'var(--text)' }}>{fmtCounts(r)}</span>
              {r.status === 'running' && (
                <span onClick={(e) => { e.stopPropagation(); cancelRun(r.id) }}
                  style={{ fontSize: 10, color: 'var(--red)', cursor: 'pointer', padding: '2px 6px', border: '1px solid var(--red)', borderRadius: 3 }}>
                  Cancel
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Selected run details */}
      {selected && (
        <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Run {selected.id.slice(0, 8)} — {fmtCounts(selected)}</span>
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              {selected.scheme ?? 'MyApp'} · {selected.destination ?? 'default sim'} · parallel-testing-enabled YES
            </span>
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.5,
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
            padding: '8px 10px', whiteSpace: 'pre-wrap', overflow: 'auto',
            maxHeight: '50vh', color: 'var(--text)',
          }}>
            {tailLoading ? '(loading log…)' : (logTail || '(no log output yet)')}
          </div>
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)' }}>
            Log file: <code>{selected.logPath}</code>
          </div>
        </div>
      )}
    </div>
  )
}
