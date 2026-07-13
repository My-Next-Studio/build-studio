'use client'

import { useState } from 'react'
import { ProjectWithStatus } from '@/lib/types'
import { useHomeStatus } from '@/lib/use-home-status'
import { ProjectCard } from './project-card'
import { NewProjectDialog } from './new-project-dialog'
import { OnboardProjectDialog } from './onboard-project-dialog'

export function HomeContent({
  projects,
  showOnboarding = false,
}: {
  projects: ProjectWithStatus[]
  showOnboarding?: boolean
}) {
  const [showNew, setShowNew] = useState(showOnboarding && projects.length === 0)
  const [showOnboard, setShowOnboard] = useState(false)
  const [showWelcome, setShowWelcome] = useState(showOnboarding && projects.length === 0)
  const liveStatuses = useHomeStatus(projects)

  return (
    <>
      <div style={{ padding: '28px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <h1 style={{
            fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14,
            letterSpacing: '0.02em', color: 'var(--text)', margin: 0,
          }}>
            Projects
          </h1>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
            background: 'var(--surface2)', padding: '2px 7px', borderRadius: 10,
          }}>
            {projects.length}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setShowOnboard(true)}
            title="Bring an existing repo under dashboard management"
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius)',
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-dim)', fontFamily: 'var(--mono)',
              fontWeight: 600, fontSize: 11, letterSpacing: '0.02em',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-dim)' }}
          >
            ↪ Onboard project
          </button>
          <button
            onClick={() => setShowNew(true)}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius)',
              background: 'var(--accent)', border: 'none',
              color: '#111114', fontFamily: 'var(--mono)',
              fontWeight: 600, fontSize: 11, letterSpacing: '0.02em',
              cursor: 'pointer', transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#d97706')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
          >
            + New Project
          </button>
        </div>

        {projects.length === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 10, padding: '80px 0',
            border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)',
          }}>
            <span style={{ fontSize: 20, color: 'var(--muted)' }}>&#9670;</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>
              No projects yet
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
              Create one or register an existing project with the CLI
            </span>
          </div>
        ) : (
          <div style={{
            display: 'grid', gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          }}>
            {projects.map(p => (
              <ProjectCard key={p.name} project={{ ...p, status: liveStatuses[p.name] ?? p.status }} />
            ))}
          </div>
        )}
      </div>

      {showNew && <NewProjectDialog onClose={() => setShowNew(false)} />}
      {showOnboard && <OnboardProjectDialog onClose={() => setShowOnboard(false)} />}

      {showWelcome && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100,
        }}>
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '36px 40px',
            maxWidth: 480,
            width: '90vw',
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16,
              color: 'var(--text)', marginBottom: 10, letterSpacing: '-0.01em',
            }}>
              Welcome to Build Studio
            </div>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
              lineHeight: 1.7, margin: '0 0 24px',
            }}>
              No projects registered yet. Create a new project to scaffold
              a workspace, or register an existing one from the command line:
            </p>
            <div style={{
              background: 'var(--surface2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius)',
              padding: '10px 14px',
              fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--text-dim)', marginBottom: 24,
              letterSpacing: '0.01em',
            }}>
              build-studio register &lt;path&gt;
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowWelcome(false)}
                style={{
                  padding: '7px 16px', borderRadius: 'var(--radius)',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--muted)', fontFamily: 'var(--mono)',
                  fontSize: 11, cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
              <button
                onClick={() => { setShowWelcome(false); setShowNew(true); }}
                style={{
                  padding: '7px 16px', borderRadius: 'var(--radius)',
                  background: 'var(--accent)', border: 'none',
                  color: '#111114', fontFamily: 'var(--mono)',
                  fontWeight: 700, fontSize: 11, cursor: 'pointer',
                }}
              >
                + Create Project
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
