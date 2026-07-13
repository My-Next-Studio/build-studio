'use client'

import { useEffect, useRef, useState } from 'react'
import { useProject } from '@/lib/project-context'

export function TerminalPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { baseUrl } = useProject()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<unknown>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!visible || !containerRef.current) return

    let cancelled = false

    async function init() {
      // Dynamic imports to avoid SSR issues
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      if (cancelled || !containerRef.current) return

      const term = new Terminal({
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        fontSize: 12,
        theme: {
          background: '#0d0f14',
          foreground: '#e2e8f0',
          cursor: '#60a5fa',
          selectionBackground: '#2a2e3a',
        },
        cursorBlink: true,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      fitAddon.fit()
      termRef.current = { term, fitAddon }

      // Connect WebSocket
      const wsUrl = baseUrl.replace('http', 'ws')
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'output') term.write(msg.data)
          if (msg.type === 'replay') term.write(msg.data)
          if (msg.type === 'exit') term.write('\r\n[Process exited]\r\n')
        } catch {}
      }

      ws.onclose = () => setConnected(false)

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }))
        }
      })

      // Handle resize
      const observer = new ResizeObserver(() => {
        fitAddon.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      })
      observer.observe(containerRef.current)

      return () => {
        observer.disconnect()
        term.dispose()
        ws.close()
      }
    }

    const cleanupPromise = init()

    return () => {
      cancelled = true
      cleanupPromise.then(cleanup => cleanup?.())
      wsRef.current?.close()
      termRef.current = null
    }
  }, [visible, baseUrl])

  if (!visible) return null

  return (
    // Sizing is parent-controlled. The dashboard wraps this in a right-column
    // container that may hold the PRD viewer above + the terminal below. When
    // only the terminal is open, the wrapper provides the 50%/minWidth sizing.
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0, minWidth: 0,
      width: '100%', height: '100%',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 12px', background: 'var(--surface2)',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          Terminal
        </span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--muted)',
        }} />
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{
            padding: '2px 8px', borderRadius: 3, border: '1px solid var(--border)',
            background: 'none', color: 'var(--muted)', fontFamily: 'var(--mono)',
            fontSize: 10, cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>
      <div ref={containerRef} style={{ flex: 1, background: '#0d0f14', overflow: 'hidden', padding: 4 }} />
    </div>
  )
}
