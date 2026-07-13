'use client'

import { useEffect, useState, useRef } from 'react'

interface PortalTabProps {
  name: string
  url: string
}

export function PortalTab({ name, url }: PortalTabProps) {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        // Use no-cors mode — we can't read the response, but a successful fetch
        // means the server is up. A network error means it's down.
        await fetch(url, { mode: 'no-cors', cache: 'no-store' })
        if (!cancelled) setStatus('connected')
      } catch {
        if (!cancelled) setStatus('disconnected')
      }
    }

    check()
    const interval = setInterval(check, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [url])

  if (status === 'checking') {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)',
      }}>
        Connecting to {name}...
      </div>
    )
  }

  if (status === 'disconnected') {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
          color: 'var(--red)',
        }}>
          Not connected
        </span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
        }}>
          {url}
        </span>
        <button
          onClick={() => setStatus('checking')}
          style={{
            marginTop: 8, padding: '4px 12px', borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--text-dim)',
            fontFamily: 'var(--mono)', fontSize: 10,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      src={url}
      style={{
        flex: 1, width: '100%', height: '100%',
        border: 'none', background: 'var(--bg)',
      }}
      onError={() => setStatus('disconnected')}
    />
  )
}
