'use client'

import { useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { roleConfig, avatarSrc } from '@/lib/roles'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface RoleData {
  role: string
  skill: string | null
  command: string | null
  commandContent: string | null
  isOverridden: boolean
  category: 'review' | 'execution' | 'standalone'
  branchPrefix: string | null
  worktree: boolean
  model: string
}

interface AgentStatus {
  role: string
  status: string
  lastActivity?: string
}

interface SkillData {
  name: string
  description: string | null
  content: string
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  review: { label: 'review', color: 'var(--accent2)' },
  execution: { label: 'execution', color: 'var(--green)' },
  standalone: { label: 'standalone', color: 'var(--muted)' },
}

export function AgentsTab({ agents }: { agents: AgentStatus[] }) {
  const api = useProjectApi()
  const [roles, setRoles] = useState<RoleData[]>([])
  const [expandedRole, setExpandedRole] = useState<string | null>(null)
  const [projectSkills, setProjectSkills] = useState<SkillData[]>([])
  const [globalSkills, setGlobalSkills] = useState<SkillData[]>([])
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)

  useEffect(() => {
    api.get('/roles').then((data: { roles?: RoleData[] }) => {
      if (data.roles) setRoles(data.roles)
    }).catch(() => {})
    api.get('/skills').then((data: { project?: SkillData[]; global?: SkillData[] }) => {
      if (data.project) setProjectSkills(data.project)
      if (data.global) setGlobalSkills(data.global)
    }).catch(() => {})
  }, [api])

  // Merge runtime agent status with role config
  const agentMap = new Map(agents.map(a => [a.role, a]))

  // Group by category
  const grouped: Record<string, RoleData[]> = { execution: [], review: [], standalone: [] }
  for (const r of roles) {
    (grouped[r.category] || grouped.standalone).push(r)
  }

  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {(['execution', 'review', 'standalone'] as const).map(cat => {
        const items = grouped[cat]
        if (!items || items.length === 0) return null
        return (
          <div key={cat}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.1em',
              color: 'var(--text-dim)', marginBottom: 10,
            }}>
              {cat} roles
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(30%, 280px), 1fr))', gap: 8 }}>
              {items.map(role => (
                <AgentCard
                  key={`${role.role}:${role.skill}`}
                  role={role}
                  agent={agentMap.get(role.role)}
                  expanded={expandedRole === `${role.role}:${role.skill}`}
                  onToggle={() => setExpandedRole(expandedRole === `${role.role}:${role.skill}` ? null : `${role.role}:${role.skill}`)}
                />
              ))}
            </div>
          </div>
        )
      })}

      {roles.length === 0 && (
        <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>Loading...</div>
      )}

      {/* Divider + Skills */}
      {(projectSkills.length > 0 || globalSkills.length > 0) && (
        <>
          <div style={{
            borderTop: '1px solid var(--border)',
            marginTop: 4,
            paddingTop: 20,
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700,
              color: 'var(--text)', marginBottom: 16,
            }}>
              Skills
            </div>
          </div>
          {projectSkills.length > 0 && (
            <SkillsSection
              title="Project Skills"
              subtitle=".claude/skills"
              skills={projectSkills}
              expandedSkill={expandedSkill}
              onToggle={name => setExpandedSkill(expandedSkill === name ? null : name)}
            />
          )}
          {globalSkills.length > 0 && (
            <SkillsSection
              title="Global Skills"
              subtitle="~/.claude/skills"
              skills={globalSkills}
              expandedSkill={expandedSkill}
              onToggle={name => setExpandedSkill(expandedSkill === `g:${name}` ? null : `g:${name}`)}
              keyPrefix="g:"
            />
          )}
        </>
      )}
    </div>
  )
}

function AgentCard({ role, agent, expanded, onToggle }: {
  role: RoleData
  agent?: AgentStatus
  expanded: boolean
  onToggle: () => void
}) {
  const cfg = roleConfig(role.role)
  const cat = CATEGORY_LABELS[role.category] || CATEGORY_LABELS.standalone
  const statusText = agent?.status || 'idle'
  const statusClass = statusText.toLowerCase()

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* Main card */}
      <div
        onClick={role.commandContent ? onToggle : undefined}
        style={{
          padding: '12px 16px',
          cursor: role.commandContent ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        {/* Avatar */}
        {avatarSrc(role.role, 88)
          ? <img src={avatarSrc(role.role, 88)!} alt={role.role} style={{ width: 88, height: 88, flexShrink: 0, borderRadius: 8 }} />
          : <span style={{ fontSize: 22, lineHeight: '28px', flexShrink: 0 }}>{cfg.avatar}</span>}

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Row 1: Name + badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
              {role.role}
            </span>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              color: cat.color, opacity: 0.8,
            }}>
              {cat.label}
            </span>
            <span className={`status-pill ${statusClass}`}>{statusText}</span>
          </div>

          {/* Row 2: Metadata */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
            <span>model: <span style={{ color: 'var(--text-dim)' }}>{role.model}</span></span>
            {role.branchPrefix && <span>branch: <span style={{ color: 'var(--text-dim)' }}>{role.branchPrefix}/*</span></span>}
            {role.worktree && <span style={{ color: 'var(--accent2)' }}>worktree</span>}
          </div>

          {/* Row 3: Last activity */}
          {agent?.lastActivity && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
              {agent.lastActivity}
            </div>
          )}
        </div>

        {/* Right side: command info + expand indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {role.command && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
              padding: '2px 6px', borderRadius: 4,
              background: role.isOverridden ? 'rgba(96,165,250,0.1)' : 'var(--surface2)',
              color: role.isOverridden ? 'var(--accent)' : 'var(--muted)',
              border: `1px solid ${role.isOverridden ? 'rgba(96,165,250,0.2)' : 'var(--border)'}`,
            }}>
              {role.isOverridden ? 'custom' : 'default'}
            </span>
          )}
          {role.commandContent && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
              transition: 'transform 0.15s',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            }}>
              ▸
            </span>
          )}
        </div>
      </div>

      {/* Expanded: command definition */}
      {expanded && role.commandContent && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '12px 16px',
          background: 'var(--bg)',
          maxHeight: 400,
          overflow: 'auto',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Command Definition
            </span>
            {role.command && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
                .claude/commands/{role.command}
              </span>
            )}
          </div>
          <div className="md-rendered" style={{ fontSize: 12 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{role.commandContent}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

function SkillsSection({ title, subtitle, skills, expandedSkill, onToggle, keyPrefix = '' }: {
  title: string
  subtitle: string
  skills: SkillData[]
  expandedSkill: string | null
  onToggle: (name: string) => void
  keyPrefix?: string
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.1em',
          color: 'var(--text-dim)',
        }}>
          {title}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
          {subtitle}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(30%, 280px), 1fr))', gap: 8 }}>
        {skills.map(skill => (
          <SkillCard
            key={`${keyPrefix}${skill.name}`}
            skill={skill}
            expanded={expandedSkill === `${keyPrefix}${skill.name}`}
            onToggle={() => onToggle(skill.name)}
          />
        ))}
      </div>
    </div>
  )
}

function SkillCard({ skill, expanded, onToggle }: {
  skill: SkillData
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      <div
        onClick={onToggle}
        style={{
          padding: '10px 16px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 14, flexShrink: 0, opacity: 0.6 }}>⚡</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            {skill.name}
          </div>
          {skill.description && (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
              marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {skill.description}
            </div>
          )}
        </div>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
          flexShrink: 0,
        }}>
          ▸
        </span>
      </div>

      {expanded && skill.content && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '12px 16px',
          background: 'var(--bg)',
          maxHeight: 500,
          overflow: 'auto',
        }}>
          <div className="md-rendered" style={{ fontSize: 12 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
