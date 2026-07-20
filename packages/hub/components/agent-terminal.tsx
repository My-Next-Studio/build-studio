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
        // History scrolling is tmux's (the server enables mouse mode on the
        // view session, so the wheel drives tmux copy-mode); this buffer only
        // covers pre-attach output. Hold Shift to select text locally.
        scrollback: 5000,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current)

      // Re-fit and push the new size to the server. tmux sizes the agent's
      // window to this client (window-size latest), so an over-count here
      // leaves the live pane taller than the visible container — its bottom
      // rows sit off-screen and the wheel can't reach them (xterm/tmux eat the
      // wheel for copy-mode, so the outer container never scrolls). Fitting
      // once right after open() is not enough: the JetBrains Mono webfont often
      // loads AFTER that first measure, and the taller real glyph cell shrinks
      // how many rows actually fit — but ResizeObserver only fires on container
      // SIZE changes, never on a font swap, so the stale row count is never
      // corrected. Re-fit on fonts.ready and next frame to catch both.
      const applyFit = () => {
        if (cancelled || !containerRef.current) return
        try { fitAddon.fit() } catch { return }
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      }
      applyFit()
      requestAnimationFrame(applyFit)
      // document.fonts may be absent in old runtimes; guard it.
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        document.fonts.ready.then(applyFit).catch(() => {})
      }

      const wsUrl = `${baseUrl.replace('http', 'ws')}/?agentWindow=${encodeURIComponent(agentWindow)}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('connected')
        // Fit again now that the socket is open — the earlier fits may have run
        // before the container settled, and onopen is the first moment a resize
        // can actually reach the pane.
        applyFit()
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

      const observer = new ResizeObserver(() => applyFit())
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
            : status === 'connected' ? 'live — keystrokes go to the agent · wheel scrolls history · shift+drag selects'
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
