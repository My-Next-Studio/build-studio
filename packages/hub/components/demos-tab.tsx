'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface RecSummary { id: string; project: string | null; kind: string; durationMs: number | null; cutCount: number; latestCut: string | null; hasNotes: boolean; hasMaster: boolean }
interface CutV { version: number; file: string; durationSec: number }
interface EdlV { version: number; file: string }
interface DemoNote { id: string; t: number; type: string; text: string }
interface Detail { id: string; project: string | null; kind: string; durationMs: number | null; eventCount: number; cuts: CutV[]; edls: EdlV[]; latestEdl: EdlV | null; notes: DemoNote[]; hasMaster: boolean; hasManus: boolean }
interface PendingEdit { from: number; to: number; factor?: number; cut?: boolean; label: string }

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const mono = 'var(--mono)'

export function DemosTab() {
  const [recs, setRecs] = useState<RecSummary[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    const r = await fetch('/api/demos').then((x) => x.json()).catch(() => ({ recordings: [] }))
    setRecs(r.recordings || [])
  }, [])
  useEffect(() => { loadList() }, [loadList])

  const loadDetail = useCallback(async (id: string) => {
    const d = await fetch(`/api/demos/${id}`).then((x) => x.json())
    setDetail(d?.error ? null : d)
  }, [])
  useEffect(() => { if (sel) loadDetail(sel) }, [sel, loadDetail])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: 'calc(100vh - 124px)' }}>
      {/* recordings list */}
      <div style={{ borderRight: '1px solid var(--border-subtle)', overflow: 'auto', padding: 12 }}>
        <RecordPanel onStopped={async (id) => { await loadList(); if (id) setSel(id) }} />
        <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', margin: '4px 4px 10px' }}>
          Recordings ({recs.length})
        </div>
        {recs.length === 0 && <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--muted)', padding: 8 }}>No recordings yet. Record a demo from a project's Development tab.</div>}
        {recs.map((r) => (
          <button key={r.id} onClick={() => setSel(r.id)} style={{
            display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, padding: '8px 10px',
            borderRadius: 'var(--radius)', border: '1px solid var(--border)',
            background: sel === r.id ? 'var(--surface2)' : 'transparent', cursor: 'pointer',
            fontFamily: mono, color: 'var(--text)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>{r.project || r.id.slice(0, 16)}</div>
            <div style={{ fontSize: 9, color: 'var(--muted)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span>{r.id.slice(0, 10)}</span>
              {r.durationMs ? <span>· {fmt(r.durationMs / 1000)}</span> : null}
              <span>· {r.kind}</span>
              {r.cutCount > 0 && <span style={{ color: 'var(--green)' }}>· {r.cutCount} cut{r.cutCount > 1 ? 's' : ''}</span>}
              {r.hasMaster && <span style={{ color: 'var(--accent)' }}>· master</span>}
            </div>
          </button>
        ))}
      </div>

      {/* editor */}
      <div style={{ overflow: 'auto', padding: 20 }}>
        {!sel && <div style={{ fontFamily: mono, fontSize: 12, color: 'var(--muted)', padding: 40 }}>Select a recording to edit.</div>}
        {sel && detail && (
          <Editor key={sel} detail={detail} busy={busy} setBusy={setBusy} err={err} setErr={setErr}
            reload={async () => { await loadDetail(sel); await loadList() }} />
        )}
      </div>
    </div>
  )
}

function Editor({ detail, busy, setBusy, err, setErr, reload }: {
  detail: Detail; busy: string | null; setBusy: (s: string | null) => void; err: string | null; setErr: (s: string | null) => void; reload: () => Promise<void>
}) {
  const id = detail.id
  const videoRef = useRef<HTMLVideoElement>(null)
  const [mode, setMode] = useState<'cut' | 'notes'>('cut')
  const [target, setTarget] = useState(300)
  const latestV = detail.latestEdl?.version ?? (detail.cuts.length ? detail.cuts[detail.cuts.length - 1].version : null)
  const playFile = latestV ? `rough-cut.v${latestV}.mp4` : null

  // ── rough-cut edit state ──
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState<number | null>(null)
  const [edits, setEdits] = useState<PendingEdit[]>([])
  const cur = () => videoRef.current?.currentTime ?? 0
  const addEdit = (label: string, patch: Partial<PendingEdit>) => {
    const from = inSec, to = outSec ?? (videoRef.current?.duration ?? from)
    if (to - from < 0.2) { setErr('Set an IN and OUT range first (it is too short).'); return }
    setEdits((e) => [...e, { from, to, label, ...patch }])
  }

  async function generate() {
    setBusy('Rendering rough cut…'); setErr(null)
    try {
      const r = await fetch(`/api/demos/${id}/rough-cut`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) }).then((x) => x.json())
      if (r.error) setErr(r.error); else { setEdits([]); await reload() }
    } finally { setBusy(null) }
  }
  async function applyEdits() {
    if (!latestV || !edits.length) return
    setBusy('Applying edits & re-rendering…'); setErr(null)
    try {
      const r = await fetch(`/api/demos/${id}/edits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromVersion: latestV, edits }) }).then((x) => x.json())
      if (r.error) setErr(r.error); else { setEdits([]); setOutSec(null); setInSec(0); await reload() }
    } finally { setBusy(null) }
  }

  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontFamily: mono, fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{detail.project || id}</h2>
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted)' }}>{id} · {detail.kind}{detail.durationMs ? ` · source ${fmt(detail.durationMs / 1000)}` : ''}</span>
      </div>

      {playFile ? (
        <video ref={videoRef} controls src={`/api/demos/${id}/file?file=${playFile}`} style={{ width: '100%', borderRadius: 8, background: '#000', marginBottom: 10 }} />
      ) : (
        <div style={{ padding: 30, border: '1px dashed var(--border)', borderRadius: 8, fontFamily: mono, fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
          No rough cut yet. Generate one below.
        </div>
      )}

      {/* rough-cut generation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>
          {latestV ? `Cut v${latestV}` : 'No cut'}{detail.cuts.length ? ` · ${fmt(detail.cuts[detail.cuts.length - 1].durationSec)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted)' }}>target&nbsp;
          <input type="number" value={target} min={30} max={1200} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: 56, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontFamily: mono, fontSize: 11, padding: '2px 4px' }} />s
        </label>
        <Btn onClick={generate} disabled={!!busy} primary={!latestV}>{latestV ? 'Regenerate' : 'Generate rough cut'}</Btn>
      </div>

      {/* mode toggle */}
      {latestV && (
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-subtle)', marginBottom: 12 }}>
          {(['cut', 'notes'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: '6px 12px', border: 'none', background: 'transparent',
              borderBottom: mode === m ? '2px solid var(--accent)' : '2px solid transparent',
              color: mode === m ? 'var(--text)' : 'var(--text-dim)', fontFamily: mono, fontSize: 11, fontWeight: 600, cursor: 'pointer', marginBottom: -1,
            }}>{m === 'cut' ? 'Rough cut' : 'Notes'}</button>
          ))}
        </div>
      )}

      {busy && <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--accent)', marginBottom: 10 }}>⏳ {busy}</div>}
      {err && <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--red)', background: 'rgba(255,95,95,0.08)', border: '1px solid rgba(255,95,95,0.2)', borderRadius: 4, padding: '6px 10px', marginBottom: 10 }}>{err}</div>}

      {latestV && mode === 'cut' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>Selection</span>
            <code style={{ fontFamily: mono, fontSize: 11, color: 'var(--accent)' }}>{fmt(inSec)} → {outSec != null ? fmt(outSec) : '—'}</code>
            <Btn onClick={() => setInSec(cur())}>Set IN @ {fmt(cur())}</Btn>
            <Btn onClick={() => setOutSec(cur())}>Set OUT @ {fmt(cur())}</Btn>
            <Btn onClick={() => { setInSec(0); setOutSec(null) }}>Clear</Btn>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            <Btn onClick={() => addEdit('cut', { cut: true })}>✂ Cut</Btn>
            <Btn onClick={() => addEdit('speed ×2', { factor: 2 })}>⏩ Speed up</Btn>
            <Btn onClick={() => addEdit('speed ×3.5', { factor: 3.5 })}>⏩⏩ A lot</Btn>
            <Btn onClick={() => addEdit('slow ×0.5', { factor: 0.5 })}>🐢 Slow down</Btn>
          </div>
          {edits.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              {edits.map((e, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: mono, fontSize: 11, color: 'var(--text-dim)', padding: '4px 0' }}>
                  <code style={{ color: e.cut ? 'var(--red)' : 'var(--accent)' }}>{fmt(e.from)}–{fmt(e.to)}</code>
                  <span>{e.label}</span>
                  <button onClick={() => setEdits((x) => x.filter((_, j) => j !== i))} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>✕</button>
                </div>
              ))}
              <Btn onClick={applyEdits} disabled={!!busy} primary>Apply &amp; render ({edits.length})</Btn>
            </div>
          )}
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted)', lineHeight: 1.6 }}>
            Scrub the player, hit <b>Set IN</b> / <b>Set OUT</b> to mark a range, then an action. Edits stack; Apply re-renders a new cut version. Source clips are never modified.
          </div>
        </div>
      )}

      {latestV && mode === 'notes' && <NotesPanel id={id} videoRef={videoRef} initial={detail.notes} cut={playFile!} setErr={setErr} />}
    </div>
  )
}

function NotesPanel({ id, videoRef, initial, cut, setErr }: { id: string; videoRef: React.RefObject<HTMLVideoElement | null>; initial: DemoNote[]; cut: string; setErr: (s: string | null) => void }) {
  const [notes, setNotes] = useState<DemoNote[]>(initial)
  const [lang, setLang] = useState('sv-SE')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useCallback((next: DemoNote[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      fetch(`/api/demos/${id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meta: { cut }, notes: next }) }).catch(() => {})
    }, 400)
  }, [id, cut])
  const update = (next: DemoNote[]) => { const s = [...next].sort((a, b) => a.t - b.t); setNotes(s); save(s) }
  const addNote = useCallback(() => {
    const v = videoRef.current; if (v) v.pause()
    update([...notes, { id: Math.random().toString(36).slice(2, 9), t: +(v?.currentTime ?? 0).toFixed(2), type: 'note', text: '' }])
  }, [notes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (['TEXTAREA', 'INPUT', 'SELECT'].includes((document.activeElement?.tagName) || '')) return
      if (e.key.toLowerCase() === 'n') { e.preventDefault(); addNote() }
    }
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h)
  }, [addNote])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Btn onClick={addNote} primary>＋ Note @ {fmt(videoRef.current?.currentTime ?? 0)} (N)</Btn>
        <label style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted)' }}>🎤
          <select value={lang} onChange={(e) => setLang(e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontFamily: mono, fontSize: 10, marginLeft: 4 }}>
            <option value="sv-SE">Svenska</option><option value="en-US">English</option>
          </select>
        </label>
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted)' }}>or macOS dictation (Ctrl·Ctrl)</span>
      </div>
      {notes.map((n) => (
        <div key={n.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderLeft: `3px solid ${n.type === 'highlight' ? 'var(--accent)' : n.type === 'technical' ? '#60a5fa' : n.type === 'cut' ? 'var(--red)' : 'var(--border)'}`, borderRadius: 8, padding: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = n.t }} style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}>{fmt(n.t)}</button>
            <select value={n.type} onChange={(e) => update(notes.map((x) => x.id === n.id ? { ...x, type: e.target.value } : x))} style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, fontFamily: mono, fontSize: 10 }}>
              {['note', 'highlight', 'technical', 'cut'].map((t) => <option key={t}>{t}</option>)}
            </select>
            <MicBtn lang={lang} onText={(txt) => update(notes.map((x) => x.id === n.id ? { ...x, text: txt } : x))} current={() => notes.find((x) => x.id === n.id)?.text || ''} setErr={setErr} />
            <button onClick={() => update(notes.filter((x) => x.id !== n.id))} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>✕</button>
          </div>
          <textarea value={n.text} onChange={(e) => update(notes.map((x) => x.id === n.id ? { ...x, text: e.target.value } : x))} placeholder="What happens here / what to highlight…"
            style={{ width: '100%', minHeight: 46, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 6, fontFamily: mono, fontSize: 12, resize: 'vertical' }} />
        </div>
      ))}
      {notes.length === 0 && <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--muted)' }}>Pause at a moment, press N, and dictate. Tag each note; I turn them into the manuscript.</div>}
    </div>
  )
}

// Web Speech dictation appended to the active note (Chrome). macOS dictation works in the textarea regardless.
function MicBtn({ lang, onText, current, setErr }: { lang: string; onText: (t: string) => void; current: () => string; setErr: (s: string | null) => void }) {
  const [on, setOn] = useState(false)
  const recRef = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const toggle = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!SR) { setErr('No in-browser speech here — use macOS dictation (System Settings → Keyboard → Dictation).'); return }
    if (on) { recRef.current?.stop(); setOn(false); return }
    const rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = lang
    const base = current() ? current() + ' ' : ''
    rec.onresult = (ev: any) => { let s = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) s += ev.results[i][0].transcript; onText(base + s) } // eslint-disable-line @typescript-eslint/no-explicit-any
    rec.onerror = (ev: any) => { setOn(false); if (ev.error === 'network') setErr('Chrome speech needs internet — use macOS dictation.'); else if (ev.error !== 'no-speech' && ev.error !== 'aborted') setErr('Speech: ' + ev.error) } // eslint-disable-line @typescript-eslint/no-explicit-any
    rec.onend = () => setOn(false)
    recRef.current = rec; rec.start(); setOn(true)
  }
  return <button onClick={toggle} title="Live dictation" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, opacity: on ? 1 : 0.6, color: on ? 'var(--red)' : 'var(--text-dim)' }}>🎤</button>
}

// New-recording panel — Phase 2a (iOS simulator via simctl) + Phase 2b
// (any window/screen via desktopCapturer + MediaRecorder). Both produce an
// external recording that appears in the list and flows through the editor.
interface RecStatus { recording: boolean; source?: string; elapsedMs?: number; markers?: number; project?: string | null; booted?: { udid: string; name: string }[] }
interface CaptureSource { id: string; name: string; thumbnail: string | null }
interface DemoBridge { listCaptureSources?: () => Promise<CaptureSource[]>; setCaptureSource?: (id: string | null) => Promise<boolean> }
function bridge(): DemoBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { demoRecorder?: DemoBridge }).demoRecorder ?? null
}
function pickMime(): string | undefined {
  const MR = (typeof window !== 'undefined' ? (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder : undefined)
  for (const c of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MR?.isTypeSupported?.(c)) return c
  return undefined
}

function RecordPanel({ onStopped }: { onStopped: (id?: string) => void }) {
  const [st, setSt] = useState<RecStatus>({ recording: false, booted: [] })
  const [project, setProject] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const winRec = useRef<{ rec: MediaRecorder; stream: MediaStream; pending: Promise<unknown>[] } | null>(null)
  const canWindow = !!bridge()?.listCaptureSources

  const poll = useCallback(async () => {
    const s = await fetch('/api/demos/record/status').then((x) => x.json()).catch(() => null)
    if (s && !s.error) setSt(s)
  }, [])
  useEffect(() => { poll(); const i = setInterval(poll, 2000); return () => clearInterval(i) }, [poll])

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/demos/record', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) }).then((x) => x.json())
      if (r.error) { setErr(r.error); return r }
      if (action === 'stop') onStopped(r.dir)
      await poll(); return r
    } finally { setBusy(false) }
  }

  // ── window/screen capture ──
  async function openPicker() {
    const dr = bridge()
    if (!dr?.listCaptureSources) { setErr('Window capture needs the desktop app.'); return }
    setBusy(true); setErr(null)
    try { setSources(await dr.listCaptureSources()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'could not list windows') }
    finally { setBusy(false) }
  }
  async function startWindow(sourceId: string) {
    const dr = bridge(); setSources(null)
    if (!dr?.setCaptureSource) return
    setBusy(true); setErr(null)
    let stream: MediaStream | null = null
    try {
      await dr.setCaptureSource(sourceId)
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      const r = await fetch('/api/demos/record', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start-window', project: project || null }) }).then((x) => x.json())
      if (r.error) { stream.getTracks().forEach((t) => t.stop()); setErr(r.error); return }
      const mime = pickMime()
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 }) : new MediaRecorder(stream)
      const ref = { rec, stream, pending: [] as Promise<unknown>[] }
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) ref.pending.push(e.data.arrayBuffer().then((buf) => fetch('/api/demos/record/chunk', { method: 'POST', body: buf })).catch(() => {}))
      }
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { void stopWindow() }) // user hit OS "stop sharing"
      winRec.current = ref
      rec.start(1000)
      await poll()
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop())
      try { await dr.setCaptureSource(null) } catch { /* */ }
      setErr(e instanceof Error ? (e.name === 'NotAllowedError' ? 'Screen-Recording permission needed (System Settings → Privacy).' : e.message) : 'window capture failed')
    } finally { setBusy(false) }
  }
  async function stopWindow() {
    const wr = winRec.current; winRec.current = null
    if (wr) {
      try { if (wr.rec.state !== 'inactive') wr.rec.stop() } catch { /* */ }
      await new Promise((r) => setTimeout(r, 400))   // let the final dataavailable fire
      try { await Promise.all(wr.pending) } catch { /* */ } // ensure all chunks uploaded
      try { wr.stream.getTracks().forEach((t) => t.stop()) } catch { /* */ }
    }
    await act('stop')
  }

  const booted = st.booted || []
  const windowMode = !!winRec.current
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 10, marginBottom: 14, background: 'var(--surface)' }}>
      <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 8 }}>New recording</div>
      {st.recording ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontFamily: mono, fontSize: 11, color: 'var(--text)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--red)', boxShadow: '0 0 6px rgba(255,95,95,0.6)' }} />
            REC {fmt((st.elapsedMs || 0) / 1000)} · {st.source === 'window' ? 'window' : st.project} {st.markers ? `· ${st.markers} marks` : ''}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn onClick={() => act('marker', { type: 'highlight', label: 'highlight' })} disabled={busy}>★ Mark</Btn>
            <Btn onClick={() => (windowMode ? stopWindow() : act('stop'))} disabled={busy} primary>■ Stop</Btn>
          </div>
        </>
      ) : (
        <>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="project / label (optional)"
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '4px 8px', borderRadius: 4, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: mono, fontSize: 11 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Btn onClick={() => act('start-simulator', { project: project || null })} disabled={busy || !booted.length} primary>● Simulator</Btn>
            <Btn onClick={openPicker} disabled={busy || !canWindow}>🖥 Window / screen</Btn>
          </div>
          <div style={{ fontFamily: mono, fontSize: 9, color: 'var(--muted)', marginTop: 6 }}>
            {booted.length ? `Simulator: ${booted[0].name}` : 'No booted simulator'}{canWindow ? '' : ' · window capture needs the desktop app'}
          </div>
        </>
      )}
      {err && <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--red)', marginTop: 6 }}>{err}</div>}

      {sources && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => { setSources(null); bridge()?.setCaptureSource?.(null) }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, maxWidth: 760, width: '90vw', maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>Pick a window or screen to record</div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
              {sources.map((s) => (
                <button key={s.id} onClick={() => startWindow(s.id)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: 6, cursor: 'pointer', textAlign: 'left' }}>
                  {s.thumbnail ? <img src={s.thumbnail} alt="" style={{ width: '100%', borderRadius: 4, display: 'block', background: '#000' }} /> : <div style={{ height: 90, background: '#000', borderRadius: 4 }} />}
                  <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--text)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Btn({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '5px 11px', borderRadius: 'var(--radius)', cursor: disabled ? 'not-allowed' : 'pointer',
      border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'var(--surface2)',
      color: primary ? '#111114' : 'var(--text)', fontFamily: mono, fontSize: 11, fontWeight: 600, opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
  )
}
