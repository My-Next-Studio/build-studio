'use client'

import { useEffect, useState } from 'react'
import { HomeContent } from '@/components/home-content'
import { DemosTab } from '@/components/demos-tab'
import { ModelTab } from '@/components/model-tab'
import { MonitorTab } from '@/components/monitor-tab'
import { ProjectWithStatus } from '@/lib/types'

// The home / cross-project view. Project management (today's content) lives in
// the Projects tab; the Demos tab is the cross-project demo-video workshop;
// the Model tab holds the global agent defaults + the account-usage widget;
// the Monitor tab lists cross-project alerts that need handling.

const HOME_TABS = ['projects', 'demos', 'model', 'monitor'] as const
type HomeTab = typeof HOME_TABS[number]

// Mirrors the per-project persistence in project-dashboard.tsx, which keeps a
// project's function/tab across navigation. Home had no equivalent, so every
// return to the hub dropped you back on Projects — including immediately after
// visiting Monitor, which is the tab you are most likely to want again.
const HOME_TAB_KEY = 'build-studio:home-tab'

function loadHomeTab(): HomeTab | null {
  try {
    const raw = localStorage.getItem(HOME_TAB_KEY)
    // Validate against the current tab list rather than trusting storage: a
    // value written by a newer build (or a removed tab) must not leave the hub
    // rendering nothing.
    return HOME_TABS.includes(raw as HomeTab) ? (raw as HomeTab) : null
  } catch { return null }
}

export function HomeTabs({ projects, showOnboarding }: { projects: ProjectWithStatus[]; showOnboarding?: boolean }) {
  const [tab, setTab] = useState<HomeTab>('projects')

  // Restored in an effect, not in the useState initializer: this component is
  // rendered by a server component, so the first render happens where
  // localStorage does not exist — and seeding state from it on the client only
  // would make the server and client markup disagree.
  useEffect(() => {
    const saved = loadHomeTab()
    if (saved) setTab(saved)
  }, [])

  // Onboarding is a deliberate override: a first launch arrives with
  // ?onboarding=1 and must land on Projects whatever was stored.
  useEffect(() => {
    if (showOnboarding) setTab('projects')
  }, [showOnboarding])

  const select = (t: HomeTab) => {
    setTab(t)
    try { localStorage.setItem(HOME_TAB_KEY, t) } catch { /* private mode, quota — not worth failing over */ }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 2, padding: '10px 32px 0', borderBottom: '1px solid var(--border-subtle)' }}>
        {HOME_TABS.map((t) => (
          <button
            key={t}
            onClick={() => select(t)}
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
          : tab === 'model'
            ? <ModelTab />
            : <MonitorTab />}
    </div>
  )
}
