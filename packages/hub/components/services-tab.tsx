'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

interface ServiceInfo {
  name: string
  cmd: string
  cwd: string | null
  port: number | null
  type: string | null
  up: boolean
}

interface PortalStatus {
  name: string
  url: string
  port: number | null
  up: boolean
}

interface ServicesData {
  services: ServiceInfo[]
  portals: PortalStatus[]
}

interface DemoSetupRun {
  startedAt: string
  completedAt: string
  durationSeconds?: number
  status: 'ok' | 'failed' | 'timeout' | 'errored'
  exitCode: number | null
  output: string
  truncated?: boolean
}

interface DemoSetupState {
  available: boolean
  script: string
  running: boolean
  lastRun: DemoSetupRun | null
}

export function ServicesTab() {
  const api = useProjectApi()
  const [data, setData] = useState<ServicesData | null>(null)

  const load = useCallback(() => {
    api.get('/services').then((d: ServicesData) => {
      if (d.services) setData(d)
    }).catch(() => {})
  }, [api])

  useEffect(() => {
    load()
    const interval = setInterval(load, 8000)
    return () => clearInterval(interval)
  }, [load])

  if (!data) {
    return (
      <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
        Loading...
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Dev services */}
      {data.services.length > 0 && (
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.1em',
            color: 'var(--text-dim)', marginBottom: 10,
          }}>
            Dev Services
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(30%, 280px), 1fr))', gap: 8 }}>
            {data.services.map(svc => (
              <ServiceCard key={svc.name} service={svc} />
            ))}
          </div>
        </div>
      )}

      {/* Portals */}
      {data.portals.length > 0 && (
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.1em',
            color: 'var(--text-dim)', marginBottom: 10,
          }}>
            Portals
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(30%, 280px), 1fr))', gap: 8 }}>
            {data.portals.map(p => (
              <PortalCard key={p.url} portal={p} />
            ))}
          </div>
        </div>
      )}

      {data.services.length === 0 && data.portals.length === 0 && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', padding: 24 }}>
          No dev_commands or portals configured.
        </div>
      )}

      <DemoSetupSection />
    </div>
  )
}

/**
 * "Demo setup" card — shown only when the managed project has
 * scripts/demo-setup.sh. The script owns everything project-specific
 * (simulator boot, status-bar override, demo data seeding); the button
 * just runs it via POST /api/demo-setup/run and shows the result.
 */
function DemoSetupSection() {
  const api = useProjectApi()
  const [state, setState] = useState<DemoSetupState | null>(null)
  const [running, setRunning] = useState(false)
  const [showOutput, setShowOutput] = useState(false)

  useEffect(() => {
    api.get('/demo-setup').then((d: DemoSetupState) => {
      if (typeof d.available === 'boolean') setState(d)
    }).catch(() => {})
  }, [api])

  const run = useCallback(async () => {
    if (running) return
    setRunning(true)
    try {
      const d = await api.post('/demo-setup/run')
      if (d.lastRun) {
        setState(prev => prev ? { ...prev, lastRun: d.lastRun } : prev)
        if (d.lastRun.status !== 'ok') setShowOutput(true)
      }
    } finally {
      setRunning(false)
    }
  }, [api, running])

  if (!state?.available) return null

  const last = state.lastRun
  const statusColor = last
    ? last.status === 'ok' ? 'var(--green)' : last.status === 'timeout' ? 'var(--orange)' : 'var(--red)'
    : 'var(--muted)'

  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--text-dim)', marginBottom: 10,
      }}>
        Demo
      </div>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '12px 16px',
        maxWidth: 560,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
              Demo setup
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              {state.script} — seeds demo data, sets simulator to demo mode
            </div>
            {last && (
              <div
                style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginTop: 4, cursor: 'pointer' }}
                onClick={() => setShowOutput(v => !v)}
                title="Show output"
              >
                last run: <span style={{ color: statusColor, fontWeight: 600 }}>{last.status}</span>
                {typeof last.durationSeconds === 'number' && <span> · {last.durationSeconds}s</span>}
                <span> · {new Date(last.completedAt).toLocaleString()}</span>
                <span style={{ marginLeft: 6, opacity: 0.7 }}>{showOutput ? '▾ hide output' : '▸ output'}</span>
              </div>
            )}
          </div>
          <button
            onClick={run}
            disabled={running}
            style={{
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
              padding: '6px 14px', borderRadius: 6, flexShrink: 0,
              border: '1px solid var(--border)',
              background: running ? 'var(--surface)' : 'var(--accent)',
              color: running ? 'var(--muted)' : '#fff',
              cursor: running ? 'default' : 'pointer',
              opacity: running ? 0.7 : 1,
            }}
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
        {showOutput && last?.output && (
          <pre style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
            background: 'var(--bg, transparent)', border: '1px solid var(--border)',
            borderRadius: 6, padding: 10, marginTop: 10, marginBottom: 0,
            maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap',
          }}>
            {last.output}{last.truncated ? '\n… (output truncated)' : ''}
          </pre>
        )}
      </div>
    </div>
  )
}

function ServiceCard({ service }: { service: ServiceInfo }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      {/* Status dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: service.up ? 'var(--green)' : 'var(--red)',
        boxShadow: service.up ? '0 0 6px rgba(16,185,129,0.4)' : '0 0 6px rgba(239,68,68,0.3)',
      }} />

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            {service.name}
          </span>
          {service.type && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--muted)', opacity: 0.8,
            }}>
              {service.type}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          {service.port && (
            <span>port: <span style={{ color: 'var(--text-dim)' }}>{service.port}</span></span>
          )}
          {service.cwd && (
            <span>cwd: <span style={{ color: 'var(--text-dim)' }}>{service.cwd}</span></span>
          )}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginTop: 3, opacity: 0.7 }}>
          {service.cmd}
        </div>
      </div>

      {/* Status label */}
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, flexShrink: 0,
        color: service.up ? 'var(--green)' : 'var(--red)',
      }}>
        {service.up ? 'running' : 'stopped'}
      </span>
    </div>
  )
}

function PortalCard({ portal }: { portal: PortalStatus }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: portal.up ? 'var(--green)' : 'var(--red)',
        boxShadow: portal.up ? '0 0 6px rgba(16,185,129,0.4)' : '0 0 6px rgba(239,68,68,0.3)',
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
          {portal.name}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          {portal.url}
          {portal.port && <span style={{ marginLeft: 8 }}>port: <span style={{ color: 'var(--text-dim)' }}>{portal.port}</span></span>}
        </div>
      </div>

      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, flexShrink: 0,
        color: portal.up ? 'var(--green)' : 'var(--red)',
      }}>
        {portal.up ? 'up' : 'down'}
      </span>
    </div>
  )
}
