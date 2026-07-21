'use client'

import { useState } from 'react'
import { HomeContent } from '@/components/home-content'
import { DemosTab } from '@/components/demos-tab'
import { ModelTab } from '@/components/model-tab'
import { ProjectWithStatus } from '@/lib/types'

// The home / cross-project view. Project management (today's content) lives in
// the Projects tab; the Demos tab is the cross-project demo-video workshop;
// the Model tab holds the global agent defaults + the account-usage widget.
export function HomeTabs({ projects, showOnboarding }: { projects: ProjectWithStatus[]; showOnboarding?: boolean }) {
  const [tab, setTab] = useState<'projects' | 'demos' | 'model'>('projects')
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, padding: '10px 32px 0', borderBottom: '1px solid var(--border-subtle)' }}>
        {(['projects', 'demos', 'model'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 14px', border: 'none', background: 'transparent',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--text)' : 'var(--text-dim)',
              fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              textTransform: 'capitalize', marginBottom: -1,
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'projects'
        ? <HomeContent projects={projects} showOnboarding={showOnboarding} />
        : tab === 'demos'
          ? <DemosTab />
          : <ModelTab />}
    </div>
  )
}
