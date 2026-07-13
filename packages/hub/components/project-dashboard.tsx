'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { ProjectProvider, useProject } from '@/lib/project-context'
import { useSSE } from '@/lib/use-sse'
import { useProjectApi } from '@/lib/use-project-api'
import { StatusTab } from './status-tab'
import { SpecNav } from './spec-nav'
import { SpecTab } from './spec-tab'
import { AgentsTab } from './agents-tab'
import { useAgents } from './agent-roster'
import { WorkflowView } from './workflow-view'
import { TerminalPanel } from './terminal-panel'
import { CicdTab } from './cicd-tab'
import { ServicesTab } from './services-tab'
import { PortalTab } from './portal-tab'
import { RunbooksTab } from './runbooks-tab'
import { UITestsTab } from './uitests-tab'
import { BacklogTab } from './backlog-tab'
import { PRDViewerPanel } from './prd-viewer-panel'
import { BUILTIN_FUNCTIONS, WORKFLOW_TYPE_TO_FUNCTION, resolveFunctions, type FunctionDefinition, type PortalConfig } from '@/lib/functions'

type View = 'overview' | 'workflow'
type Tab = string

interface WorkflowBrief {
  type: string
  currentStep: string | null
  waitingForInput: boolean
}

// Per-project view state persistence
const VIEW_STATE_KEY = 'build-studio:view-state'

interface PersistedViewState {
  activeFunction: string
  view: View
  tab: Tab
  activeFile: string | null
  terminalOpen: boolean
  autoAdvance: boolean
  /** IDs of backlog items expanded in the Backlog tab. Persisted so the
   * detail panels stay open across function switches (and across full hub
   * reloads). Stored as a string[] because Set isn't JSON-serializable. */
  backlogExpanded: string[]
  /** Last-used tab per function. Without this, switching from Project →
   * Development → Project resets the Project tab to its first entry (Spec).
   * Stored as a plain object so JSON serialization is trivial. */
  tabByFunction: Record<string, Tab>
}

function loadViewState(projectName: string): Partial<PersistedViewState> {
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY)
    if (!raw) return {}
    const all = JSON.parse(raw)
    return all[projectName] || {}
  } catch { return {} }
}

function saveViewState(projectName: string, state: PersistedViewState) {
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY)
    const all = raw ? JSON.parse(raw) : {}
    all[projectName] = state
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(all))
  } catch {}
}

function DashboardInner({ initialFunctionsConfig, initialPortalsConfig }: {
  initialFunctionsConfig?: Record<string, { enabled?: boolean }>
  initialPortalsConfig?: Array<{ name: string; url: string }>
}) {
  const { name: projectName } = useProject()
  const saved = useRef(loadViewState(projectName))
  const [activeFunction, setActiveFunction] = useState<string>(saved.current.activeFunction || 'project')
  const [view, setView] = useState<View>(saved.current.view || 'overview')
  const [tab, setTab] = useState<Tab>(saved.current.tab || 'spec')
  const [activeFile, setActiveFile] = useState<string | null>(saved.current.activeFile ?? null)
  const [recentFiles, setRecentFiles] = useState<Set<string>>(new Set())
  const [fileVersion, setFileVersion] = useState(0)
  const [terminalOpen, setTerminalOpen] = useState(saved.current.terminalOpen ?? false)
  const [prdViewerPath, setPrdViewerPath] = useState<string | null>(null)
  const [autoAdvance, setAutoAdvance] = useState(saved.current.autoAdvance ?? false)
  // Backlog expanded-row state lifted here so it survives function switches
  // (Project → Development → Project) and full hub reloads.
  const [backlogExpanded, setBacklogExpanded] = useState<Set<string>>(
    () => new Set(saved.current.backlogExpanded || [])
  )
  // Per-function tab memory. Restored on switchFunction so the user lands on
  // the tab they were last using for that function, not the function's first
  // tab. Initialized from saved state and seeded with the existing `tab`
  // value under the active function id for backwards-compat.
  const [tabByFunction, setTabByFunction] = useState<Record<string, Tab>>(
    () => ({
      ...(saved.current.tabByFunction || {}),
      // Seed: if there's a legacy `tab` saved but no entry under the active
      // function, put it there so we don't lose the preference on first load.
      ...(saved.current.tab && !(saved.current.tabByFunction || {})[saved.current.activeFunction || 'project']
        ? { [saved.current.activeFunction || 'project']: saved.current.tab }
        : {}),
    })
  )
  // Whether the project has been migrated to the PRD-004 backlog format.
  // Drives the "default to Backlog tab on first open" logic below.
  const [hasBacklog, setHasBacklog] = useState<boolean>(false)
  // Track whether the user has ever explicitly picked a tab on this project
  // — if not, we may auto-switch to Backlog once hasBacklog is known.
  const tabExplicit = useRef<boolean>(!!saved.current.tab)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [functions, setFunctions] = useState<FunctionDefinition[]>(() =>
    initialFunctionsConfig
      ? resolveFunctions(initialFunctionsConfig, initialPortalsConfig)
      : BUILTIN_FUNCTIONS.filter(f => f.enabledByDefault)
  )
  const [portals, setPortals] = useState<PortalConfig[]>(initialPortalsConfig || [])
  const [wfBrief, setWfBrief] = useState<WorkflowBrief | null>(null)
  const { agents, reload: reloadAgents } = useAgents()
  const api = useProjectApi()

  // Persist view state on change
  useEffect(() => {
    saveViewState(projectName, {
      activeFunction, view, tab, activeFile, terminalOpen, autoAdvance,
      backlogExpanded: [...backlogExpanded],
      tabByFunction,
    })
  }, [projectName, activeFunction, view, tab, activeFile, terminalOpen, autoAdvance, backlogExpanded, tabByFunction])

  // Fetch enabled functions + portals from project config
  useEffect(() => {
    api.get('/status').then((data: Record<string, unknown>) => {
      const p = (data.portals || []) as PortalConfig[]
      setPortals(p)
      const opsTabs = (data.operationsTabs || {}) as Record<string, boolean>
      if (data.functions) {
        setFunctions(resolveFunctions(data.functions as Record<string, { enabled?: boolean }>, p, opsTabs))
      }
      const projHasBacklog = data.hasBacklog === true
      setHasBacklog(projHasBacklog)
      // First-time landing on a migrated project: default the Project
      // function's tab to Backlog. We store this under tabByFunction.project
      // (the source of truth read by switchFunction) so it survives function
      // round-trips. Only fires when the user has no existing preference for
      // this project yet — unmigrated projects + projects with a saved tab
      // are left alone.
      if (projHasBacklog && !tabExplicit.current && !tabByFunction.project) {
        setTabByFunction(prev => ({ ...prev, project: 'backlog' }))
        if (activeFunction === 'project') setTab('backlog')
      }
    }).catch(() => {})
  }, [api, activeFunction, tabByFunction.project])

  // Poll workflow state for function notification dots
  useEffect(() => {
    async function poll() {
      try {
        const data = await api.get('/workflow')
        const wf = data.workflow
        if (wf) {
          const step = wf.steps?.[wf.currentStep]
          const agents = step?.agents || []
          const total = agents.length
          const done = agents.filter((a: { status: string }) => a.status === 'done' || a.status === 'error').length
          const allDone = total > 0 && done === total
          const isPending = step?.status === 'pending' && total === 0
          const isErrorOrBlocked = step?.status === 'error' || step?.status === 'blocked'
          setWfBrief({
            type: wf.type,
            currentStep: wf.currentStep,
            waitingForInput: (allDone || isPending || isErrorOrBlocked) && wf.currentStep !== 'completed',
          })
        } else {
          setWfBrief(null)
        }
      } catch { setWfBrief(null) }
    }
    poll()
    const interval = setInterval(poll, 6000)
    return () => clearInterval(interval)
  }, [api])

  // SSE handler for real-time updates
  const handleSSE = useCallback((event: string, data: Record<string, unknown>) => {
    if (event === 'change' || event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir') {
      const changedPath = data.path as string
      setFileVersion(v => v + 1)
      if (changedPath && (event === 'change' || event === 'add')) {
        setRecentFiles(prev => {
          const next = new Set(prev)
          next.add(changedPath)
          setTimeout(() => setRecentFiles(p => { const n = new Set(p); n.delete(changedPath); return n }), 60000)
          return next
        })
      }
    }
    if (event === 'workflow-updated') reloadAgents()
  }, [reloadAgents])

  useSSE(handleSSE)

  const currentFn = functions.find(f => f.id === activeFunction) || functions[0]
  const hasOverview = currentFn?.views.includes('overview')
  const hasWorkflow = currentFn?.views.includes('workflow')

  // Switch function handler — remembers the current tab under the OLD
  // function id, then restores the NEW function's last-used tab (or its
  // first tab if it hasn't been visited yet). Without this, the user lands
  // on the destination's first tab every return — observed pain point:
  // Project/Backlog → Development → Project landed on Spec, not Backlog.
  const switchFunction = useCallback((fnId: string) => {
    // Save the tab we're leaving so we can come back to it later.
    setTabByFunction(prev => ({ ...prev, [activeFunction]: tab }))
    setActiveFunction(fnId)
    const fn = functions.find(f => f.id === fnId)
    if (!fn) return
    if (fn.views.includes('overview')) {
      setView('overview')
      // Prefer the remembered tab when it's still valid for this function.
      const remembered = tabByFunction[fnId]
      const validRemembered = remembered && fn.tabs?.includes(remembered) ? remembered : null
      setTab(validRemembered || fn.tabs?.[0] || 'spec')
    } else {
      setView('workflow')
    }
  }, [functions, activeFunction, tab, tabByFunction])

  const allTabs: { key: Tab; label: string }[] = [
    { key: 'spec', label: 'Spec' },
    { key: 'status', label: 'Status' },
    { key: 'backlog', label: 'Backlog' },
    { key: 'agents', label: 'Agents' },
    { key: 'services', label: 'Services' },
    { key: 'cicd', label: 'CI/CD' },
    { key: 'runbooks', label: 'Runbooks' },
    { key: 'uitests', label: 'UITests' },
    ...portals.map((p, i) => ({ key: `portal-${i}`, label: p.name })),
  ]
  const tabs = allTabs.filter(t => currentFn?.tabs?.includes(t.key) ?? true)

  // Which function has a waiting workflow?
  const wfFunctionId = wfBrief ? WORKFLOW_TYPE_TO_FUNCTION[wfBrief.type] : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        padding: '0 12px', height: 34, flexShrink: 0,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--surface)',
      }}>
        {/* View toggle — only if function has both views */}
        {hasOverview && hasWorkflow && (['overview', 'workflow'] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              padding: '4px 12px', borderRadius: 'var(--radius)', border: 'none',
              background: view === v ? 'var(--surface3)' : 'transparent',
              color: view === v ? 'var(--text)' : 'var(--muted)',
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
              cursor: 'pointer', textTransform: 'lowercase',
              letterSpacing: '0.03em', transition: 'all 0.15s',
            }}
          >
            {v}
          </button>
        ))}

        {/* Separator after view toggle */}
        {hasOverview && hasWorkflow && (
          <span style={{ width: 1, height: 14, background: 'var(--border-subtle)', margin: '0 8px' }} />
        )}

        {/* Terminal toggle */}
        <button
          onClick={() => setTerminalOpen(!terminalOpen)}
          style={{
            padding: '3px 10px', borderRadius: 'var(--radius)',
            border: 'none',
            background: terminalOpen ? 'var(--surface3)' : 'transparent',
            color: terminalOpen ? 'var(--text-dim)' : 'var(--muted)',
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
            cursor: 'pointer', transition: 'all 0.15s',
          }}
        >
          &#9000; terminal
        </button>

        {/* Tabs — only in overview */}
        {view === 'overview' && hasOverview && tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '4px 12px', borderRadius: 0, border: 'none',
              borderBottom: tab === t.key ? '1.5px solid var(--accent)' : '1.5px solid transparent',
              background: 'transparent',
              color: tab === t.key ? 'var(--text)' : 'var(--muted)',
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500,
              cursor: 'pointer', marginBottom: -1,
              letterSpacing: '0.03em', transition: 'color 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}

        <span style={{ flex: 1 }} />

        {/* Function selectors */}
        {functions.map(fn => {
          const isActive = fn.id === activeFunction
          const hasNotification = wfBrief?.waitingForInput && wfFunctionId === fn.id
          return (
            <button
              key={fn.id}
              onClick={() => switchFunction(fn.id)}
              style={{
                padding: '3px 12px', borderRadius: 'var(--radius)',
                border: 'none',
                background: isActive ? 'var(--surface3)' : 'transparent',
                color: isActive ? 'var(--text)' : 'var(--muted)',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: isActive ? 600 : 500,
                cursor: isActive ? 'default' : 'pointer',
                letterSpacing: '0.03em', transition: 'all 0.15s',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            >
              {fn.label}
              {hasNotification && (
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'var(--orange)',
                  boxShadow: '0 0 6px rgba(249,115,22,0.4)',
                  animation: 'pulse-border 2s ease-in-out infinite',
                }} />
              )}
            </button>
          )
        })}
      </div>

      {/* Main content area */}
      {view === 'workflow' ? (
        <WorkflowView
          allowedTypes={currentFn?.workflowTypes}
          onSwitchFunction={switchFunction}
          autoAdvance={autoAdvance}
          onAutoAdvanceChange={setAutoAdvance}
        />
      ) : (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left: Spec nav (only on spec tab) */}
          {tab === 'spec' && (
            <div style={{ width: 240, flexShrink: 0, overflow: 'auto', borderRight: '1px solid var(--border)' }}>
              <SpecNav activeFile={activeFile} onSelectFile={setActiveFile} recentFiles={recentFiles} fileVersion={fileVersion} collapsed={collapsedFolders} onCollapsedChange={setCollapsedFolders} />
            </div>
          )}

          {/* Center: Tab content */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflow: tab.startsWith('portal-') ? 'hidden' : 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {tab === 'spec' && <SpecTab activeFile={activeFile} fileVersion={fileVersion} />}
              {tab === 'status' && <StatusTab />}
              {tab === 'backlog' && (
                <BacklogTab
                  onOpenPRD={setPrdViewerPath}
                  expanded={backlogExpanded}
                  onExpandedChange={setBacklogExpanded}
                />
              )}
              {tab === 'agents' && <AgentsTab agents={agents} />}
              {tab === 'services' && <ServicesTab />}
              {tab === 'cicd' && <CicdTab />}
              {tab === 'runbooks' && <RunbooksTab />}
              {tab === 'uitests' && <UITestsTab />}
              {tab.startsWith('portal-') && (() => {
                const idx = parseInt(tab.split('-')[1])
                const portal = portals[idx]
                return portal ? <PortalTab key={portal.url} name={portal.name} url={portal.url} /> : null
              })()}
            </div>
            {/* Right column: PRD viewer (top) + Terminal (bottom). Wrapper
                holds either or both. Each child uses flex:1 internally; with
                both open they share 50/50 vertically. */}
            {(prdViewerPath || terminalOpen) && (
              <div style={{
                display: 'flex', flexDirection: 'column',
                width: '50%', minWidth: 300, flexShrink: 0,
                borderLeft: '1px solid var(--border)',
              }}>
                {prdViewerPath && (
                  <div style={{ display: 'flex', flex: 1, minHeight: 0,
                    borderBottom: terminalOpen ? '1px solid var(--border)' : undefined,
                  }}>
                    <PRDViewerPanel path={prdViewerPath} onClose={() => setPrdViewerPath(null)} />
                  </div>
                )}
                {terminalOpen && (
                  <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                    <TerminalPanel visible={terminalOpen} onClose={() => setTerminalOpen(false)} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function ProjectDashboard({ name, port, functionsConfig, portalsConfig }: {
  name: string
  port: number
  functionsConfig?: Record<string, { enabled?: boolean }>
  portalsConfig?: Array<{ name: string; url: string }>
}) {
  return (
    <ProjectProvider name={name} port={port}>
      {/* key forces full remount when switching projects — clears all state */}
      <DashboardInner key={name} initialFunctionsConfig={functionsConfig} initialPortalsConfig={portalsConfig} />
    </ProjectProvider>
  )
}
