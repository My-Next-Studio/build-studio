'use client'

import { useEffect, useRef, useState } from 'react'
import { useProject } from '@/lib/project-context'

/**
 * Live bidirectional terminal attached to one workflow agent's tmux window.
 *
 * Connects the shared pty WebSocket with ?agentWindow=<name>; the server
 * resolves the tmux target from workflow state and attaches through a
 * grouped view session, so typing here reaches the agent — enough to answer
 * interactive prompts (MCP trust, menu choices) or nudge a stuck session
 * without leaving the hub.
 */
export function AgentTerminal({ agentWindow }: { agentWindow: string }) {
  const { baseUrl } = useProject()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    let cancelled = false

    async function init() {
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

      const wsUrl = `${baseUrl.replace('http', 'ws')}/?agentWindow=${encodeURIComponent(agentWindow)}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('connected')
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'output' || msg.type === 'replay') term.write(msg.data)
          if (msg.type === 'error') setErrorMsg(msg.data)
          if (msg.type === 'exit') setStatus('closed')
        } catch {}
      }

      ws.onclose = () => setStatus('closed')

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }))
        }
      })

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
    }
  }, [agentWindow, baseUrl])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
        fontFamily: 'var(--mono)', fontSize: 10,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: status === 'connected' ? 'var(--green)' : status === 'connecting' ? 'var(--orange)' : 'var(--muted)',
        }} />
        <span style={{ color: 'var(--muted)' }}>
          {errorMsg ? errorMsg
            : status === 'connected' ? 'live — keystrokes go to the agent'
            : status === 'connecting' ? 'attaching…'
            : 'disconnected'}
        </span>
      </div>
      <div
        ref={containerRef}
        style={{
          flex: 1, minHeight: 0, overflow: 'hidden',
          background: '#0d0f14', border: '1px solid var(--border)',
          borderRadius: 6, padding: 6,
        }}
      />
    </div>
  )
}
