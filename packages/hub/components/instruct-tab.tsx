'use client'

import { useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { roleConfig, avatarSrc } from '@/lib/roles'

interface SentInstruction {
  timestamp: string
  roles: string[]
  instruction: string
}

export function InstructTab({ selectedAgents }: { selectedAgents: Set<string> }) {
  const api = useProjectApi()
  const [text, setText] = useState('')
  const [sent, setSent] = useState<SentInstruction[]>([])
  const [showConfirm, setShowConfirm] = useState(false)

  async function send() {
    if (!text.trim() || selectedAgents.size === 0) return
    const roles = [...selectedAgents]
    const data = await api.post('/instructions', { roles, instruction: text.trim() })
    setSent(prev => [{ timestamp: data.timestamp, roles, instruction: text.trim() }, ...prev])
    setText('')
    setShowConfirm(true)
    setTimeout(() => setShowConfirm(false), 2500)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 24px' }}>
      {/* Targets */}
      <div style={{ marginBottom: 12 }}>
        {selectedAgents.size === 0 ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
            Select agents from the roster →
          </span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[...selectedAgents].map(role => {
              const cfg = roleConfig(role)
              return (
                <span key={role} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  borderRadius: 4, padding: '3px 8px',
                  fontFamily: 'var(--mono)', fontSize: 11,
                }}>
                  {avatarSrc(role)
                    ? <img src={avatarSrc(role)!} alt={role} style={{ width: 14, height: 14, borderRadius: 2 }} />
                    : <span>{cfg.avatar}</span>}{role}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Textarea */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Enter instructions for selected agents..."
        style={{
          flex: 1, minHeight: 120, maxHeight: 300, resize: 'vertical',
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--sans)',
          fontSize: 13, padding: '12px 14px', outline: 'none',
          lineHeight: 1.6,
        }}
      />

      {/* Send */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <button
          onClick={send}
          disabled={selectedAgents.size === 0 || !text.trim()}
          style={{
            padding: '8px 20px', borderRadius: 4, border: 'none',
            background: selectedAgents.size > 0 && text.trim() ? 'var(--accent)' : 'var(--surface3)',
            color: selectedAgents.size > 0 && text.trim() ? '#0d0f14' : 'var(--muted)',
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
            cursor: selectedAgents.size > 0 && text.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Send
        </button>
        {showConfirm && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>
            ✓ Queued
          </span>
        )}
      </div>

      {/* Sent history */}
      {sent.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            Sent
          </div>
          {sent.slice(0, 5).map((e, i) => (
            <div key={i} style={{
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '8px 10px', marginBottom: 6,
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>
                {new Date(e.timestamp).toLocaleTimeString()} → {e.roles.join(', ')}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>
                {e.instruction}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
