'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProject } from '@/lib/project-context'
import { roleConfig, avatarSrc } from '@/lib/roles'

interface Agent {
  role: string
  status: string
  lastActivity?: string
}

interface Worktree {
  branch: string
  taskSummary?: string
  lastCommit?: string
}

export function AgentRoster({
  selectedAgents,
  onToggleAgent,
  onToggleAll,
}: {
  selectedAgents: Set<string>
  onToggleAgent: (role: string) => void
  onToggleAll: () => void
}) {
  const { baseUrl } = useProject()
  const [agents, setAgents] = useState<Agent[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])

  const load = useCallback(async () => {
    const [agentData, wtData] = await Promise.all([
      fetch(`${baseUrl}/api/agents`).then(r => r.json()),
      fetch(`${baseUrl}/api/worktrees`).then(r => r.json()),
    ])
    setAgents(agentData.agents || [])
    setWorktrees(wtData.worktrees || [])
  }, [baseUrl])

  useEffect(() => { load() }, [load])

  return (
    <aside style={{
      background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      width: '100%', height: '100%',
    }}>
      <div style={{
        padding: '10px 12px',
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'var(--text-dim)',
        borderBottom: '1px solid var(--border)',
      }}>
        Agents
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {agents.map(a => {
          const cfg = roleConfig(a.role)
          const isSelected = selectedAgents.has(a.role)
          const statusClass = (a.status || 'idle').toLowerCase()
          return (
            <div
              key={a.role}
              onClick={() => onToggleAgent(a.role)}
              style={{
                display: 'flex', flexDirection: 'column', gap: 5,
                padding: '10px 12px', borderRadius: 6,
                border: `1px solid ${isSelected ? 'var(--accent2)' : 'var(--border)'}`,
                background: isSelected ? 'rgba(124,111,255,0.08)' : 'var(--surface2)',
                cursor: 'pointer', marginBottom: 6,
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {avatarSrc(a.role)
                  ? <img src={avatarSrc(a.role)!} alt={a.role} style={{ width: 22, height: 22, borderRadius: 4 }} />
                  : <span style={{ fontSize: 18 }}>{cfg.avatar}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.role}
                  </div>
                  <span className={`status-pill ${statusClass}`}>{a.status || 'idle'}</span>
                </div>
                <span style={{
                  width: 15, height: 15, borderRadius: 3,
                  border: `1.5px solid ${isSelected ? 'var(--accent2)' : 'var(--muted)'}`,
                  background: isSelected ? 'var(--accent2)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, color: isSelected ? 'white' : 'transparent',
                }}>
                  ✓
                </span>
              </div>
              {a.lastActivity && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.lastActivity}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Worktrees */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px 4px' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
            Worktrees
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>{worktrees.length}</span>
        </div>
        <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto' }}>
          {worktrees.length === 0 ? (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', padding: '4px 4px 8px' }}>None active</div>
          ) : worktrees.map(wt => (
            <div key={wt.branch} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '7px 10px' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)' }}>{wt.branch}</div>
              {wt.taskSummary && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wt.taskSummary}</div>}
              {wt.lastCommit && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>↳ {wt.lastCommit}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: 8, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button
          onClick={onToggleAll}
          style={{
            width: '100%', padding: 7, background: 'none',
            border: '1px solid var(--border)', borderRadius: 4,
            color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Select all
        </button>
      </div>
    </aside>
  )
}

// Export a hook for loading agents (used by parent)
export function useAgents() {
  const { baseUrl } = useProject()
  const [agents, setAgents] = useState<Agent[]>([])

  const load = useCallback(async () => {
    const data = await fetch(`${baseUrl}/api/agents`).then(r => r.json())
    setAgents(data.agents || [])
  }, [baseUrl])

  useEffect(() => { load() }, [load])

  return { agents, reload: load }
}
