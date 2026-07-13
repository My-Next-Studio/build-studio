'use client'

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { initDemoRecordingClient, demoRecorderAvailable, setDemoMicEnabled, getDemoMicEnabled } from '@/lib/demo-recording-client'

interface DemoState {
  recording: boolean
  mode?: 'manual' | 'automation' | null
  elapsedMs?: number
  automationIntervalSec?: number
  intervalOverride?: number | null
  timelapseFrames?: number
  privacyPaused?: boolean
  blur?: boolean
  currentStep?: string | null
  currentAgent?: string | null
  progress?: number
  dir?: string
}

interface DemoApi {
  available: boolean
  start: (o: { projectName: string; port: number; blur?: boolean }) => Promise<DemoState>
  stop: () => Promise<DemoState>
  getStatus: () => Promise<DemoState>
  setInterval: (sec: number) => Promise<DemoState>
  privacyPause: (on: boolean) => Promise<DemoState>
  setBlur: (on: boolean) => Promise<DemoState>
  onState: (cb: (s: DemoState) => void) => () => void
}

const INTERVALS = [1, 2, 5, 10]

function fmtElapsed(ms?: number) {
  const s = Math.floor((ms || 0) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function api(): DemoApi | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { demoRecorder?: DemoApi }).demoRecorder ?? null
}

const pill: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '2px 7px', borderRadius: 'var(--radius)', border: '1px solid var(--border-subtle)',
  background: 'var(--surface2)', color: 'var(--text-dim)', fontFamily: 'var(--mono)',
  fontSize: 9, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
}

export function DemoRecordingControl({ projectName, port }: { projectName: string | null; port: number | null }) {
  const [available] = useState(() => demoRecorderAvailable())
  const [st, setSt] = useState<DemoState>({ recording: false })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [micOn, setMicOn] = useState(true)

  useEffect(() => {
    if (!available) return
    initDemoRecordingClient({ onError: (m) => { setErr(m); setTimeout(() => setErr(null), 9000) } })
    // Restore mic narration preference (default on).
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('demoMicEnabled') : null
    const on = stored === null ? true : stored === 'true'
    setMicOn(on)
    setDemoMicEnabled(on)
    const dr = api()
    if (!dr) return
    const unsub = dr.onState((s) => setSt(s))
    dr.getStatus().then(setSt).catch(() => {})
    return () => unsub()
  }, [available])

  const start = useCallback(async () => {
    const dr = api()
    if (!dr || !projectName || !port || busy) return
    setBusy(true); setErr(null)
    try { setSt(await dr.start({ projectName, port, blur: true })) }
    catch (e) { setErr(e instanceof Error ? e.message : 'start failed') }
    finally { setBusy(false) }
  }, [projectName, port, busy])

  const stop = useCallback(async () => {
    const dr = api(); if (!dr) return
    setBusy(true)
    try { setSt(await dr.stop()) } finally { setBusy(false) }
  }, [])

  if (!available) return null

  if (err && !st.recording) {
    return <span className="app-no-drag" title={err} style={{ ...pill, color: 'var(--orange)', cursor: 'default' }}>⚠ recording</span>
  }

  if (!st.recording) {
    const disabled = !projectName || !port || busy
    return (
      <button
        onClick={start}
        disabled={disabled}
        className="app-no-drag"
        title={projectName ? `Start demo recording for ${projectName}` : 'Open a project to start a demo recording'}
        style={{ ...pill, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
        onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = 'var(--red)' }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)' }} />
        REC
      </button>
    )
  }

  const isAuto = st.mode === 'automation'
  const dr = api()
  return (
    <div className="app-no-drag" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {/* live status */}
      <span style={{ ...pill, cursor: 'default', borderColor: 'var(--red)', color: 'var(--text)' }} title={st.dir || ''}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: st.privacyPaused ? 'var(--orange)' : 'var(--red)',
          boxShadow: st.privacyPaused ? 'none' : '0 0 6px rgba(255,95,95,0.6)',
        }} />
        {st.privacyPaused ? 'PAUSED' : 'REC'}
        <span style={{ color: 'var(--muted)' }}>{fmtElapsed(st.elapsedMs)}</span>
        <span style={{ color: 'var(--border)' }}>·</span>
        <span style={{ color: 'var(--muted)' }}>
          {isAuto ? `⏱ ${st.automationIntervalSec}s · ${st.timelapseFrames || 0}f` : '● video'}
        </span>
        {isAuto && st.currentStep && (
          <span style={{ color: 'var(--muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            · {(st.currentAgent || st.currentStep).replace(/_/g, ' ')}
            {typeof st.progress === 'number' ? ` ${st.progress}%` : ''}
          </span>
        )}
      </span>

      {/* automation interval */}
      <select
        value={st.intervalOverride || st.automationIntervalSec || 5}
        onChange={(e) => dr?.setInterval(Number(e.target.value)).then(setSt).catch(() => {})}
        title="Timelapse interval (automation)"
        style={{ ...pill, padding: '2px 4px', cursor: 'pointer' }}
      >
        {INTERVALS.map((n) => <option key={n} value={n}>{n}s</option>)}
      </select>

      {/* mic narration toggle */}
      <button
        onClick={() => {
          const on = !getDemoMicEnabled()
          setDemoMicEnabled(on)
          setMicOn(on)
          try { localStorage.setItem('demoMicEnabled', String(on)) } catch { /* noop */ }
        }}
        className="app-no-drag"
        title={'Narration mic — speak notes while recording; prefix editing instructions with "Edit:". Mutes live; if the segment started muted, takes effect next segment.'}
        style={{ ...pill, color: micOn ? 'var(--green)' : 'var(--muted)' }}
      >
        🎤 {micOn ? 'on' : 'off'}
      </button>

      {/* blur toggle */}
      <button
        onClick={() => dr?.setBlur(!st.blur).then(setSt).catch(() => {})}
        className="app-no-drag"
        title="Auto-blur detected secrets/paths"
        style={{ ...pill, color: st.blur ? 'var(--green)' : 'var(--muted)' }}
      >
        blur {st.blur ? 'on' : 'off'}
      </button>

      {/* privacy pause */}
      <button
        onClick={() => dr?.privacyPause(!st.privacyPaused).then(setSt).catch(() => {})}
        className="app-no-drag"
        title="Privacy Pause — suspend all capture"
        style={{ ...pill, color: st.privacyPaused ? 'var(--orange)' : 'var(--text-dim)', borderColor: st.privacyPaused ? 'var(--orange)' : 'var(--border-subtle)' }}
      >
        {st.privacyPaused ? '▶ resume' : '⏸ privacy'}
      </button>

      {/* stop */}
      <button
        onClick={stop}
        disabled={busy}
        className="app-no-drag"
        title="Stop & finalize recording"
        style={{ ...pill, color: 'var(--red)', borderColor: 'var(--red)' }}
      >
        ■ stop
      </button>

      {err && <span title={err} style={{ ...pill, color: 'var(--orange)', cursor: 'default' }}>⚠</span>}
    </div>
  )
}
