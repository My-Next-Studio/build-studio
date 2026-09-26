'use client'

import { useCallback, useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { useProject } from '@/lib/project-context'

// Content publishing: what is scheduled, what is waiting for a click, and what
// happened. Shown only in projects that enabled `content_publishing`.
//
// Three groups, because they need three different things from the owner:
//   scheduled / due   nothing — the job publishes them
//   unscheduled       a click, since a post with no date never publishes itself
//   failed            a fix, then a click; the timer never retries a failure

interface StagedFile { path: string; lang: string | null; status: string | null }
interface Attempt {
  at: string; id: string; title?: string; trigger: string; ok: boolean; state: string
  reason?: string; logFile?: string | null; urls?: Record<string, string>; dirtyPaths?: string[]
}
interface Post {
  id: string; title: string | null; status: string; publish_date: string | null
  posted_to: string | null; publishedAt: string | null; files: StagedFile[]
  state: 'scheduled' | 'due' | 'unscheduled' | 'failed' | 'published'
  lastAttempt: Attempt | null
  verify: { state: 'pending' | 'live' | 'not-live'; urls: string[] } | null
}
interface Overview {
  enabled: boolean; configured: boolean; busy: boolean; lastTick: string | null
  deferred: { at: string; id: string; reason: string } | null
  config: { staged_dir: string; command: string | null; publish_time: string; check_interval_minutes: number }
  posts: Post[]; history: Attempt[]
}

const H: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
  color: 'var(--text-dim)', margin: '22px 0 8px',
}
const TH: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = {
  padding: '6px 8px', fontSize: 11, color: 'var(--text)', borderBottom: '1px solid rgba(120,120,140,0.12)', verticalAlign: 'top',
}

const STATE_COLOR: Record<string, string> = {
  scheduled: 'var(--text-dim)', due: 'var(--orange)', unscheduled: 'var(--muted)',
  failed: 'var(--red)', published: 'var(--green)', deferred: 'var(--orange)', 'push-failed': 'var(--red)',
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

export function PublishingTab() {
  const api = useProjectApi()
  const { baseUrl } = useProject()
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState<string | null>(null)
  const [log, setLog] = useState<{ file: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get('/publishing')
      if (res && res.error) setError(String(res.error)); else { setData(res); setError(null) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [api])

  useEffect(() => {
    void load()
    const id = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(id)
  }, [load])

  const publishNow = useCallback(async (post: Post) => {
    const early = post.state === 'scheduled'
    const ok = window.confirm(
      `Publish "${post.title || post.id}" now?\n\n`
      + (early ? `It is scheduled for ${post.publish_date}. This publishes it early.\n\n` : '')
      + 'This runs the project\'s publish command, then commits and pushes to the default branch.',
    )
    if (!ok) return
    setPublishing(post.id)
    try {
      const res = await api.post('/publishing/publish', { id: post.id })
      if (res && res.error) setError(String(res.error))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setPublishing(null); void load() }
  }, [api, load])

  const openLog = useCallback(async (file: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/publishing/log?file=${encodeURIComponent(file)}`)
      setLog({ file, text: await res.text() })
    } catch (e) { setLog({ file, text: e instanceof Error ? e.message : String(e) }) }
  }, [baseUrl])

  if (error && !data) return <div style={{ padding: 16, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)' }}>{error}</div>
  if (!data) return <div style={{ padding: 16, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>Loading…</div>

  const open = data.posts.filter(p => p.state !== 'published')
  const live = data.posts.filter(p => p.state === 'published')

  return (
    <div style={{ padding: '20px 32px', overflow: 'auto', height: 'calc(100vh - 124px)', fontFamily: 'var(--mono)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)' }}>
        Content publishing
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.6, marginTop: 4, maxWidth: 760 }}>
        Posts staged in <span style={{ color: 'var(--text-dim)' }}>{data.config.staged_dir}</span> are published when their{' '}
        <span style={{ color: 'var(--text-dim)' }}>publish_date</span> arrives, at {data.config.publish_time}, checked every{' '}
        {data.config.check_interval_minutes} min while this project is running. A date that passed while Build Studio was
        closed is published at the next start. A post with no date waits for a click.
        {' '}Last check: {when(data.lastTick)}.
      </div>

      {!data.enabled && (
        <Banner tone="orange">
          Publishing is <b>off</b>. Nothing is published — not on schedule, not by hand. This is what the job would
          do: posts marked <b>due</b> publish on the first check after you set{' '}
          <b>content_publishing.enabled: true</b> (no restart needed, commit the change).
        </Banner>
      )}
      {!data.configured && (
        <Banner tone="red">No <b>content_publishing.command</b> is set, so nothing can be published. Point it at the project&apos;s own publish script.</Banner>
      )}
      {data.deferred && (
        <Banner tone="orange">Waiting to publish <b>{data.deferred.id}</b> — {data.deferred.reason}.</Banner>
      )}
      {error && <Banner tone="red">{error}</Banner>}

      <div style={H}>Scheduled and waiting · {open.length}</div>
      {open.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Nothing staged.</div>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>
            <th style={TH}>post</th><th style={TH}>languages</th><th style={TH}>publish date</th>
            <th style={TH}>state</th><th style={TH} />
          </tr></thead>
          <tbody>
            {open.map(p => (
              <tr key={p.id}>
                <td style={TD}>
                  <div>{p.title || p.id}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>{p.id}</div>
                  {p.state === 'failed' && p.lastAttempt && (
                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4, maxWidth: 560, whiteSpace: 'normal' }}>
                      {p.lastAttempt.reason}
                      {(p.lastAttempt.dirtyPaths || []).length > 0 && (
                        <> · left {p.lastAttempt.dirtyPaths!.length} uncommitted path(s) — these block the next execution run</>
                      )}
                      {p.lastAttempt.logFile && (
                        <> · <a onClick={() => void openLog(p.lastAttempt!.logFile!)} style={{ color: 'var(--accent)', cursor: 'pointer' }}>log</a></>
                      )}
                    </div>
                  )}
                </td>
                <td style={{ ...TD, color: 'var(--text-dim)' }}>{p.files.map(f => f.lang || 'en').join(', ')}</td>
                <td style={{ ...TD, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{p.publish_date || 'none'}</td>
                <td style={{ ...TD, color: STATE_COLOR[p.state], whiteSpace: 'nowrap' }}>{p.state}</td>
                <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    onClick={() => void publishNow(p)}
                    disabled={!data.enabled || !data.configured || data.busy || publishing !== null}
                    className="wf-btn secondary"
                    style={{ fontSize: 10, padding: '3px 9px' }}
                    title={!data.enabled ? 'Publishing is off for this project' : p.state === 'failed'
                      ? 'Retry. The scheduler never retries a failure on its own.'
                      : p.state === 'scheduled' ? 'Publish before its date' : 'Publish now'}
                  >
                    {publishing === p.id ? 'Publishing…' : p.state === 'failed' ? 'Retry' : 'Publish now'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {live.length > 0 && (
        <>
          <div style={H}>Published · {live.length}</div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {live.map(p => (
                <tr key={p.id}>
                  <td style={TD}>{p.title || p.id}</td>
                  <td style={{ ...TD, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{when(p.publishedAt)}</td>
                  <td style={TD}>{p.posted_to ? <a href={p.posted_to} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{p.posted_to}</a> : '—'}</td>
                  <td style={{ ...TD, whiteSpace: 'nowrap', color: p.verify?.state === 'not-live' ? 'var(--red)' : p.verify?.state === 'live' ? 'var(--green)' : 'var(--muted)' }}>
                    {p.verify ? (p.verify.state === 'pending' ? 'checking…' : p.verify.state) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div style={H}>History · {data.history.length}</div>
      {data.history.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No publish has been attempted yet.</div>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr><th style={TH}>when</th><th style={TH}>post</th><th style={TH}>trigger</th><th style={TH}>result</th><th style={TH} /></tr></thead>
          <tbody>
            {data.history.map((h, i) => (
              <tr key={`${h.at}-${i}`}>
                <td style={{ ...TD, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{when(h.at)}</td>
                <td style={TD}>{h.title || h.id}</td>
                <td style={{ ...TD, color: 'var(--muted)' }}>{h.trigger}</td>
                <td style={{ ...TD, color: STATE_COLOR[h.state] || 'var(--text)' }}>
                  {h.state}{h.reason ? <span style={{ color: 'var(--muted)' }}> — {h.reason}</span> : null}
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  {h.logFile && <a onClick={() => void openLog(h.logFile!)} style={{ color: 'var(--accent)', cursor: 'pointer', fontSize: 10 }}>log</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {log && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--text-dim)', marginBottom: 4 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{log.file}</span>
            <button onClick={() => setLog(null)} className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }}>Close</button>
          </div>
          <pre style={{
            margin: 0, padding: 12, fontSize: 11, lineHeight: 1.5, maxHeight: 360, overflow: 'auto',
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', whiteSpace: 'pre-wrap',
          }}>{log.text}</pre>
        </div>
      )}
    </div>
  )
}

function Banner({ tone, children }: { tone: 'red' | 'orange'; children: React.ReactNode }) {
  const c = tone === 'red' ? '255,95,95' : '249,115,22'
  return (
    <div style={{
      marginTop: 12, padding: '6px 10px', borderRadius: 4, fontSize: 10, lineHeight: 1.5,
      background: `rgba(${c},0.06)`, border: `1px solid rgba(${c},0.3)`,
      color: tone === 'red' ? 'var(--red)' : 'var(--orange)',
    }}>{children}</div>
  )
}
