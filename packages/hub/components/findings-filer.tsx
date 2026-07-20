'use client'

import { useCallback, useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

// One proposed backlog item the file-findings agent staged from a review step.
interface ProposalItem {
  tempId: string
  title: string
  type: 'Bug' | 'Task' | 'Feature' | 'Chore'
  release: string
  absorbs: string[]
  rationale?: string
  body: string
}
interface Proposal {
  sourceStep: string
  prefix: string
  summary: string
  items: ProposalItem[]
}
type ProposalState =
  | { status: 'none' }
  | { status: 'running'; sourceStep?: string; agentWindow?: string }
  | { status: 'ready'; proposal: Proposal }
  | { status: 'filed'; filed: { id: string; title: string }[] }

const TYPES: ProposalItem['type'][] = ['Bug', 'Task', 'Feature', 'Chore']

function sevColor(absorb: string): string {
  if (/^BLOCKING/i.test(absorb)) return 'var(--red)'
  if (/^MEDIUM/i.test(absorb)) return 'var(--orange)'
  return 'var(--muted)'
}

/**
 * The file-findings review-step button + proposal review panel. The owner
 * clicks "File findings → backlog", an agent proposes an aggressively-grouped
 * item set, and the owner approves / edits / drops items or re-proposes with a
 * note before the engine files them (two-place backlog contract, one commit).
 */
export function FindingsFiler({ sourceStep, onFiled }: { sourceStep: string; onFiled?: () => void }) {
  const api = useProjectApi()
  const [state, setState] = useState<ProposalState>({ status: 'none' })
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  // Owner edits, keyed by tempId. Absent keys keep the agent's proposal.
  const [edits, setEdits] = useState<Record<string, Partial<ProposalItem>>>({})
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const r = await api.get('/workflow/finding-proposal')
    setState(r as ProposalState)
    return r as ProposalState
  }, [api])

  useEffect(() => { refresh() }, [refresh])

  // Poll while the agent is drafting.
  useEffect(() => {
    if (state.status !== 'running') return
    const t = setInterval(refresh, 2500)
    return () => clearInterval(t)
  }, [state.status, refresh])

  async function propose(reproposeNote?: string) {
    setBusy('propose')
    setEdits({}); setDropped(new Set())
    await api.post('/workflow/advance', { action: 'propose_findings', sourceStep, note: reproposeNote || undefined })
    setNote('')
    await refresh()
    setBusy(null)
  }

  async function commit() {
    if (state.status !== 'ready') return
    setBusy('commit')
    const items = state.proposal.items
      .filter(it => !dropped.has(it.tempId))
      .map(it => ({ tempId: it.tempId, ...edits[it.tempId] }))
    const r = await api.post('/workflow/advance', { action: 'commit_findings', items })
    setBusy(null)
    if (r?.filed) { setState({ status: 'filed', filed: r.filed }); onFiled?.() }
    else await refresh()
  }

  async function discard() {
    setBusy('discard')
    await api.post('/workflow/advance', { action: 'discard_findings' })
    setBusy(null); setEdits({}); setDropped(new Set())
    await refresh()
  }

  const label = (t: string) => t.replace(/^(BLOCKING|MEDIUM|LOW)\s*[:—-]\s*/i, '')

  // ── Idle: just the trigger button ──
  if (state.status === 'none') {
    return (
      <div style={{ marginTop: 12 }}>
        <button onClick={() => propose()} disabled={busy === 'propose'} className="wf-btn secondary">
          {busy === 'propose' ? 'Starting…' : '⎘ File findings → backlog'}
        </button>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
          An agent groups this step&apos;s findings into a few backlog items for your approval.
        </div>
      </div>
    )
  }

  if (state.status === 'running') {
    return (
      <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)' }} />
        Grouping findings into backlog items… (view the <b>file-findings</b> terminal for progress)
      </div>
    )
  }

  if (state.status === 'filed') {
    return (
      <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>
        ✓ Filed {state.filed.length} item{state.filed.length === 1 ? '' : 's'}: {state.filed.map(f => f.id).join(', ')}
        <button onClick={() => setState({ status: 'none' })} className="wf-btn secondary" style={{ marginLeft: 10 }}>Done</button>
      </div>
    )
  }

  // ── Ready: the proposal review panel ──
  const { proposal } = state
  const keptCount = proposal.items.filter(it => !dropped.has(it.tempId)).length
  return (
    <div style={{
      marginTop: 12, padding: 12, borderRadius: 6,
      background: 'var(--surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)' }}>
          Proposed backlog items
        </span>
        <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>{proposal.summary}</span>
      </div>

      {proposal.items.map(it => {
        const e = edits[it.tempId] || {}
        const isDropped = dropped.has(it.tempId)
        const type = e.type || it.type
        const title = e.title ?? it.title
        return (
          <div key={it.tempId} style={{
            marginBottom: 8, padding: 10, borderRadius: 4,
            background: 'var(--bg)', border: '1px solid var(--border)',
            opacity: isDropped ? 0.4 : 1,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={!isDropped} onChange={() => {
                setDropped(prev => { const n = new Set(prev); if (n.has(it.tempId)) n.delete(it.tempId); else n.add(it.tempId); return n })
              }} title="Include this item" />
              <select value={type} disabled={isDropped}
                onChange={ev => setEdits(p => ({ ...p, [it.tempId]: { ...p[it.tempId], type: ev.target.value as ProposalItem['type'] } }))}
                style={{ fontFamily: 'var(--mono)', fontSize: 10, background: 'var(--surface2)', color: type === 'Bug' ? 'var(--red)' : 'var(--text)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 4px' }}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input value={title} disabled={isDropped}
                onChange={ev => setEdits(p => ({ ...p, [it.tempId]: { ...p[it.tempId], title: ev.target.value } }))}
                style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 6px' }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, marginLeft: 24 }}>
              {it.absorbs.map((a, i) => (
                <span key={i} style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 6px', borderRadius: 8, border: `1px solid ${sevColor(a)}`, color: sevColor(a) }}>
                  {label(a)}
                </span>
              ))}
              <span style={{ flex: 1 }} />
              <button onClick={() => setExpanded(expanded === it.tempId ? null : it.tempId)}
                style={{ fontFamily: 'var(--mono)', fontSize: 10, background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}>
                {expanded === it.tempId ? '▾ hide body' : '▸ body'}
              </button>
            </div>
            {it.rationale && !isDropped && (
              <div style={{ marginLeft: 24, marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', fontStyle: 'italic' }}>
                grouping: {it.rationale}
              </div>
            )}
            {expanded === it.tempId && (
              <pre style={{ marginTop: 8, marginLeft: 24, maxHeight: 260, overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.5, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>
                {it.body || '(empty body)'}
              </pre>
            )}
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
        <button onClick={commit} disabled={busy !== null || keptCount === 0} className="wf-btn primary">
          {busy === 'commit' ? 'Filing…' : `File ${keptCount} item${keptCount === 1 ? '' : 's'}`}
        </button>
        <button onClick={discard} disabled={busy !== null} className="wf-btn secondary">Discard</button>
        <span style={{ flex: 1 }} />
      </div>

      <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>
          Regroup with instructions (e.g. &quot;merge the two publish bugs&quot;, &quot;make LS-x a Task&quot;, &quot;combine all the lows&quot;):
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="regrouping instructions…"
            style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 8px' }} />
          <button onClick={() => propose(note)} disabled={busy !== null || !note.trim()} className="wf-btn secondary">
            {busy === 'propose' ? 'Re-proposing…' : '↻ Re-propose'}
          </button>
        </div>
      </div>
    </div>
  )
}
