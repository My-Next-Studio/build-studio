'use client'

import { useCallback, useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { useSSE } from '@/lib/use-sse'

// The project's work queue (docs/plans/work-queue-and-remote-overview.md):
// the jobs planned for this project, in order. Each entry takes a backlog item
// one phase further when it starts; nothing starts by itself.

interface ItemInfo { id: string; title: string; type: string | null; status: string | null; prd: string | null }
interface Entry { id: string; item: string; action?: string; note?: string; addedAt: string; itemInfo: ItemInfo | null }
interface CurrentEntry extends Entry {
  startedAt?: string
  run?: { kind: string; id?: string; type?: string }
  status?: { state: string; step?: string; detail?: string } | null
}
interface Next { entryId: string; item: string; ready: boolean; action: string | null; reason?: string; canOverride?: boolean }
interface QueueView {
  observedAt: string
  current: CurrentEntry | null
  outsideQueue: { id: string; type: string; item: string | null; step: string } | null
  pending: Entry[]
  next: Next | null
  error?: string
}

const ACTIONS = ['draft', 'review', 'execute', 'bugfix']

const STATE_LABEL: Record<string, { label: string; color: string }> = {
  running: { label: 'Running', color: 'var(--accent)' },
  waiting_for_owner: { label: 'Waiting for you', color: 'var(--orange)' },
  ready_to_merge: { label: 'Ready to merge', color: 'var(--green)' },
  finished: { label: 'Finished', color: 'var(--green)' },
  stopped: { label: 'Stopped', color: 'var(--red)' },
}

const sectionHeader: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 8,
}
const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', padding: '10px 12px',
}
const smallBtn: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 11, padding: '3px 8px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
}

export function QueueTab() {
  const api = useProjectApi()
  const [view, setView] = useState<QueueView | null>(null)
  const [itemInput, setItemInput] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.get('/work-queue').then((v: QueueView) => setView(v)).catch(() => {})
  }, [api])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  useSSE((event) => {
    if (event === 'work-queue-updated' || event === 'workflow-updated' || event === 'backlog-updated') load()
  })

  const act = async (fn: () => Promise<QueueView & { error?: string }>) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await fn()
      if (r && r.error) setMessage(r.error)
      if (r && r.pending) setView(r)
      else load()
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    const item = itemInput.trim().toUpperCase()
    if (!item) return
    act(() => api.post('/work-queue', { item })).then(() => setItemInput(''))
  }
  const move = (id: string, position: number) => act(() => api.patch(`/work-queue/${id}`, { position }))
  const setAction = (id: string, action: string) => act(() => api.patch(`/work-queue/${id}`, { action: action || null }))
  const remove = (id: string) => act(() => api.del(`/work-queue/${id}`))
  const start = (id: string, override = false) => act(() => api.post(`/work-queue/${id}/start`, override ? { override: true } : {}))

  if (!view) return <div style={{ padding: 20, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>Loading…</div>

  const st = view.current?.status ? STATE_LABEL[view.current.status.state] : null

  return (
    <div style={{ padding: 20, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
      <div style={{ color: 'var(--muted)', fontSize: 11 }}>
        Jobs for this project, in your order. Each takes its item one phase further when started (no PRD → draft,
        Drafted → review, Reviewed → execute, a bug → bugfix), unless you pick the phase. Nothing starts by itself.
      </div>

      {message && (
        <div style={{ ...card, borderColor: 'var(--red)', whiteSpace: 'pre-wrap' }}>{message}</div>
      )}

      <section>
        <div style={sectionHeader}>Current</div>
        {view.current ? (
          <div style={card}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{view.current.item}</strong>
              <span>{view.current.itemInfo?.title}</span>
              <span style={{ color: 'var(--muted)' }}>{view.current.action}</span>
              {st && <span style={{ color: st.color, fontWeight: 700 }}>{st.label}</span>}
              {view.current.status?.step && <span style={{ color: 'var(--muted)' }}>at {view.current.status.step}</span>}
              <span style={{ flex: 1 }} />
              <button style={smallBtn} disabled={busy} onClick={() => remove(view.current!.id)} title="Clear it from the queue. The run is not affected.">Clear</button>
            </div>
            {view.current.status?.detail && <div style={{ color: 'var(--muted)', marginTop: 6 }}>{view.current.status.detail}</div>}
          </div>
        ) : (
          <div style={{ color: 'var(--muted)' }}>Nothing started from the queue.</div>
        )}
        {view.outsideQueue && (
          <div style={{ ...card, marginTop: 8, borderStyle: 'dashed' }}>
            Started outside the queue: <strong>{view.outsideQueue.item || view.outsideQueue.id}</strong>{' '}
            <span style={{ color: 'var(--muted)' }}>{view.outsideQueue.type} at {view.outsideQueue.step}</span>
          </div>
        )}
      </section>

      <section>
        <div style={sectionHeader}>Next</div>
        {view.next ? (
          <div style={{ ...card, borderColor: view.next.ready ? 'var(--green)' : 'var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{view.next.item}</strong>
              <span>{view.pending[0]?.itemInfo?.title}</span>
              <span style={{ color: 'var(--muted)' }}>{view.next.action || '—'}</span>
              <span style={{ color: view.next.ready ? 'var(--green)' : 'var(--orange)', fontWeight: 700 }}>{view.next.ready ? 'Ready' : 'Not ready'}</span>
              <span style={{ flex: 1 }} />
              <button className="wf-btn primary" disabled={busy || !view.next.ready} onClick={() => start(view.next!.entryId)}>Start</button>
              {!view.next.ready && view.next.canOverride && (
                <button className="wf-btn secondary" disabled={busy} onClick={() => start(view.next!.entryId, true)}>Start anyway</button>
              )}
            </div>
            {!view.next.ready && view.next.reason && (
              <div style={{ color: 'var(--muted)', marginTop: 6, whiteSpace: 'pre-wrap' }}>{view.next.reason}</div>
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--muted)' }}>The queue is empty.</div>
        )}
      </section>

      <section>
        <div style={sectionHeader}>Queue ({view.pending.length})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {view.pending.map((e, i) => (
            <div key={e.id} style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', padding: '6px 10px' }}>
              <span style={{ color: 'var(--muted)', width: 18 }}>{i + 1}</span>
              <strong style={{ width: 70 }}>{e.item}</strong>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.itemInfo ? e.itemInfo.title : <span style={{ color: 'var(--red)' }}>item no longer exists</span>}
              </span>
              <span style={{ color: 'var(--muted)', width: 90 }}>{e.itemInfo?.status}</span>
              <select
                value={e.action || ''}
                disabled={busy}
                onChange={ev => setAction(e.id, ev.target.value)}
                style={{ fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}
                title="The phase this entry takes. Auto follows the item's status when it starts."
              >
                <option value="">auto</option>
                {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <button style={smallBtn} disabled={busy || i === 0} onClick={() => move(e.id, i - 1)} title="Move up">↑</button>
              <button style={smallBtn} disabled={busy || i === view.pending.length - 1} onClick={() => move(e.id, i + 1)} title="Move down">↓</button>
              <button style={smallBtn} disabled={busy} onClick={() => start(e.id)} title="Start this entry now">Start</button>
              <button style={smallBtn} disabled={busy} onClick={() => remove(e.id)} title="Remove from the queue. The backlog item is not touched.">✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            value={itemInput}
            onChange={e => setItemInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="Backlog id, e.g. FAZ-123"
            style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '5px 8px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, width: 220 }}
          />
          <button className="wf-btn secondary" disabled={busy || !itemInput.trim()} onClick={add}>Add to queue</button>
        </div>
      </section>
    </div>
  )
}

/**
 * The backlog row's "add to queue" button. Self-contained, in a fixed-width
 * slot so the row's status pill stays aligned (see backlog-tab's row layout).
 */
export function AddToQueueButton({ id }: { id: string }) {
  const api = useProjectApi()
  const [state, setState] = useState<'idle' | 'busy' | 'added' | 'error'>('idle')
  const [error, setError] = useState('')
  const add = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setState('busy')
    const r = await api.post('/work-queue', { item: id }) as { error?: string }
    if (r && r.error) { setError(r.error); setState('error') } else { setState('added'); setTimeout(() => setState('idle'), 2500) }
  }
  return (
    <span style={{ width: 24, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
      <button
        onClick={add}
        disabled={state === 'busy'}
        title={state === 'error' ? `Not queued: ${error}` : state === 'added' ? `${id} is in the work queue` : `Add ${id} to the work queue`}
        className="wf-btn secondary"
        style={{ fontSize: 10, padding: '3px 0', width: '100%', textAlign: 'center', color: state === 'error' ? 'var(--red)' : undefined }}
      >
        {state === 'added' ? '✓' : state === 'error' ? '!' : '+'}
      </button>
    </span>
  )
}
