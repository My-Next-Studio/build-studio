'use client'

import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useProjectApi } from '@/lib/use-project-api'
import { useSSE } from '@/lib/use-sse'
import { AgentTerminal } from './agent-terminal'

// Project → Reconcile: bring work built outside Build Studio home
// (docs/plans/reconciliation-workflow.md). A track runs beside the project's
// workflow slot, so ordinary runs go on while it waits on the owner. Only its
// last phase, verification and merge, takes the slot.

interface Session { cli?: string; window: string; launchedAt?: string; endedAt?: string }
interface Agent { role: string; window?: string; status: string; feedback?: string; error?: string; docs?: boolean }
interface Step {
  status: string
  session?: Session
  agents?: Agent[]
  conflicts?: string[]
  error?: string
  importCommit?: string
  round?: number
}
interface Track {
  id: string
  status: string
  createdAt: string
  record: string
  tier: string
  currentStep: string
  branch?: string | null
  worktree?: string | null
  source: { path?: string | null; branch?: string | null; ref?: string | null; sha: string; pin: string }
  steps: Record<string, Step>
  integration?: { renumbered?: Record<string, string>; keepOut?: string[] } | null
  workflowId?: string | null
  mergeCommit?: string
}
interface Live { live: boolean; agentRunning: boolean }
interface Review { file: string; role: string; verdict: string | null; counts: string | null; content: string }

const STEPS: { key: string; name: string; hint: string }[] = [
  { key: 'intake', name: 'Intake', hint: 'The source is pinned and inventoried; the record is filed.' },
  { key: 'intent_interview', name: 'Intent interview', hint: 'You and the PM agree what the work was meant to do. The acceptance criteria come from your answers, never from the code.' },
  { key: 'integration', name: 'Integration', hint: 'The branch is built: renumbered ids, one import commit holding only what comes home.' },
  { key: 'align', name: 'Align', hint: 'The builder makes the code meet your criteria; the PM copies them into the PRDs.' },
  { key: 'team_review', name: 'Role review', hint: 'Reviewers by risk tier, each writing a review. Removals are their first check.' },
  { key: 'owner_decision', name: 'Your decisions', hint: 'The PM takes you through the findings, one question at a time.' },
  { key: 'apply', name: 'Apply', hint: 'The fixes you decided, and the document updates.' },
  { key: 'ready', name: 'Verify and merge', hint: 'QA (and Security in the Sensitive tier), then the merge, in the project\'s workflow slot.' },
]

const STATUS_COLOR: Record<string, string> = {
  done: 'var(--green)', running: 'var(--accent)', conflict: 'var(--orange)', error: 'var(--red)', pending: 'var(--muted)',
}
const TRACK_STATUS: Record<string, { label: string; color: string }> = {
  open: { label: 'Open', color: 'var(--accent)' },
  verifying: { label: 'Verifying in the workflow', color: 'var(--orange)' },
  merged: { label: 'Merged', color: 'var(--green)' },
  cancelled: { label: 'Cancelled', color: 'var(--muted)' },
}

const sectionHeader: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 8,
}
const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', padding: '10px 12px',
}
const input: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 12, padding: '5px 8px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', minWidth: 0,
}

function Btn({ label, onClick, primary = false, disabled = false, title, confirmText }: {
  label: string; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string; confirmText?: string
}) {
  return (
    <button
      className={`wf-btn ${primary ? 'primary' : 'secondary'}`}
      disabled={disabled}
      title={title}
      onClick={() => { if (confirmText && !confirm(confirmText)) return; onClick() }}
    >
      {label}
    </button>
  )
}

function Terminal({ window: w, launchedAt, label }: { window: string; launchedAt?: string; label: string }) {
  const [min, setMin] = useState(false)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', background: 'var(--surface)', borderBottom: min ? 'none' : '1px solid var(--border)', fontSize: 10, color: 'var(--text-dim)' }}>
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>{label}</span>
        <button onClick={() => setMin((m) => !m)} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {min ? 'maximise' : 'minimise'}
        </button>
      </div>
      {!min && <div style={{ height: 420 }}><AgentTerminal key={`${w}#${launchedAt || ''}`} agentWindow={w} /></div>}
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  return <div className="md-rendered" style={{ fontSize: 12 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
}

export function ReconcileTab() {
  const api = useProjectApi()
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ track: Track; intake: string | null; live: Record<string, Live> } | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [form, setForm] = useState({ sourcePath: '', branch: '', ref: '', brief: '' })
  const [refusal, setRefusal] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const [openReview, setOpenReview] = useState<string | null>(null)
  const [showIntake, setShowIntake] = useState(false)

  const loadList = useCallback(() => {
    api.get('/reconcile').then((r: { tracks?: Track[] }) => {
      const list = r.tracks || []
      setTracks(list)
      setSelected((s) => s || (list.filter((t) => t.status === 'open' || t.status === 'verifying').slice(-1)[0]?.id ?? null))
    }).catch(() => setTracks([]))
  }, [api])

  const loadDetail = useCallback(() => {
    if (!selected) { setDetail(null); return }
    api.get(`/reconcile/${selected}`).then((r) => { if (r.track) setDetail(r) }).catch(() => {})
    api.get(`/reconcile/${selected}/reviews`).then((r) => setReviews(r.reviews || [])).catch(() => {})
  }, [api, selected])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => {
    loadDetail()
    const t = setInterval(() => { loadDetail(); loadList() }, 8000)
    return () => clearInterval(t)
  }, [loadDetail, loadList])
  useSSE((event) => { if (event === 'workflow-updated' || event === 'backlog-updated') { loadList(); loadDetail() } })

  const act = async (fn: () => Promise<Record<string, unknown>>) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await fn()
      if (r && typeof r.error === 'string') setMessage(r.error)
      loadList()
      loadDetail()
      return r
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    setRefusal(null)
    const body = form.sourcePath.trim()
      ? { sourcePath: form.sourcePath.trim(), branch: form.branch.trim() || undefined, brief: form.brief.trim() || undefined }
      : { ref: form.ref.trim(), brief: form.brief.trim() || undefined }
    const r = await act(() => api.post('/reconcile/start', body))
    if (r && r.refused) setRefusal(String(r.markdown || ''))
    if (r && typeof r.recordId === 'string') { setSelected(r.recordId); setForm({ sourcePath: '', branch: '', ref: '', brief: '' }) }
  }

  const t = detail?.track
  const step = t ? t.steps[t.currentStep] || { status: 'pending' } : null
  const open = t?.status === 'open'

  const sessionPanel = (stepKey: 'intent_interview' | 'owner_decision') => {
    const s = t!.steps[stepKey] || { status: 'pending' }
    const live = detail?.live?.[stepKey]
    const running = !!live?.agentRunning
    const started = !!s.session
    const what = stepKey === 'intent_interview' ? 'interview' : 'decisions'
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!started && <Btn primary disabled={busy || !open} label={`Start ${what} →`} onClick={() => act(() => api.post(`/reconcile/${t!.id}/session/${stepKey}`, { action: 'launch' }))} title="Open an interactive PM session" />}
          {started && !running && <Btn primary disabled={busy || !open} label={`Resume ${what}`} onClick={() => act(() => api.post(`/reconcile/${t!.id}/session/${stepKey}`, { action: 'launch' }))} title="Continue the same conversation" />}
          {running && <Btn disabled={busy} label="End session" onClick={() => act(() => api.post(`/reconcile/${t!.id}/session/${stepKey}`, { action: 'end' }))} title="Stop the agent; the conversation is kept and can be resumed" />}
          {started && <Btn primary={!running} disabled={busy || !open} label={`Finish ${what} →`} onClick={() => act(() => api.post(`/reconcile/${t!.id}/session/${stepKey}`, { action: 'finish' }))} title="Commit what the session wrote and move on" />}
        </div>
        {started && <Terminal window={s.session!.window} launchedAt={s.session!.launchedAt} label={`${what} ${running ? '· live' : '· ended'}${s.session!.cli ? ` · ${s.session!.cli}` : ''}`} />}
      </div>
    )
  }

  const agentPanel = (stepKey: 'align' | 'team_review' | 'apply') => {
    const s = t!.steps[stepKey] || { status: 'pending' }
    const agents = s.agents || []
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {s.status !== 'running' && <Btn primary disabled={busy || !open} label={agents.length ? 'Relaunch agents' : 'Launch agents →'} onClick={() => act(() => api.post(`/reconcile/${t!.id}/step/${stepKey}`, { action: 'launch' }))} />}
          {(s.status === 'running' || s.status === 'error') && (
            <Btn disabled={busy || !open} label="Close step by hand" onClick={() => act(() => api.post(`/reconcile/${t!.id}/step/${stepKey}`, { action: 'complete' }))}
              title="For an agent that finished but will not report" confirmText="Close this step even though not every agent has reported?" />
          )}
        </div>
        {s.error && <div style={{ ...card, borderColor: 'var(--red)', marginTop: 8, whiteSpace: 'pre-wrap' }}>{s.error}</div>}
        {agents.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            {agents.map((a) => (
              <div key={a.role} style={card}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <strong>{a.role}</strong>
                  {a.docs && <span style={{ color: 'var(--muted)' }}>docs branch</span>}
                  <span style={{ color: STATUS_COLOR[a.status] || 'var(--muted)' }}>{a.status === 'done' ? 'reported' : a.status}</span>
                  <span style={{ flex: 1 }} />
                  {a.window && <button className="wf-btn secondary" onClick={() => setOpenAgent(openAgent === a.window ? null : a.window!)}>{openAgent === a.window ? 'hide terminal' : 'terminal'}</button>}
                </div>
                {a.error && <div style={{ color: 'var(--red)', marginTop: 4 }}>{a.error}</div>}
                {a.feedback && <div style={{ color: 'var(--muted)', marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{a.feedback.slice(0, 800)}</div>}
                {openAgent === a.window && a.window && <Terminal window={a.window} label={a.role} />}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const reviewList = reviews.length > 0 && (
    <section>
      <div style={sectionHeader}>Reviews</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reviews.map((r) => (
          <div key={r.file} style={card}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', cursor: 'pointer' }} onClick={() => setOpenReview(openReview === r.file ? null : r.file)}>
              <strong>{r.role}</strong>
              <span style={{ color: /pushback/i.test(r.verdict || '') ? 'var(--red)' : 'var(--green)' }}>{r.verdict || '—'}</span>
              <span style={{ color: 'var(--muted)' }}>{r.counts}</span>
            </div>
            {openReview === r.file && <div style={{ marginTop: 8 }}><Markdown text={r.content} /></div>}
          </div>
        ))}
      </div>
    </section>
  )

  return (
    <div style={{ padding: 20, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 980 }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5 }}>
        Bring work built outside Build Studio home — a branch iterated freely in Codex, Claude or a chat app.
        It is reviewed and integrated like any other change, not merged as it is. The source must be committed;
        Build Studio never writes in it or cleans it up. Ordinary runs continue while a track is open.
      </div>

      {message && <div style={{ ...card, borderColor: 'var(--red)', whiteSpace: 'pre-wrap' }}>{message}</div>}

      <section>
        <div style={sectionHeader}>Start a reconcile</div>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...input, flex: 3 }} placeholder="Path to the clone or worktree" value={form.sourcePath} onChange={(e) => setForm({ ...form, sourcePath: e.target.value })} />
            <input style={{ ...input, flex: 1 }} placeholder="Branch (default: its current)" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} disabled={!form.sourcePath} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: 'var(--muted)' }}>or a ref in this repo</span>
            <input style={{ ...input, flex: 1 }} placeholder="branch or commit" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} disabled={!!form.sourcePath} />
            <input style={{ ...input, flex: 2 }} placeholder="Brief in the source (optional), e.g. docs/inputs/handover.md" value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
            <Btn primary disabled={busy || (!form.sourcePath.trim() && !form.ref.trim())} label="Run intake →" onClick={start} />
          </div>
        </div>
        {refusal && <div style={{ ...card, borderColor: 'var(--orange)', marginTop: 8 }}><Markdown text={refusal} /></div>}
      </section>

      {tracks && tracks.length > 0 && (
        <section>
          <div style={sectionHeader}>Tracks</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...tracks].reverse().map((tr) => {
              const st = TRACK_STATUS[tr.status] || { label: tr.status, color: 'var(--muted)' }
              return (
                <div key={tr.id} onClick={() => setSelected(tr.id)} style={{ ...card, cursor: 'pointer', borderColor: selected === tr.id ? 'var(--accent)' : 'var(--border)', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <strong>{tr.id}</strong>
                  <span>{tr.source.branch || tr.source.ref}</span>
                  <span style={{ color: st.color, fontWeight: 700 }}>{st.label}</span>
                  {tr.status === 'open' && <span style={{ color: 'var(--muted)' }}>at {STEPS.find((s) => s.key === tr.currentStep)?.name || tr.currentStep}</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ color: 'var(--muted)' }}>{tr.tier}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {t && step && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={sectionHeader}>{t.id} · {t.source.branch || t.source.ref} · {t.tier}</div>

          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {STEPS.map((s) => {
              const ss = t.steps[s.key] || { status: 'pending' }
              const current = s.key === t.currentStep
              return (
                <div key={s.key} title={s.hint} style={{ padding: '3px 8px', borderRadius: 4, border: `1px solid ${current ? 'var(--accent)' : 'var(--border)'}`, color: STATUS_COLOR[ss.status] || 'var(--muted)', fontWeight: current ? 700 : 400 }}>
                  {s.name}
                </div>
              )
            })}
          </div>

          <div style={card}>
            <div style={{ color: 'var(--muted)', marginBottom: 10 }}>{STEPS.find((s) => s.key === t.currentStep)?.hint}</div>

            {t.status === 'verifying' && <div>Handed to the workflow ({t.workflowId}). Follow it in Project → Workflow.</div>}
            {t.status === 'merged' && <div style={{ color: 'var(--green)' }}>Merged{t.mergeCommit ? ` (${t.mergeCommit.slice(0, 8)})` : ''}. The source is untouched; remove it when you like.</div>}

            {open && (t.currentStep === 'intent_interview' || t.currentStep === 'owner_decision') && sessionPanel(t.currentStep)}

            {open && t.currentStep === 'integration' && (
              <div>
                {step.status !== 'conflict' && <Btn primary disabled={busy} label="Build the integration branch →" onClick={() => act(() => api.post(`/reconcile/${t.id}/integrate`, { action: 'run' }))} />}
                {step.status === 'conflict' && (
                  <div>
                    <div style={{ marginBottom: 8 }}>
                      The import conflicts in {step.conflicts?.length} file(s). Resolve them in <code>{t.worktree}</code> (or ask an agent there), <code>git add</code> them, then continue.
                    </div>
                    <ul style={{ margin: '0 0 10px 16px' }}>{(step.conflicts || []).map((c) => <li key={c}>{c}</li>)}</ul>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn primary disabled={busy} label="Continue →" onClick={() => act(() => api.post(`/reconcile/${t.id}/integrate`, { action: 'continue' }))} />
                      <Btn disabled={busy} label="Abort" onClick={() => act(() => api.post(`/reconcile/${t.id}/integrate`, { action: 'abort' }))} confirmText="Throw the integration branch away and start the step again?" />
                    </div>
                  </div>
                )}
              </div>
            )}

            {open && (t.currentStep === 'align' || t.currentStep === 'team_review' || t.currentStep === 'apply') && agentPanel(t.currentStep)}

            {open && t.currentStep === 'ready' && (
              <Btn primary disabled={busy} label="Start verification →"
                title="Takes over the project's workflow slot: QA, Security in the Sensitive tier, then the merge"
                onClick={async () => {
                  const r = await act(() => api.post('/workflow/start', { type: 'reconcile', input: t.id }))
                  if (r && !r.error) setMessage(null)
                }} />
            )}

            {t.integration && t.steps.integration?.status === 'done' && (
              <div style={{ color: 'var(--muted)', marginTop: 10 }}>
                Branch <code>{t.branch}</code>.
                {t.integration.keepOut && t.integration.keepOut.length > 0 && <> Kept out: {t.integration.keepOut.join(', ')}.</>}
                {t.integration.renumbered && Object.keys(t.integration.renumbered).length > 0 && <> Renumbered: {Object.entries(t.integration.renumbered).map(([a, b]) => `${a} → ${b}`).join(', ')}.</>}
              </div>
            )}
          </div>

          {reviewList}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {detail?.intake && <Btn label={showIntake ? 'Hide intake report' : 'Intake report'} onClick={() => setShowIntake((s) => !s)} />}
            <span style={{ color: 'var(--muted)' }}>Record: <code>{t.record}</code></span>
            <span style={{ flex: 1 }} />
            {open && <Btn disabled={busy} label="Cancel track" onClick={() => act(() => api.post(`/reconcile/${t.id}/cancel`, { reason: 'cancelled from the hub' }))}
              confirmText="Cancel this reconcile? The branch and the pin stay; the id floor is lifted." />}
          </div>
          {showIntake && detail?.intake && <div style={card}><Markdown text={detail.intake} /></div>}
        </section>
      )}
    </div>
  )
}
