'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useProjectApi } from '@/lib/use-project-api'
import { useProject } from '@/lib/project-context'
import { roleConfig, avatarSrc } from '@/lib/roles'
import { CommitRibbon } from './commit-ribbon'
import { PathologyPanel, type PathologySignals } from './pathology-panel'
import { FindingsChecklist, type Finding } from './findings-checklist'

interface WorkflowAgent {
  role: string
  status: string
  feedback?: string
  error?: string
  logError?: string
  window?: string
  taskIndex?: number
  model?: string
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreate: number; cacheRead: number; costUSD: number }
}

interface WorkflowStep {
  status: string
  error?: string
  /** Stashed by server-side auto-advance when a gate repeatedly rejects this step
   *  (e.g. qa_tests with no committed tests) — surfaced so a stall is never silent. */
  autoAdvanceError?: string
  agents: WorkflowAgent[]
  mergeResults?: { branch: string; status: string; error?: string }[]
  completedTasks?: { id?: number; name: string; status: string }[]
  currentTask?: { id?: number; name: string; description: string; roles: string[] }
}

interface TaskPlan {
  tasks: { id: number; name: string; description: string; roles: string[]; dependencies: number[]; acs_covered: string[]; estimated_size: string }[]
}

interface TaskState {
  status: 'pending' | 'running' | 'done' | 'error'
  startedAt: string | null
  completedAt: string | null
  tokenUsage: { inputTokens: number; outputTokens: number; costUSD: number; cacheRead: number; cacheCreate: number } | null
  agentSummary: string | null
  agents: (WorkflowAgent & { taskIndex?: number })[]
}

interface TaskExecution {
  currentTaskIndex: number
  taskStates: Record<string, TaskState>
}

interface OverseerIntervention {
  at: string
  symptom: string
  action: string
  result: string
}

interface OverseerState {
  status: 'watching' | 'acting' | 'escalating' | 'idle'
  activity: string
  interventions: OverseerIntervention[]
  pendingEscalation: {
    symptom: string
    description: string
    askedAt: string
    /** Optional UI action key. Currently used: 'nudge-agent'. */
    action?: string
    /** Window name (tmux) the action targets — set when action='nudge-agent'. */
    actionTarget?: string
  } | null
}

interface Workflow {
  id: string
  type: 'review' | 'execution' | 'kickoff' | 'onboarding'
  input: string
  currentStep: string
  round: number
  reviewMode?: string
  reviewBranch?: string
  branch?: string
  defaultBranch?: string
  developerCli?: 'claude' | 'codex'
  reviewerCli?: 'claude' | 'codex'
  autoAdvance?: boolean
  autoAdvanceStrict?: boolean
  steps: Record<string, WorkflowStep>
  taskPlan?: TaskPlan
  taskExecution?: TaskExecution
  fixPlan?: TaskPlan
  fixTaskIndex?: number
  fixSource?: string
  overseer?: OverseerState
}

const WF_STEPS: Record<string, { key: string; name: string; loopHint?: string }[]> = {
  review: [
    { key: 'pm_draft', name: 'PM Draft' },
    { key: 'reviewing', name: 'Review' },
    { key: 'pm_fix', name: 'PM Fix', loopHint: '↑ loops back to Review' },
    { key: 'companion_specs', name: 'Companion Specs' },
  ],
  execution: [
    { key: 'qa_tests', name: 'QA Tests' },
    { key: 'planning', name: 'Task Planning' },
    { key: 'task_execution', name: 'Task Execution' },
    { key: 'merge_for_review', name: 'Merge for Review' },
    { key: 'code_review', name: 'Code Review' },
    { key: 'coverage_matrix', name: 'Coverage Matrix' },
    { key: 'qa_validation', name: 'QA Validation' },
    { key: 'ac_verification', name: 'AC Verification' },
    { key: 'device_testing', name: 'Device Testing' },
    { key: 'security_audit', name: 'Security Audit' },
    { key: 'final_review', name: 'Final Review' },
    { key: 'demo_review', name: 'Demo Review' },
    { key: 'merge_to_main', name: 'Merge to Main' },
    { key: 'capture_learnings', name: 'Capture Learnings' },
  ],
  kickoff: [
    { key: 'ceo_synthesis', name: 'CEO Synthesis' },
    { key: 'pm_scoping', name: 'PM Scoping' },
    { key: 'owner_consultations', name: 'Owner Consultations' },
    { key: 'team_review', name: 'Team Review' },
    { key: 'pm_revision', name: 'PM Revision' },
    { key: 'companion_specs', name: 'Companion Specs' },
    { key: 'devops_init', name: 'DevOps Init' },
  ],
  // PRD-001 v1: onboarding workflow for existing projects.
  onboarding: [
    { key: 'discovery',          name: 'Discovery' },
    { key: 'ceo_synthesis',      name: 'CEO Synthesis (backfill)' },
    { key: 'architect_backfill', name: 'Architect Backfill' },
    { key: 'pm_synthesis',       name: 'PM Synthesis' },
    { key: 'devops_detect',      name: 'DevOps Detect' },
    { key: 'team_review',        name: 'Team Review' },
    { key: 'pm_revision',        name: 'PM Revision' },
    { key: 'owner_signoff',      name: 'Owner Sign-off' },
  ],
}

const AUTO_ADVANCE_MAX_ROUNDS = 3

interface WorkflowViewProps {
  allowedTypes?: string[]
  onSwitchFunction?: (fnId: string) => void
  autoAdvance?: boolean
  onAutoAdvanceChange?: (value: boolean) => void
}

const WORKFLOW_TYPE_TO_FUNCTION: Record<string, string> = {
  kickoff: 'project',
  onboarding: 'project',
  review: 'development',
  execution: 'development',
}

export function WorkflowView({ allowedTypes, onSwitchFunction, autoAdvance: autoAdvanceProp, onAutoAdvanceChange }: WorkflowViewProps = {}) {
  const api = useProjectApi()
  const [wf, setWf] = useState<Workflow | null>(null)
  const [pathologySignals, setPathologySignals] = useState<PathologySignals | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [findingOverrides, setFindingOverrides] = useState<Record<string, Finding['status']>>({})
  const [projectWorkflowSteps, setProjectWorkflowSteps] = useState<Record<string, string[]> | null>(null)
  const types = allowedTypes || ['review', 'execution', 'kickoff']
  const [wfType, setWfType] = useState<string>(types[0])
  const [input, setInput] = useState('')
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const [logText, setLogText] = useState<string>('')
  const [viewingLog, setViewingLog] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [autoAdvanceLocal, setAutoAdvanceLocal] = useState(autoAdvanceProp ?? false)
  const autoAdvance = autoAdvanceProp ?? autoAdvanceLocal
  // Strict auto-advance (review workflows): ANY finding — medium/low included —
  // sends the round back to PM instead of approving, until clean or the round cap.
  const [autoAdvanceStrict, setAutoAdvanceStrictLocal] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('workflow.autoAdvanceStrict') === '1'
  })
  const setAutoAdvanceStrict = useCallback((v: boolean) => {
    setAutoAdvanceStrictLocal(v)
    if (typeof window !== 'undefined') window.localStorage.setItem('workflow.autoAdvanceStrict', v ? '1' : '0')
    // Sync to server so the background auto-advance tick honors it too
    api.post('/workflow/auto-advance', { strict: v }).catch(() => {})
  }, [api])
  const setAutoAdvance = useCallback((v: boolean) => {
    setAutoAdvanceLocal(v)
    onAutoAdvanceChange?.(v)
    // Sync to server so auto-advance works even when project is in background
    api.post('/workflow/auto-advance', { enabled: v, strict: autoAdvanceStrict }).catch(() => {})
  }, [onAutoAdvanceChange, api, autoAdvanceStrict])
  const [autoAdvanceRound, setAutoAdvanceRound] = useState(0)
  const [maxReviewRounds, setMaxReviewRounds] = useState(4)
  const [advanceError, setAdvanceError] = useState<string | null>(null)
  const [advancing, setAdvancing] = useState<string | null>(null)
  const autoAdvancingRef = useRef(false)
  // Tracks the workflow id we've already pushed the auto-advance preference to,
  // so the self-heal below posts at most once per run.
  const autoAdvanceSyncRef = useRef<string | null>(null)
  const [tokenStats, setTokenStats] = useState<{ projectTokens: number; projectCostUSD: number; prds: { prdId: string; tokens: number; costUSD: number }[] } | null>(null)
  const [developerCli, setDeveloperCli] = useState<'claude' | 'codex'>(() => {
    if (typeof window === 'undefined') return 'claude'
    const stored = window.localStorage.getItem('workflow.developerCli')
    return stored === 'codex' ? 'codex' : 'claude'
  })
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('workflow.developerCli', developerCli)
    }
  }, [developerCli])
  // Reviewer CLI tri-state: 'auto' = opposite of developerCli, otherwise explicit override.
  const [reviewerCliMode, setReviewerCliMode] = useState<'auto' | 'claude' | 'codex'>(() => {
    // Default to Claude (no flip). Cross-model review (`auto` = opposite of developer,
    // or explicit `codex`) is opt-in, and only takes effect in execution runs server-side.
    if (typeof window === 'undefined') return 'claude'
    const stored = window.localStorage.getItem('workflow.reviewerCli')
    return stored === 'claude' || stored === 'codex' || stored === 'auto' ? stored : 'claude'
  })
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('workflow.reviewerCli', reviewerCliMode)
    }
  }, [reviewerCliMode])
  const effectiveReviewerCli: 'claude' | 'codex' =
    reviewerCliMode === 'auto'
      ? (developerCli === 'claude' ? 'codex' : 'claude')
      : reviewerCliMode

  const load = useCallback(async () => {
    const data = await api.get('/workflow')
    setWf(data.workflow || null)
    setPathologySignals(data.pathologySignals || null)
    setFindings(Array.isArray(data.findings) ? data.findings : [])
    // projectWorkflowSteps is the resolved per-project workflow step list
    // (after preset + overrides). Used below to filter the timeline so that
    // e.g. static-site projects don't show device_testing.
    if (data.projectWorkflowSteps) setProjectWorkflowSteps(data.projectWorkflowSteps)
    if (data.workflow) {
      setWfType(data.workflow.type)
      setInput(data.workflow.input)
      // Sync auto-advance state from server
      if (data.workflow.autoAdvance !== undefined) {
        setAutoAdvanceLocal(data.workflow.autoAdvance)
        onAutoAdvanceChange?.(data.workflow.autoAdvance)
      }
      if (data.workflow.autoAdvanceStrict !== undefined) {
        setAutoAdvanceStrictLocal(!!data.workflow.autoAdvanceStrict)
      }
    }
    if (typeof data.maxReviewRounds === 'number') setMaxReviewRounds(data.maxReviewRounds)
  }, [api, onAutoAdvanceChange])

  const loadTokenStats = useCallback(async () => {
    try {
      const data = await api.get('/workflow/token-stats')
      setTokenStats(data)
    } catch (_) {}
  }, [api])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadTokenStats() }, [loadTokenStats])

  // Poll workflow state every 4s so agent cards update automatically
  useEffect(() => {
    const interval = setInterval(load, 4000)
    return () => clearInterval(interval)
  }, [load])

  // Refresh token stats every 30s (no need for fast polling)
  useEffect(() => {
    const interval = setInterval(loadTokenStats, 30000)
    return () => clearInterval(interval)
  }, [loadTokenStats])

  // Auto-advance logic — runs on each workflow state update
  useEffect(() => {
    if (!autoAdvance || !wf || wf.currentStep === 'completed' || autoAdvancingRef.current) return

    // Self-heal the server-side flag. The auto-advance checkbox persists
    // client-side across runs, but a freshly-started workflow defaults to no
    // server flag — and if the box was already checked when the run began (no
    // toggle event fired), nothing ever POSTed it down. Without wf.autoAdvance
    // the server-side tick never runs, so round-1 review steps (code_review,
    // qa_validation) stall — the client-side tick intentionally leaves those
    // manual on round 1, and while the project is backgrounded there's nothing
    // else to advance them. Push the preference down once per run.
    if (!wf.autoAdvance && autoAdvanceSyncRef.current !== wf.id) {
      autoAdvanceSyncRef.current = wf.id
      api.post('/workflow/auto-advance', { enabled: true, strict: autoAdvanceStrict }).catch(() => {})
    }

    if (autoAdvanceRound >= AUTO_ADVANCE_MAX_ROUNDS) {
      setAutoAdvance(false)
      return
    }

    const step = wf.steps[wf.currentStep]
    if (!step) return

    const agents = step.agents || []
    const allDone = agents.length > 0 && agents.every(a => a.status === 'done' || a.status === 'error')
    const isPending = step.status === 'pending' && agents.length === 0

    // Review steps: manual on round 1, auto-launch + auto-advance on round 2+
    // Round 2+ = fix loop iteration — reviews auto-launch and auto-advance if no blocking issues
    // (if blocking issues are found, the verdict logic below sends to fix, which is correct)
    const round = wf.round || 1
    const reviewSteps = ['code_review', 'qa_validation', 'ac_verification', 'security_audit']
    // owner_signoff fires the single onboarding commit; team_review for onboarding
    // also requires owner judgment (artifacts are backfills, not fresh decisions).
    // owner_consultations: kickoff manual gate between pm_scoping and team_review.
    const alwaysManual = ['demo_review', 'device_testing', 'owner_signoff', 'owner_consultations']
    if (alwaysManual.includes(wf.currentStep)) return
    if (wf.type === 'onboarding' && wf.currentStep === 'team_review') return
    if (round <= 1 && reviewSteps.includes(wf.currentStep)) return

    // Don't auto-advance blocked steps (e.g. validation failure in planning)
    if (step.status === 'blocked') return

    let action: string | null = null

    if (isPending) {
      // Auto-launch pending steps (including merge steps).
      // owner_signoff is a manual gate — never auto-approve (it fires a git commit).
      // owner_consultations is a manual gate — owner must explicitly approve.
      const manualSteps = ['merge_to_main', 'capture_learnings', 'owner_signoff', 'owner_consultations']
      action = manualSteps.includes(wf.currentStep) ? 'approve' : 'launch'
    } else if (allDone) {
      // Determine action based on agent feedback — reuse detectVerdict for consistency
      // qa_tests is TDD — failing tests are expected, never treat as blocking
      const hasBlocking = wf.currentStep === 'qa_tests' ? false : agents.some(a => {
        const v = detectVerdict(a)
        return v === 'blocking' || v === 'changes'
      })

      const isReviewStep = ['code_review', 'qa_validation', 'ac_verification', 'security_audit'].includes(wf.currentStep)
      const isReviewFlowStep = ['reviewing', 'team_review'].includes(wf.currentStep)

      // Strict auto-advance: ANY finding (medium/low included, or a non-approval)
      // bounces the review round back to PM — until clean or the round cap, so
      // low-severity nitpicks can't loop forever. Mirrors the server-side tick.
      const strictHasFindings = autoAdvanceStrict && wf.type === 'review'
        && wf.currentStep === 'reviewing' && !hasBlocking
        && agents.some(a => {
          const fb = (a as { feedback?: string }).feedback
          if (!fb) return false
          if (/\*\*Approved:\*\*\s*no\b/i.test(fb)) return true
          return [/\*\*Blocking:\*\*\s*(\d+)/i, /\*\*Medium:\*\*\s*(\d+)/i, /\*\*Low:\*\*\s*(\d+)/i]
            .some(re => { const m = fb.match(re); return m ? parseInt(m[1]) > 0 : false })
        })

      if (hasBlocking && isReviewStep) {
        action = 'send_to_devs'
        setAutoAdvanceRound(r => r + 1)
      } else if (hasBlocking && isReviewFlowStep) {
        // team_review (kickoff/onboarding) accepts `approve` to advance to
        // pm_revision; reviewing (review workflow) accepts `send_to_pm`.
        action = wf.currentStep === 'team_review' ? 'approve' : 'send_to_pm'
        setAutoAdvanceRound(r => r + 1)
      } else if (strictHasFindings && round < maxReviewRounds) {
        // Strict re-review bounce. Do NOT count this toward AUTO_ADVANCE_MAX_ROUNDS:
        // a strict loop is meant to iterate until reviews are clean, and it is
        // already bounded server-side by max_review_rounds (the `round <`
        // condition here). Counting it would trip the client safety cap and
        // silently disable auto-advance mid-loop (leaving pm_fix stranded).
        action = 'send_to_pm'
      } else {
        action = 'approve'
      }
    }

    if (action) {
      autoAdvancingRef.current = true
      console.log(`[auto-advance] step=${wf.currentStep} status=${step.status} agents=${agents.length} allDone=${allDone} isPending=${isPending} action=${action}`)
      api.post('/workflow/advance', { action }).then((result: any) => {
        console.log(`[auto-advance] result: needsAdvance=${result?.needsAdvance} error=${result?.error}`)
        autoAdvancingRef.current = false
        if (result?.error) {
          // Gate rejected the action (e.g. qa_tests with no committed tests, or a
          // qa_validation.strict failure) — surface it and stop looping instead of
          // retrying silently. Re-enable Auto-advance to try again after fixing the cause.
          setAdvanceError(result.error)
          setAutoAdvance(false)
          return
        }
        if (result?.needsAdvance) {
          // Fix execution: approve returns needsAdvance — immediately launch next task
          setTimeout(() => {
            console.log(`[auto-advance] chaining launch after needsAdvance`)
            autoAdvancingRef.current = true
            api.post('/workflow/advance', { action: 'launch' }).then(() => {
              autoAdvancingRef.current = false
              load()
            }).catch(() => {
              autoAdvancingRef.current = false
            })
          }, 1500)
        } else {
          load()
        }
      }).catch((e: any) => {
        console.error(`[auto-advance] error:`, e)
        autoAdvancingRef.current = false
      })
    }
  }, [wf, autoAdvance, autoAdvanceStrict, maxReviewRounds, autoAdvanceRound, api, load])

  // Poll workflow log if viewing one
  useEffect(() => {
    if (!viewingLog) return
    const poll = async () => {
      const data = await api.get(`/terminal/workflow/${encodeURIComponent(viewingLog)}?lines=80`)
      if (data.log) setLogText(data.log)
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [viewingLog, api])

  const [startError, setStartError] = useState<string | null>(null)
  async function startWorkflow() {
    // Onboarding doesn't take a PRD input — the project itself is the input.
    if (wfType !== 'onboarding' && !input.trim()) return
    setStartError(null)
    const body: Record<string, string> = { type: wfType }
    if (wfType !== 'onboarding') body.input = input.trim()
    if (wfType === 'execution') {
      body.developerCli = developerCli
      body.reviewerCli = effectiveReviewerCli
    }
    // api.post returns the parsed body (incl. {error}) and does NOT throw on non-2xx,
    // so a guardrail 409 must be surfaced explicitly — otherwise Start looks like a no-op.
    const res = await api.post('/workflow/start', body)
    if (res && res.error) { setStartError(res.error); return }
    // Carry the persisted auto-advance preference into the fresh workflow now —
    // the server flag defaults off, and without it the server-side tick won't
    // advance round-1 review steps. The effect self-heals too; this closes the
    // gap before its first render.
    if (autoAdvance) {
      if (res?.workflow?.id) autoAdvanceSyncRef.current = res.workflow.id
      api.post('/workflow/auto-advance', { enabled: true, strict: autoAdvanceStrict }).catch(() => {})
    }
    load()
  }

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [cancelDeleteWorktrees, setCancelDeleteWorktrees] = useState(false)

  async function confirmCancel() {
    await api.post('/workflow/cancel', { deleteWorktrees: cancelDeleteWorktrees })
    setCancelDialogOpen(false)
    setCancelDeleteWorktrees(false)
    load()
  }

  function cancelWorkflow() {
    setCancelDialogOpen(true)
  }

  async function advanceWorkflow(action?: string, extra?: Record<string, unknown>) {
    setAdvanceError(null)
    setAdvancing(action ?? 'advance')
    const res = await api.post('/workflow/advance', { action, notes: notes.trim() || undefined, ...extra })
    setAdvancing(null)
    if (res?.error) {
      setAdvanceError(res.error)
      return
    }
    setNotes('')
    load()
  }

  async function finishWorkflow() {
    await api.post('/workflow/finish')
    load()
  }

  async function dismissOverseerEscalation() {
    await api.post('/overseer/dismiss')
    load()
  }

  async function nudgeAgent(windowName: string) {
    await api.post('/overseer/nudge-agent', { window: windowName })
    load()
  }

  async function markAgentDone(role: string) {
    await api.post('/workflow/feedback', { role, feedback: 'Manually marked as done.' })
    load()
  }

  // Build the timeline from the project's resolved preset order. WF_STEPS is
  // used ONLY as a display-name dictionary; the canonical ORDER comes from
  // the preset (read from the workflow API). Earlier this used WF_STEPS for
  // order too, which caused two visible bugs:
  //   - merge_for_review was silently dropped (not in WF_STEPS)
  //   - security_audit appeared before device_testing on example-ios (mobile-app
  //     preset has the opposite order; WF_STEPS' order leaked through)
  // code_review is special — it always runs in execution workflows but isn't
  // listed in any preset's execution array (it's injected by the runner
  // post-merge_for_review). We inject it dynamically below when wf.steps
  // contains it, same pattern as fix_plan/fix_execution.
  const projectStepKeys = projectWorkflowSteps?.[wfType]
  const stepMeta: Record<string, { name: string; loopHint?: string }> = Object.fromEntries(
    (WF_STEPS[wfType] || []).map(s => [s.key, { name: s.name, loopHint: s.loopHint }])
  )
  const humanize = (key: string) =>
    key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const baseSteps =
    projectStepKeys && projectStepKeys.length > 0
      ? projectStepKeys.map(key => {
          const meta = stepMeta[key]
          return { key, name: meta?.name || humanize(key), loopHint: meta?.loopHint }
        })
      : (WF_STEPS[wfType] || [])  // fallback: no preset data yet, use catalog
  const steps = (() => {
    const s = [...baseSteps]
    if (wfType === 'execution' && wf) {
      // code_review is post-merge_for_review and not in any preset's array.
      // Inject it just before qa_validation if it exists in wf.steps.
      if (wf.steps?.code_review && !s.find(x => x.key === 'code_review')) {
        const qaIdx = s.findIndex(x => x.key === 'qa_validation')
        const mfrIdx = s.findIndex(x => x.key === 'merge_for_review')
        const at = qaIdx >= 0 ? qaIdx : mfrIdx >= 0 ? mfrIdx + 1 : s.length
        s.splice(at, 0, { key: 'code_review', name: 'Code Review' })
      }
      if (wf.steps?.fix_plan) {
        const srcIdx = s.findIndex(x => x.key === (wf.fixSource || 'code_review'))
        const at = srcIdx >= 0 ? srcIdx + 1 : s.length
        if (!s.find(x => x.key === 'fix_plan')) s.splice(at, 0, { key: 'fix_plan', name: 'Fix Plan' })
      }
      if (wf.steps?.fix_execution) {
        const planIdx = s.findIndex(x => x.key === 'fix_plan')
        const at = planIdx >= 0 ? planIdx + 1 : s.length
        if (!s.find(x => x.key === 'fix_execution')) s.splice(at, 0, { key: 'fix_execution', name: 'Fix Execution' })
      }
      if (wf.steps?.review_cap_reached) {
        const execIdx = s.findIndex(x => x.key === 'fix_execution')
        const at = execIdx >= 0 ? execIdx + 1 : s.length
        if (!s.find(x => x.key === 'review_cap_reached')) s.splice(at, 0, { key: 'review_cap_reached', name: 'Review Cap' })
      }
    }
    return s
  })()
  const activeKey = selectedStep || wf?.currentStep || ''

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: '100%', overflow: 'hidden' }}>
      {/* Left: Sidebar */}
      <div style={{ borderRight: '1px solid var(--border)', padding: 16, overflow: 'auto', background: 'var(--surface)' }}>
        {/* Type toggle */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 8 }}>
            Workflow
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {types.map(t => (
              <button
                key={t}
                onClick={() => !wf && setWfType(t)}
                disabled={!!wf}
                style={{
                  padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
                  background: wfType === t ? 'var(--accent)' : 'transparent',
                  color: wfType === t ? '#0d0f14' : 'var(--text-dim)',
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  cursor: wf ? 'default' : 'pointer', opacity: wf ? 0.5 : 1,
                  textTransform: 'capitalize',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Cross-function banner — workflow running in a different function */}
        {wf && !types.includes(wf.type) && (
          <div style={{
            padding: '8px 10px', marginBottom: 16, borderRadius: 6,
            background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
          }}>
            Active <span style={{ color: 'var(--orange)', fontWeight: 600 }}>{wf.type}</span> workflow is in{' '}
            <button
              onClick={() => onSwitchFunction?.(WORKFLOW_TYPE_TO_FUNCTION[wf.type] || 'development')}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                textDecoration: 'underline',
              }}
            >
              {WORKFLOW_TYPE_TO_FUNCTION[wf.type] === 'project' ? 'Project' : 'Development'}
            </button>
          </div>
        )}

        {/* Input — onboarding has no PRD/input concept (the project itself IS the input). */}
        {wfType !== 'onboarding' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 6 }}>
              Input
            </div>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              disabled={!!wf}
              placeholder="PRD name, or user story / task ID (e.g. EX-001)..."
              style={{
                width: '100%', padding: '6px 10px', borderRadius: 4,
                background: 'var(--surface2)', border: '1px solid var(--border)',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
                outline: 'none', opacity: wf ? 0.5 : 1,
              }}
            />
            {(wfType === 'review' || wfType === 'execution') && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                Enter a story / task ID to run its PRD — it must reference a PRD
                and be{' '}
                <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
                  {wfType === 'review' ? 'Drafted' : 'Reviewed'}
                </span>.
              </div>
            )}
          </div>
        )}
        {wfType === 'onboarding' && (
          <div style={{ marginBottom: 16, padding: '8px 10px', background: 'var(--surface2)', border: '1px dashed var(--border)', borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
            Synthesizes vision, ADR-001, project-state, and a baseline PRD from existing files. No input needed — owner sign-off gates the first commit.
          </div>
        )}

        {/* Active workflow's CLI assignment — readonly indicator */}
        {wf && wf.type === 'execution' && wf.developerCli && (
          <div style={{
            marginBottom: 16, padding: '6px 10px', borderRadius: 4,
            background: 'var(--surface2)', border: '1px solid var(--border)',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <div>
              Developer CLI:{' '}
              <span style={{ color: 'var(--text)', fontWeight: 600, textTransform: 'capitalize' }}>
                {wf.developerCli}
              </span>
            </div>
            {wf.reviewerCli && (
              <div>
                Reviewer CLI:{' '}
                <span style={{ color: 'var(--text)', fontWeight: 600, textTransform: 'capitalize' }}>
                  {wf.reviewerCli}
                </span>
              </div>
            )}
          </div>
        )}

        {/* CLI selectors — only meaningful for execution workflows, only before start */}
        {!wf && wfType === 'execution' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 6 }}>
              Developer CLI
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['claude', 'codex'] as const).map(cli => (
                <button
                  key={cli}
                  onClick={() => setDeveloperCli(cli)}
                  style={{
                    flex: 1, padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
                    background: developerCli === cli ? 'var(--accent)' : 'transparent',
                    color: developerCli === cli ? '#0d0f14' : 'var(--text-dim)',
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    cursor: 'pointer', textTransform: 'capitalize',
                  }}
                >
                  {cli}
                </button>
              ))}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
              Used for Frontend/Backend/iOS/Android Dev roles.
            </div>

            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginTop: 12, marginBottom: 6 }}>
              Reviewer CLI
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['auto', 'claude', 'codex'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setReviewerCliMode(mode)}
                  style={{
                    flex: 1, padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
                    background: reviewerCliMode === mode ? 'var(--accent)' : 'transparent',
                    color: reviewerCliMode === mode ? '#0d0f14' : 'var(--text-dim)',
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    cursor: 'pointer', textTransform: 'capitalize',
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>
              {reviewerCliMode === 'auto'
                ? `Auto = opposite of developer (currently ${effectiveReviewerCli}). Used for Code Reviewer + Security roles.`
                : `Override: ${effectiveReviewerCli}. Used for Code Reviewer + Security roles.`}
            </div>
          </div>
        )}

        {/* Start / Cancel */}
        {!wf ? (
          (() => {
            const canStart = wfType === 'onboarding' || !!input.trim()
            return (
              <>
                <button onClick={startWorkflow} disabled={!canStart} style={{
                  width: '100%', padding: '8px 0', borderRadius: 4, border: 'none',
                  background: canStart ? 'var(--green)' : 'var(--surface3)',
                  color: canStart ? '#0d0f14' : 'var(--muted)',
                  fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
                  cursor: canStart ? 'pointer' : 'not-allowed', marginBottom: startError ? 8 : 16,
                }}>
                  Start Workflow
                </button>
                {startError && (
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
                    background: 'rgba(255,95,95,0.08)', border: '1px solid rgba(255,95,95,0.2)',
                    borderRadius: 4, padding: '8px 10px', marginBottom: 16,
                  }}>
                    {startError}
                  </div>
                )}
              </>
            )
          })()
        ) : (
          <button onClick={cancelWorkflow} style={{
            width: '100%', padding: '8px 0', borderRadius: 4,
            border: '1px solid rgba(255,95,95,0.2)', background: 'rgba(255,95,95,0.08)',
            color: 'var(--red)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
            cursor: 'pointer', marginBottom: 16,
          }}>
            Cancel Workflow
          </button>
        )}

        {/* Auto-advance toggle */}
        {wf && wf.currentStep !== 'completed' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 16, padding: '8px 10px',
            background: autoAdvance ? 'rgba(245,158,11,0.08)' : 'transparent',
            border: `1px solid ${autoAdvance ? 'rgba(245,158,11,0.2)' : 'var(--border-subtle)'}`,
            borderRadius: 'var(--radius)',
          }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10,
              color: autoAdvance ? 'var(--accent)' : 'var(--muted)',
              fontWeight: 600, userSelect: 'none',
            }}>
              <input
                type="checkbox"
                checked={autoAdvance}
                onChange={e => {
                  setAutoAdvance(e.target.checked)
                  if (e.target.checked) setAutoAdvanceRound(0)
                }}
                style={{ accentColor: 'var(--accent)' }}
              />
              Auto-advance
            </label>
            {wf.type === 'review' && (
              <label
                title="Send review rounds back to PM on ANY finding (medium/low included), until reviews are clean or max rounds is reached"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10,
                  color: autoAdvanceStrict ? 'var(--accent)' : 'var(--muted)',
                  fontWeight: 600, userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={autoAdvanceStrict}
                  onChange={e => setAutoAdvanceStrict(e.target.checked)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                Strict
              </label>
            )}
            <span style={{ flex: 1 }} />
            {autoAdvance && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
                {autoAdvanceRound}/{AUTO_ADVANCE_MAX_ROUNDS}
              </span>
            )}
          </div>
        )}

        {/* Steps */}
        {(() => {
          const FIX_LOOP_KEYS = ['fix_plan', 'fix_execution', 'fix_review', 'fix_qa', 'fix_security', 'review_cap_reached']

          function computeStepVis(s: typeof steps[0]) {
            const sd = wf?.steps[s.key]
            let statusClass = ''
            let statusText = 'Pending'

            if (wf && s.key === wf.currentStep && wf.currentStep !== 'completed') {
              statusClass = 'running'; statusText = 'Active'
            } else if (sd?.status === 'completed') {
              const fixStepMapNew: Record<string, string> = {
                code_review: 'fix_plan', qa_validation: 'fix_plan', ac_verification: 'fix_plan',
                security_audit: 'fix_plan', demo_review: 'fix_plan', reviewing: 'pm_fix', team_review: 'pm_revision',
              }
              const fixStepMapOld: Record<string, string> = {
                code_review: 'fix_review', qa_validation: 'fix_qa', security_audit: 'fix_security',
              }
              const fixKey = fixStepMapNew[s.key], fixKeyOld = fixStepMapOld[s.key]
              const hasFixStep = (fixKey && wf?.steps[fixKey]) || (fixKeyOld && wf?.steps[fixKeyOld])
              // Only mark this step as failed/repeating if IT is the source of the current fix loop
              const isFixSource = wf?.fixSource === s.key
              const isInFixLoop = isFixSource && hasFixStep && (
                (fixKey && (wf?.currentStep === fixKey || wf?.steps[fixKey]?.status === 'running')) ||
                (fixKeyOld && (wf?.currentStep === fixKeyOld || wf?.steps[fixKeyOld]?.status === 'running')) ||
                FIX_LOOP_KEYS.includes(wf?.currentStep ?? '')
              )
              const hadBlockingAgents = sd.agents?.some((a: WorkflowAgent) => a.feedback && detectVerdict(a) === 'blocking')
              if (isInFixLoop || (isFixSource && hadBlockingAgents && hasFixStep)) { statusClass = 'failed'; statusText = 'Failed' }
              else if (!isFixSource && hasFixStep && FIX_LOOP_KEYS.includes(wf?.currentStep ?? '')) { statusClass = 'running'; statusText = 'Will Re-run' }
              else { statusClass = 'completed'; statusText = 'Done' }
            }

            if (wf && ['implementation', 'merge_for_review'].includes(s.key) && wf?.steps[s.key]?.status === 'completed') {
              if (FIX_LOOP_KEYS.includes(wf.currentStep)) { statusClass = 'running'; statusText = 'Repeating' }
            }
            if (s.key === 'merge_for_review' && statusClass === 'completed') {
              const crStep = wf?.steps?.code_review
              const crHadBlocking = crStep?.agents?.some((a: WorkflowAgent) => a.feedback && (detectVerdict(a) === 'blocking' || detectVerdict(a) === 'changes'))
              if (crHadBlocking && ((wf?.steps?.fix_plan && wf.fixSource === 'code_review') || wf?.steps?.fix_review)) {
                statusClass = 'failed'; statusText = 'Issues Found'
              }
            }

            const isSelected = activeKey === s.key
            const dotColor = statusClass === 'completed' ? 'var(--green)' : statusClass === 'failed' ? 'var(--red)' : statusClass === 'running' ? 'var(--yellow)' : 'var(--surface3)'
            const textColor = statusClass === 'completed' ? 'var(--green)' : statusClass === 'failed' ? 'var(--red)' : statusClass === 'running' ? 'var(--yellow)' : 'var(--muted)'
            return { statusClass, statusText, dotColor, textColor, isSelected }
          }

          function renderStepRow(s: typeof steps[0], vis: ReturnType<typeof computeStepVis>, inFixGroup = false) {
            const { statusClass, statusText, dotColor, textColor, isSelected } = vis
            return (
              <div key={s.key}>
                <div
                  onClick={() => setSelectedStep(s.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: inFixGroup ? '5px 6px' : '6px 8px',
                    borderRadius: 4, cursor: 'pointer',
                    background: isSelected
                      ? inFixGroup ? 'rgba(245,158,11,0.12)' : 'var(--surface2)'
                      : 'transparent',
                    borderLeft: isSelected
                      ? `2px solid ${inFixGroup ? 'var(--orange)' : 'var(--accent)'}`
                      : '2px solid transparent',
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dotColor, border: statusClass ? 'none' : '1.5px solid var(--muted)' }} />
                  <div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: textColor }}>{statusText}</div>
                  </div>
                </div>
                {s.loopHint && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginLeft: 26, marginTop: 2 }}>{s.loopHint}</div>}
              </div>
            )
          }

          // Group steps: consecutive fix-loop steps become a single grouped segment
          type Seg = { type: 'step'; s: typeof steps[0] } | { type: 'fix-group'; items: typeof steps }
          const segs: Seg[] = []
          let j = 0
          while (j < steps.length) {
            if (FIX_LOOP_KEYS.includes(steps[j].key)) {
              const group: typeof steps = []
              while (j < steps.length && FIX_LOOP_KEYS.includes(steps[j].key)) group.push(steps[j++])
              segs.push({ type: 'fix-group', items: group })
            } else {
              segs.push({ type: 'step', s: steps[j++] })
            }
          }

          const CONN = (key: string, orange = false) => (
            <div key={key} style={{ width: 1, height: 12, background: orange ? 'rgba(245,158,11,0.35)' : 'var(--border)', marginLeft: orange ? 7 : 9 }} />
          )

          return segs.map((seg, si) => {
            if (seg.type === 'step') {
              const vis = computeStepVis(seg.s)
              return (
                <div key={seg.s.key}>
                  {si > 0 && CONN(`c-${si}`)}
                  {renderStepRow(seg.s, vis)}
                </div>
              )
            }

            // Fix-loop group — boxed
            const isActive = seg.items.some(s => s.key === wf?.currentStep)
            const isDone = seg.items.every(s => wf?.steps[s.key]?.status === 'completed')
            const borderColor = isActive ? 'rgba(245,158,11,0.45)' : isDone ? 'rgba(245,158,11,0.2)' : 'rgba(245,158,11,0.2)'
            const bgColor = isActive ? 'rgba(245,158,11,0.04)' : 'rgba(245,158,11,0.02)'

            return (
              <div key="fix-group">
                {si > 0 && CONN(`c-${si}`)}
                <div style={{ border: `1px solid ${borderColor}`, borderRadius: 6, background: bgColor, padding: '6px 6px 4px' }}>
                  {/* Label */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, paddingLeft: 2 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, color: 'rgba(245,158,11,0.65)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      ↻ Fix loop
                    </span>
                    {wf?.fixSource && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'rgba(245,158,11,0.4)' }}>
                        from {wf.fixSource.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                  {/* Steps inside box */}
                  {seg.items.map((s, fi) => (
                    <div key={s.key}>
                      {fi > 0 && CONN(`fc-${fi}`, true)}
                      {renderStepRow(s, computeStepVis(s), true)}
                    </div>
                  ))}
                </div>
              </div>
            )
          })
        })()}

        {wf?.currentStep === 'completed' && (
          <>
            <div style={{ width: 1, height: 12, background: 'var(--border)', marginLeft: 9 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--green)' }}>Complete</div>
            </div>
          </>
        )}

        {/* Token usage summary */}
        {(() => {
          // PRD total: sum all agents in current workflow
          let prdTokens = 0
          if (wf) {
            for (const step of Object.values(wf.steps || {}) as any[]) {
              // Accumulated tokens from previous agent cycles
              if (step.cumulativeTokens) {
                prdTokens += step.cumulativeTokens.inputTokens + step.cumulativeTokens.outputTokens
              }
              // Current agents not yet captured to cumulative
              for (const a of (step.agents || [])) {
                if (a.tokenUsage) prdTokens += a.tokenUsage.inputTokens + a.tokenUsage.outputTokens
              }
            }
            for (const ts of Object.values((wf as any).taskExecution?.taskStates || {}) as any[]) {
              if (ts.cumulativeTokens) {
                prdTokens += ts.cumulativeTokens.inputTokens + ts.cumulativeTokens.outputTokens
              }
              // Current agents not yet captured
              for (const a of (ts.agents || [])) {
                if (a.tokenUsage) prdTokens += a.tokenUsage.inputTokens + a.tokenUsage.outputTokens
              }
            }
          }
          const fmt = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n/1000)}k` : String(n)
          if (!prdTokens && !tokenStats?.projectTokens) return null
          return (
            <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 8 }}>Usage</div>
              {prdTokens > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>This PRD</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--text)' }}>{fmt(prdTokens)} tok</span>
                </div>
              )}
              {tokenStats && tokenStats.projectTokens > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>Project total</span>
                  <span title={`API-equiv: $${tokenStats.projectCostUSD.toFixed(2)} across ${tokenStats.prds.length} PRD(s)`} style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--text)' }}>{fmt(tokenStats.projectTokens)} tok</span>
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Right: Detail panel */}
      <div style={{ overflow: 'auto', padding: 24, minWidth: 0 }}>
        {advanceError && (
          <div style={{
            marginBottom: 12, padding: '10px 14px', borderRadius: 4,
            background: 'color-mix(in srgb, var(--red) 15%, transparent)',
            border: '1px solid var(--red)',
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <span style={{ flexShrink: 0 }}>✕</span>
            <span style={{ flex: 1 }}>{advanceError}</span>
            <button onClick={() => setAdvanceError(null)} style={{
              background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 12, flexShrink: 0, padding: 0,
            }}>dismiss</button>
          </div>
        )}
        {/* Auto-advance paused — server-side auto-advance hit a gate it can't clear and stopped
            hammering. Surface the reason so the stall isn't invisible (the old failure mode). */}
        {wf && wf.currentStep !== 'completed' && wf.steps?.[wf.currentStep]?.autoAdvanceError && (
          <div style={{
            marginBottom: 12, padding: '10px 14px', borderRadius: 4,
            background: 'color-mix(in srgb, var(--orange) 13%, transparent)',
            border: '1px solid var(--orange)',
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--orange)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <span style={{ flexShrink: 0 }}>⏸</span>
            <span style={{ flex: 1 }}>
              Auto-advance paused on <b>{wf.currentStep}</b>: {wf.steps[wf.currentStep].autoAdvanceError}
              <br />
              <span style={{ color: 'var(--muted)' }}>Fix the cause then re-enable Auto-advance, or use the step actions below (approve / override / skip / send back).</span>
            </span>
          </div>
        )}
        {/* Overseer card — execution workflows only (review workflows don't have mechanical fix issues) */}
        {wf && wf.type === 'execution' && wf.currentStep !== 'completed' && wf.overseer && wf.overseer.status !== 'idle' && (
          <OverseerCard overseer={wf.overseer} onDismiss={dismissOverseerEscalation} onNudgeAgent={nudgeAgent} />
        )}
        {viewingLog ? (
          <AgentLog logText={logText} onClose={() => { setViewingLog(null); setLogText('') }} windowName={viewingLog} />
        ) : (
          <StepDetail
            wf={wf}
            pathologySignals={pathologySignals}
            findings={findings.map(f => findingOverrides[f.id] ? { ...f, status: findingOverrides[f.id] } : f)}
            onFindingToggle={(id, next) => setFindingOverrides(prev => ({ ...prev, [id]: next }))}
            activeKey={activeKey}
            notes={notes}
            setNotes={setNotes}
            advancing={advancing}
            onAdvance={advanceWorkflow}
            onFinish={finishWorkflow}
            onViewLog={(w) => setViewingLog(w)}
            onMarkDone={markAgentDone}
          />
        )}
      </div>

      {/* Cancel confirmation dialog */}
      {cancelDialogOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setCancelDialogOpen(false)}>
          <div style={{
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 24, width: 380, display: 'flex', flexDirection: 'column', gap: 16,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, color: 'var(--fg)' }}>
              Cancel Workflow
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Running agents will be stopped. Branches are preserved by default so work is not lost.
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={cancelDeleteWorktrees}
                onChange={e => setCancelDeleteWorktrees(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: 'var(--red)', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 13, color: cancelDeleteWorktrees ? 'var(--red)' : 'var(--fg)' }}>
                Delete worktrees and branches
              </span>
            </label>
            {cancelDeleteWorktrees && (
              <div style={{ fontSize: 12, color: 'var(--red)', background: 'rgba(255,95,95,0.08)', borderRadius: 4, padding: '8px 10px' }}>
                All agent branches will be permanently deleted. The next run will start fresh.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCancelDialogOpen(false)} style={{
                padding: '7px 16px', borderRadius: 4, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
              }}>
                Keep Running
              </button>
              <button onClick={confirmCancel} style={{
                padding: '7px 16px', borderRadius: 4,
                border: `1px solid ${cancelDeleteWorktrees ? 'rgba(255,95,95,0.4)' : 'var(--border)'}`,
                background: cancelDeleteWorktrees ? 'rgba(255,95,95,0.12)' : 'var(--surface3)',
                color: cancelDeleteWorktrees ? 'var(--red)' : 'var(--fg)',
                fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>
                {cancelDeleteWorktrees ? 'Cancel + Delete Branches' : 'Cancel Workflow'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StepDetail({
  wf, pathologySignals, findings, onFindingToggle, activeKey, notes, setNotes, advancing, onAdvance, onFinish, onViewLog, onMarkDone,
}: {
  wf: Workflow | null
  pathologySignals: PathologySignals | null
  findings: Finding[]
  onFindingToggle: (id: string, next: Finding['status']) => void
  activeKey: string
  notes: string
  setNotes: (v: string) => void
  advancing: string | null
  onAdvance: (action?: string, extra?: Record<string, unknown>) => void
  onFinish: () => void
  onViewLog: (window: string) => void
  onMarkDone: (role: string) => void
}) {
  if (!wf) {
    return <Empty icon="⚙" text="Select a workflow type and PRD to begin" />
  }

  if (activeKey === 'completed') {
    const msg = wf.type === 'execution' ? 'The review branch is ready to merge to main.'
      : wf.type === 'kickoff' ? 'Kickoff complete — project is ready for PRD iterations.'
      : 'PRD has been approved.'
    return (
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Workflow Complete</div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>{msg}</div>
        {wf.reviewBranch && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)', background: 'var(--surface2)', padding: '8px 12px', borderRadius: 6, display: 'inline-block', marginBottom: 16 }}>
            Branch: {wf.reviewBranch}
          </div>
        )}
        <div>
          <button onClick={onFinish} style={{
            padding: '8px 16px', borderRadius: 4, border: 'none',
            background: 'var(--green)', color: '#0d0f14',
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer',
          }}>
            Merge &amp; Clean Up
          </button>
        </div>
      </div>
    )
  }

  const step = wf.steps[activeKey] as WorkflowStep & { validationFailure?: { missing?: { type: string; description: string; expected_path?: string }[]; message?: string } }
  if (!step) return <Empty icon="⏳" text="Step not started yet" />

  const agents = step.agents || []
  const allDone = agents.length > 0 && agents.every(a => a.status === 'done' || a.status === 'error')
  const isCurrentStep = activeKey === wf.currentStep
  const doneCount = agents.filter(a => a.status === 'done').length
  // qa_tests is TDD — failing tests are expected, never treat as blocking
  const hasBlockingIssues = activeKey === 'qa_tests' ? false : agents.some(a => a.feedback && detectVerdict(a) === 'blocking')

  // Aggregate reviewer comment counts so the summary is visible without opening each card.
  const reportedCounts = agents.map(a => parseCommentCounts(a.feedback)).filter(Boolean) as { blocking: number; medium: number; low: number }[]
  const commentTotals = reportedCounts.reduce(
    (acc, c) => ({ blocking: acc.blocking + c.blocking, medium: acc.medium + c.medium, low: acc.low + c.low }),
    { blocking: 0, medium: 0, low: 0 }
  )

  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
        {activeKey === 'fix_plan' ? `Fix Plan (from ${wf.fixSource || 'review'})`
          : activeKey === 'fix_execution' && wf.fixPlan
          ? `Fix ${(wf.fixTaskIndex || 0) + 1}/${wf.fixPlan.tasks.length}: ${wf.fixPlan.tasks[wf.fixTaskIndex || 0]?.name || ''}`
          : ([...Object.values(WF_STEPS).flat(),
              { key: 'fix_review', name: 'Fix Review Issues' },
              { key: 'fix_qa', name: 'Fix QA Issues' },
              { key: 'fix_security', name: 'Fix Security Issues' },
            ].find(s => s.key === activeKey)?.name ?? activeKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
        } {wf.round > 1 && `— Round ${wf.round}`}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
        {activeKey === 'fix_execution' && wf.fixPlan
          ? `${step.completedTasks?.length || 0}/${wf.fixPlan.tasks.length} fix tasks completed`
          : activeKey === 'task_execution' ? ''
          : agents.length > 0 ? `${doneCount}/${agents.length} done` : ''}
      </div>

      {/* Aggregated reviewer comment summary — avoids opening each agent card to tally counts */}
      {reportedCounts.length > 0 && (
        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', marginTop: -8, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-dim)' }}>
            Comments{reportedCounts.length < agents.length ? ` (${reportedCounts.length}/${agents.length} reported)` : ''}:
          </span>
          <span style={{ color: commentTotals.blocking > 0 ? 'var(--red)' : 'var(--muted)', fontWeight: commentTotals.blocking > 0 ? 700 : 400 }}>
            {commentTotals.blocking} blocking
          </span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ color: commentTotals.medium > 0 ? 'var(--orange)' : 'var(--muted)' }}>
            {commentTotals.medium} medium
          </span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ color: 'var(--muted)' }}>
            {commentTotals.low} low
          </span>
          {allDone && commentTotals.blocking === 0 && commentTotals.medium === 0 && (
            <span style={{ color: 'var(--green)' }}>✓ no blocking or medium comments</span>
          )}
        </div>
      )}

      {/* Blocked-with-error banner — generic for any step that halted with a message but no validationFailure payload */}
      {step.status === 'blocked' && step.error && !step.validationFailure && (
        <div style={{
          background: 'rgba(255, 140, 0, 0.1)', border: '1px solid var(--orange)',
          borderRadius: 6, padding: '12px 16px', marginBottom: 16,
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--orange)', marginBottom: 8 }}>
            Step Blocked — Manual Decision Needed
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', whiteSpace: 'pre-wrap', marginBottom: 10 }}>
            {step.error}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onAdvance('approve')} className="wf-btn primary">Approve and continue</button>
            <button onClick={() => onAdvance('skip')} className="wf-btn secondary">Skip step</button>
            <button onClick={() => onAdvance('relaunch')} className="wf-btn secondary">Relaunch step</button>
          </div>
        </div>
      )}

      {/* Validation failure banner */}
      {step.status === 'blocked' && step.validationFailure && (
        <div style={{
          background: 'rgba(255, 140, 0, 0.1)', border: '1px solid var(--orange)',
          borderRadius: 6, padding: '12px 16px', marginBottom: 16,
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--orange)', marginBottom: 8 }}>
            Input Validation Failed
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', marginBottom: 8 }}>
            {step.validationFailure.message || 'Missing artifacts referenced by the PRD.'}
          </div>
          {step.validationFailure.missing?.map((m: { type: string; description: string; expected_path?: string }, i: number) => (
            <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', padding: '2px 0' }}>
              [{m.type}] {m.description}{m.expected_path ? ` — ${m.expected_path}` : ''}
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            <button onClick={() => onAdvance('relaunch')} className="wf-btn secondary">
              Relaunch after fixing
            </button>
          </div>
        </div>
      )}

      {/* Task progress view — monolithic gets ribbon + pathology, fine-grained keeps task board */}
      {activeKey === 'task_execution' && wf.taskExecution && wf.taskPlan && (
        wf.taskPlan.tasks.length === 1
          ? <MonolithicProgress wf={wf} signals={pathologySignals} onViewLog={onViewLog} />
          : <TaskBoard wf={wf} onSkipBlocked={onAdvance} onViewLog={onViewLog} />
      )}

      {/* Fix execution: findings checklist (PRD-001) above completed-tasks list */}
      {activeKey === 'fix_execution' && findings.length > 0 && (
        <FindingsChecklist findings={findings} onToggle={onFindingToggle} />
      )}

      {/* Fix execution completed tasks */}
      {activeKey === 'fix_execution' && step.completedTasks && step.completedTasks.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {step.completedTasks.map((t: { id?: number; name: string; status: string }, i: number) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontFamily: 'var(--mono)', fontSize: 11, padding: '3px 0',
              color: 'var(--muted)',
            }}>
              <span style={{ color: 'var(--green)' }}>✓</span>
              <span>Fix {t.id || i + 1}: {t.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Agent cards — two columns when wide enough */}
      {agents.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(max(400px, calc(33.33% - 7px)), 1fr))',
          gap: 10,
          marginBottom: 20,
        }}>
          {agents.map((a, i) => {
            const taskLabel = activeKey === 'task_execution' && a.taskIndex !== undefined
              ? `Task ${a.taskIndex + 1}`
              : undefined
            return <AgentFeedbackCard key={i} agent={a} taskLabel={taskLabel} onViewLog={onViewLog} onMarkDone={onMarkDone} onRelaunchTask={(idx) => onAdvance('relaunch_task', { taskIndex: idx })} />
          })}
        </div>
      )}

      {/* Learnings preview — show what the agent wrote before approving */}
      {activeKey === 'capture_learnings' && allDone && (
        <LearningsPreview />
      )}


      {/* Merge results */}
      {step.mergeResults && (
        <div style={{ marginBottom: 16 }}>
          {step.mergeResults.map((mr, i) => (
            <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 12, color: mr.status === 'merged' ? 'var(--green)' : mr.status === 'conflict' ? 'var(--red)' : 'var(--text-dim)', marginBottom: 4 }}>
              {mr.status === 'merged' ? '✓' : mr.status === 'conflict' ? '✗' : '○'} {mr.branch}: {mr.status}{mr.error ? ` — ${mr.error}` : ''}
            </div>
          ))}
        </div>
      )}

      {/* Review cap — blocked, needs human decision to force-continue */}
      {isCurrentStep && activeKey === 'review_cap_reached' && (
        <ActionArea label={`Fix loop capped after ${(step as any).rounds ?? wf.round} rounds:`}>
          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
            The workflow has cycled through {(step as any).rounds ?? wf.round} fix rounds without fully resolving all issues.
            You can force-continue (re-merge and re-review) or cancel the workflow.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onAdvance('approve')} className="wf-btn primary">
              Force Continue →
            </button>
            <button onClick={() => onAdvance('cancel')} className="wf-btn secondary">
              Cancel Workflow
            </button>
          </div>
        </ActionArea>
      )}

      {/* Error state — show retry for merge steps */}
      {isCurrentStep && step.status === 'error' && (activeKey === 'merge_for_review' || activeKey === 'merge_to_main') && (
        <ActionArea label="Merge failed:">
          <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--red)', fontFamily: 'var(--mono)' }}>
            {step.error || 'Unknown error'}
          </div>
          <button onClick={() => onAdvance('retry')} className="wf-btn primary">
            Retry Merge
          </button>
        </ActionArea>
      )}

      {/* Actions */}
      {isCurrentStep && step.status === 'pending' && agents.length === 0 && (() => {
        // Manual steps that don't launch agents — show approve/skip instead
        const manualSteps = ['demo_review', 'device_testing', 'merge_to_main', 'merge_for_review', 'owner_signoff', 'owner_consultations']
        if (manualSteps.includes(activeKey)) {
          const isOwnerConsult = activeKey === 'owner_consultations'
          const isDeviceTest = activeKey === 'device_testing'
          const hasTextarea = activeKey === 'demo_review' || activeKey === 'owner_signoff' || isOwnerConsult || isDeviceTest
          return (
            <div>
              {isDeviceTest && wf.branch && (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 8,
                  padding: '8px 12px', background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)',
                }}>
                  Build this branch in Xcode: <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{wf.branch}</span>
                  {' — '}the run&apos;s work lives here; <span style={{ color: 'var(--text-dim)' }}>{wf.defaultBranch || 'main'}</span> still has the last shipped build.
                </div>
              )}
              {activeKey === 'demo_review' && (
                <DemoReviewContext wf={wf} />
              )}
              {activeKey === 'owner_signoff' && (
                <OwnerSignoffContext />
              )}
              {isOwnerConsult && (
                <OwnerConsultationContext wf={wf} />
              )}
              <ActionArea label={
                activeKey === 'demo_review' ? 'Manual verification:'
                : isDeviceTest ? 'Physical device verification — run the suite on a real device:'
                : activeKey === 'owner_signoff' ? 'Final review — first onboarding commit:'
                : isOwnerConsult ? 'Owner consultation — read PM output, add notes, approve:'
                : 'Manual step:'
              }>
                {hasTextarea && (
                  <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder={
                      activeKey === 'owner_signoff'
                        ? 'If sending back to PM: what needs to change? (required for send-back)'
                        : isOwnerConsult
                          ? 'Owner answers, decisions, additional input for the team review (optional). Saved to docs/inputs/owner-consultation-round-N.md.'
                          : isDeviceTest
                            ? 'If sending back to devs: what failed on the physical device that did not surface in the simulator? (required for send-back)'
                            : 'Describe issues found during demo (required for send-back)...'
                    }
                    style={{
                      width: '100%', minHeight: isOwnerConsult ? 120 : 50, resize: 'vertical', marginBottom: 8,
                      background: 'var(--surface2)', border: '1px solid var(--border)',
                      borderRadius: 4, color: 'var(--text)', fontFamily: 'var(--mono)',
                      fontSize: 12, padding: '8px 10px', outline: 'none',
                    }}
                  />
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  {(activeKey === 'demo_review' || isDeviceTest) && (
                    <button
                      onClick={() => onAdvance('send_to_devs')}
                      disabled={!notes.trim()}
                      style={{
                        padding: '8px 16px', borderRadius: 4, border: 'none',
                        background: 'var(--orange)', color: '#0d0f14',
                        fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
                        cursor: !notes.trim() ? 'not-allowed' : 'pointer',
                        opacity: !notes.trim() ? 0.4 : 1,
                      }}
                    >
                      ↻ Send back to Devs
                    </button>
                  )}
                  {activeKey === 'owner_signoff' && (
                    <button
                      onClick={() => onAdvance('send_back')}
                      disabled={!notes.trim()}
                      style={{
                        padding: '8px 16px', borderRadius: 4, border: 'none',
                        background: 'var(--orange)', color: '#0d0f14',
                        fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
                        cursor: !notes.trim() ? 'not-allowed' : 'pointer',
                        opacity: !notes.trim() ? 0.4 : 1,
                      }}
                    >
                      ↻ Send back to PM
                    </button>
                  )}
                  <button onClick={() => onAdvance('approve')} className="wf-btn primary">
                    {activeKey === 'demo_review' ? 'Approve Demo'
                      : isDeviceTest ? 'Approve device run'
                      : activeKey === 'owner_signoff' ? 'Approve and commit'
                      : isOwnerConsult ? 'Approve and continue to team review'
                      : activeKey.includes('merge') ? 'Merge' : 'Complete'}
                  </button>
                  {(activeKey === 'demo_review' || isDeviceTest) && (
                    <button onClick={() => onAdvance('skip')} className="wf-btn secondary">Skip</button>
                  )}
                </div>
              </ActionArea>
            </div>
          )
        }
        return (
          <ActionArea label="Ready to launch:">
            <button
              onClick={() => onAdvance('launch')}
              className="wf-btn primary"
              disabled={advancing === 'launch'}
            >
              {advancing === 'launch' ? 'Starting agents…' : 'Launch'}
            </button>
          </ActionArea>
        )
      })()}

      {isCurrentStep && (step.status !== 'pending' || agents.length > 0) && !(step.status === 'error' && agents.length === 0) && (
        <StepActions
          activeKey={activeKey}
          wfType={wf.type}
          allDone={allDone}
          hasBlockingIssues={hasBlockingIssues}
          notes={notes}
          setNotes={setNotes}
          onAdvance={onAdvance}
        />
      )}
    </div>
  )
}

// PRD-001: Monolithic task_execution progress view — commit ribbon + pathology panel.
// Replaces the per-task ticker for single-task plans where the operator otherwise
// has no continuous progress signal.
function MonolithicProgress({ wf, signals, onViewLog }: { wf: Workflow; signals: PathologySignals | null; onViewLog: (w: string) => void }) {
  const ts = wf.taskExecution?.taskStates?.['0']
  const startedAt = ts?.startedAt || null
  const isRunning = ts?.status === 'running'
  const agentWindow = (ts?.agents || []).find((a: WorkflowAgent) => a.window)?.window
  const tokenSum = ts?.tokenUsage
    ? ts.tokenUsage.inputTokens + ts.tokenUsage.outputTokens + (ts.tokenUsage.cacheRead || 0)
    : 0
  const fmtTok = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n/1000)}k` : String(n)
  let elapsedStr: string | null = null
  if (startedAt) {
    const endTs = ts?.completedAt ? new Date(ts.completedAt).getTime() : Date.now()
    const secs = Math.round((endTs - new Date(startedAt).getTime()) / 1000)
    elapsedStr = secs >= 3600 ? `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`
      : secs >= 60 ? `${Math.floor(secs/60)}m ${secs%60}s`
      : `${secs}s`
  }
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {isRunning ? 'Monolithic agent running' : ts?.status === 'done' ? 'Monolithic agent complete' : 'Monolithic task_execution'}
          {elapsedStr ? ` · ${elapsedStr}` : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {tokenSum > 0 && (
            <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
              {fmtTok(tokenSum)} tok
            </span>
          )}
          {agentWindow && (
            <button
              onClick={() => onViewLog(agentWindow)}
              title="View live tmux pane for this agent"
              style={{
                padding: '6px 14px', borderRadius: 5,
                border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              <span style={{ fontSize: 13, lineHeight: 1 }}>▤</span>
              View log
            </button>
          )}
        </div>
      </div>
      <PathologyPanel signals={signals} isRunning={isRunning} />
      <CommitRibbon sinceISO={startedAt} isRunning={isRunning} />
    </div>
  )
}

function TaskBoard({ wf, onSkipBlocked, onViewLog }: { wf: Workflow; onSkipBlocked: (action: string, extra?: Record<string, unknown>) => void; onViewLog: (window: string) => void }) {
  const tex = wf.taskExecution!
  const tasks = wf.taskPlan!.tasks
  const { taskStates } = tex
  const totalTasks = tasks.length
  const doneTasks = Object.values(taskStates).filter(ts => ts.status === 'done').length
  const totalTokens = Object.values(taskStates)
    .reduce((sum, ts) => sum + (ts.tokenUsage ? ts.tokenUsage.inputTokens + ts.tokenUsage.outputTokens + ts.tokenUsage.cacheRead : 0), 0)
  const fmtTok = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n/1000)}k` : String(n)

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {doneTasks} / {totalTasks} tasks complete
        </span>
        {totalTokens > 0 && (
          <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
            {fmtTok(totalTokens)} tok total
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${totalTasks > 0 ? (doneTasks / totalTasks) * 100 : 0}%`, background: 'var(--green)', borderRadius: 2, transition: 'width 0.4s ease' }} />
      </div>

      {/* Task list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tasks.map((task, i) => {
          const ts = taskStates[String(i)]
          if (!ts) return null
          const isRunning = ts.status === 'running'
          const isDone = ts.status === 'done'
          const isError = ts.status === 'error'
          const isPending = ts.status === 'pending'

          // Status color
          const statusColor = isDone ? 'var(--green)' : isRunning ? 'var(--blue)' : isError ? 'var(--red)' : 'var(--border)'

          // Duration
          let durationStr: string | null = null
          if (ts.startedAt && ts.completedAt) {
            const secs = Math.round((new Date(ts.completedAt).getTime() - new Date(ts.startedAt).getTime()) / 1000)
            durationStr = secs >= 60 ? `${Math.floor(secs/60)}m ${secs%60}s` : `${secs}s`
          }

          // Running agent activity
          const runningAgent = isRunning ? (ts.agents || []).find((a: WorkflowAgent) => a.status === 'running' || a.status === 'pending') : null

          return (
            <div key={i} style={{
              padding: '10px 12px',
              background: isRunning ? 'var(--surface2)' : 'var(--surface)',
              border: `1px solid ${isRunning ? 'var(--border-active, var(--border))' : 'var(--border)'}`,
              borderLeft: `3px solid ${statusColor}`,
              borderRadius: 6,
              opacity: isPending ? 0.45 : 1,
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: '28px auto 1fr auto', gap: '0 10px', alignItems: 'start' }}>
                {/* Task number */}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: statusColor, paddingTop: 1 }}>
                  T{i + 1}
                </span>

                {/* Role avatars + names */}
                <div style={{ display: 'flex', gap: 6, paddingTop: 1 }}>
                  {(task.roles || []).map(r => {
                    const src = avatarSrc(r, 88)
                    return (
                      <div key={r} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        {src
                          ? <img src={src} alt={r} title={r} style={{ width: 44, height: 44, borderRadius: 6 }} />
                          : <span title={r} style={{ fontSize: 14 }}>{roleConfig(r).avatar}</span>}
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, color: 'var(--text-dim)', whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>{r}</span>
                      </div>
                    )
                  })}
                </div>

                {/* Name + details */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{task.name}</div>
                  {!isDone && !isRunning && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {task.description}
                    </div>
                  )}
                  {isRunning && (runningAgent as any)?.activity && (
                    <div style={{ fontSize: 11, color: 'var(--blue)', lineHeight: 1.4, fontStyle: 'italic' }}>
                      {(runningAgent as any).activity}
                    </div>
                  )}
                  {isDone && ts.agentSummary && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {ts.agentSummary}
                    </div>
                  )}
                </div>

                {/* Status + meta */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                  {isRunning && (
                    <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)' }}>running</span>
                  )}
                  {isDone && (
                    <>
                      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)' }}>✓ done</span>
                      {ts.tokenUsage && (ts.tokenUsage.inputTokens + ts.tokenUsage.outputTokens) > 0 && (
                        <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }} title={`Input: ${ts.tokenUsage.inputTokens.toLocaleString()} · Output: ${ts.tokenUsage.outputTokens.toLocaleString()} · Cache: ${ts.tokenUsage.cacheRead.toLocaleString()}`}>
                          {fmtTok(ts.tokenUsage.inputTokens + ts.tokenUsage.outputTokens + ts.tokenUsage.cacheRead)} tok
                        </span>
                      )}
                      {durationStr && (
                        <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                          {durationStr}
                        </span>
                      )}
                    </>
                  )}
                  {isError && (
                    <>
                      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--red)' }}>error</span>
                      <button
                        onClick={() => onSkipBlocked('relaunch_task', { taskIndex: i })}
                        style={{ padding: '2px 8px', fontSize: 10, fontFamily: 'var(--mono)', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer' }}
                      >
                        ↺ Relaunch
                      </button>
                    </>
                  )}
                  {isPending && i <= tex.currentTaskIndex && (
                    <button
                      onClick={() => onSkipBlocked('relaunch_task', { taskIndex: i })}
                      style={{ padding: '2px 8px', fontSize: 10, fontFamily: 'var(--mono)', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer' }}
                    >
                      ▶ Launch
                    </button>
                  )}
                  {/* Log button — show for any task with an agent that has a tmux window */}
                  {(ts.agents || []).some((a: WorkflowAgent) => a.window) && (
                    <button
                      onClick={() => { const a = (ts.agents || []).find((a: WorkflowAgent) => a.window); if (a?.window) onViewLog(a.window) }}
                      style={{
                        padding: '2px 8px', borderRadius: 4,
                        border: '1px solid var(--border)', background: 'none',
                        color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer',
                      }}
                    >
                      Log
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StepActions({
  activeKey, wfType: _wfType, allDone, hasBlockingIssues, notes, setNotes, onAdvance,
}: {
  activeKey: string
  wfType: string
  allDone: boolean
  hasBlockingIssues: boolean
  notes: string
  setNotes: (v: string) => void
  onAdvance: (action?: string, extra?: Record<string, unknown>) => void
}) {
  const dis = !allDone

  // Determine which buttons to show based on step + workflow type
  const isReviewStep = activeKey === 'reviewing' || activeKey === 'team_review'
  // `reviewing` (review workflow) accepts `send_to_pm` to advance into pm_fix.
  // `team_review` (kickoff/onboarding) only has one forward path — pm_revision —
  // and the backend handler accepts `approve` for it, not `send_to_pm`.
  const sendToPmAction = activeKey === 'team_review' ? 'approve' : 'send_to_pm'
  const isCodeReview = activeKey === 'code_review'
  const isQaValidation = activeKey === 'qa_validation'
  const isAcVerification = activeKey === 'ac_verification'
  const isSecurityAudit = activeKey === 'security_audit'
  const isTaskExecution = activeKey === 'task_execution'
  const isQaTests = activeKey === 'qa_tests'
  const isPmFix = activeKey === 'pm_fix'
  const isFixStep = activeKey === 'fix_plan' || activeKey === 'fix_execution'
  const isOldFixStep = activeKey === 'fix_review' || activeKey === 'fix_qa' || activeKey === 'fix_security'
  const isDemoReview = activeKey === 'demo_review'

  let label = allDone ? 'All agents done:' : 'Waiting for agents...'
  if (allDone && hasBlockingIssues) label = 'Blocking issues found:'

  return (
    <ActionArea label={label}>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Notes (optional)..."
        style={{
          width: '100%', minHeight: 50, resize: 'vertical', marginBottom: 8,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 4, color: 'var(--text)', fontFamily: 'var(--mono)',
          fontSize: 12, padding: '8px 10px', outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {/* Review steps: Send to PM or Approve */}
        {isReviewStep && (
          <>
            <button onClick={() => onAdvance(sendToPmAction)} disabled={dis} className="wf-btn secondary">
              Send to PM
            </button>
            <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
              Approve
            </button>
          </>
        )}

        {/* PM Fix: send back to reviewers */}
        {isPmFix && (
          <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
            Send to Reviewers
          </button>
        )}

        {/* Code Review: approve or send back to devs */}
        {isCodeReview && (
          <>
            <button onClick={() => onAdvance('send_to_devs')} disabled={dis} style={{
              padding: '8px 16px', borderRadius: 4, border: 'none',
              background: hasBlockingIssues ? 'var(--orange)' : 'var(--surface3)',
              color: hasBlockingIssues ? '#0d0f14' : 'var(--text)',
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
              cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.4 : 1,
            }}>
              ↻ Send back to Devs
            </button>
            <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
              Approve
            </button>
          </>
        )}

        {/* QA Validation: approve, force-approve (override strict gate), or send back */}
        {isQaValidation && (
          <>
            <button onClick={() => onAdvance('send_to_devs')} disabled={dis} style={{
              padding: '8px 16px', borderRadius: 4, border: 'none',
              background: hasBlockingIssues ? 'var(--orange)' : 'var(--surface3)',
              color: hasBlockingIssues ? '#0d0f14' : 'var(--text)',
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
              cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.4 : 1,
            }}>
              ↻ Send back to Devs
            </button>
            <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
              Approve
            </button>
            {/* Override — bypasses the strict failing-tests gate. Use for known
                flakes / failures confirmed unrelated to this change. Logged on the step. */}
            <button
              onClick={() => {
                if (confirm('Force-approve QA despite failing tests?\n\nThe strict gate (zero failing tests on the run branch) will be bypassed. Use only for known flakes or failures you have confirmed are unrelated to this change. The override is recorded on the step.')) {
                  onAdvance('approve', { override: true, note: notes.trim() || 'operator force-approve (strict QA gate)' })
                }
              }}
              disabled={dis}
              className="wf-btn secondary"
              title="Bypass the strict failing-tests gate (e.g. known flakes)"
            >
              Force approve (override)
            </button>
          </>
        )}

        {/* Security Audit: approve or send back */}
        {isSecurityAudit && (
          <>
            <button onClick={() => onAdvance('send_to_devs')} disabled={dis} style={{
              padding: '8px 16px', borderRadius: 4, border: 'none',
              background: hasBlockingIssues ? 'var(--orange)' : 'var(--surface3)',
              color: hasBlockingIssues ? '#0d0f14' : 'var(--text)',
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
              cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.4 : 1,
            }}>
              ↻ Send back to Devs
            </button>
            <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
              Approve
            </button>
          </>
        )}

        {/* AC Verification: approve, override-approve, or send back to devs */}
        {isAcVerification && (
          <>
            <button onClick={() => onAdvance('send_to_devs')} disabled={dis} style={{
              padding: '8px 16px', borderRadius: 4, border: 'none',
              background: hasBlockingIssues ? 'var(--orange)' : 'var(--surface3)',
              color: hasBlockingIssues ? '#0d0f14' : 'var(--text)',
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12,
              cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.4 : 1,
            }}>
              ↻ Send back to Devs
            </button>
            <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
              Approve
            </button>
            {/* Override button — bypasses the missing-evidence gate. Use when
                evidence exists but the AC matrix cites a wrong/stale path. */}
            <button
              onClick={() => {
                if (confirm('Approve AC verification despite missing evidence?\n\nThe server-side check that all MANUAL ACs cite a real file will be bypassed. Use only when you have verified the evidence exists elsewhere or accepted the partial state.')) {
                  onAdvance('approve', { override: true })
                }
              }}
              disabled={dis}
              className="wf-btn secondary"
              title="Bypass the missing-evidence check"
            >
              Approve (override)
            </button>
          </>
        )}

        {/* Fix plan: approve the fix plan */}
        {activeKey === 'fix_plan' && (
          <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
            Approve Fix Plan
          </button>
        )}

        {/* Fix execution: approve current fix task */}
        {activeKey === 'fix_execution' && (
          <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
            Approve Fix Task → Next
          </button>
        )}

        {/* Old-style parallel fix steps: merge & continue */}
        {isOldFixStep && (
          <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
            Merge &amp; Continue
          </button>
        )}

        {/* Task execution runs autonomously — no user action needed here */}
        {isTaskExecution && null}

        {/* QA Tests (pre-implementation, TDD): approve once the QA agent has committed test
            files, or skip for a PRD that genuinely needs none (pure config/docs/infra). */}
        {isQaTests && (
          <>
            <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
              Approve
            </button>
            <button
              onClick={() => { if (confirm('Skip pre-implementation tests for this PRD?\n\nUse only when this PRD genuinely needs no pre-impl tests (pure config/docs/infra). Any uncommitted test scaffold is discarded and the workflow goes straight to Task Planning.')) onAdvance('skip') }}
              disabled={dis}
              className="wf-btn secondary"
              title="Skip the qa_tests gate — no pre-implementation tests for this PRD"
            >
              Skip tests
            </button>
          </>
        )}

        {/* Generic steps (merge, etc): just advance */}
        {!isReviewStep && !isPmFix && !isCodeReview && !isQaValidation && !isAcVerification && !isSecurityAudit && !isTaskExecution && !isQaTests && !isFixStep && !isOldFixStep && !isDemoReview && (
          <button onClick={() => onAdvance('approve')} disabled={dis} className="wf-btn primary">
            Advance
          </button>
        )}

        {/* Relaunch — always available, re-runs the current step from scratch */}
        <button
          onClick={() => { if (confirm('Relaunch this step? Running agents will be stopped and the step will restart.')) onAdvance('relaunch') }}
          className="wf-btn secondary"
          style={{ marginLeft: 'auto' }}
        >
          ↻ Relaunch
        </button>
      </div>
    </ActionArea>
  )
}

function AgentLog({ logText, onClose, windowName }: { logText: string; onClose: () => void; windowName: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button onClick={onClose} style={{
          padding: '3px 10px', borderRadius: 4, border: '1px solid var(--border)',
          background: 'none', color: 'var(--text-dim)', fontFamily: 'var(--mono)',
          fontSize: 11, cursor: 'pointer',
        }}>
          ← Back
        </button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
          {windowName}
        </span>
      </div>
      <pre style={{
        flex: 1, overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 6, padding: 12, fontFamily: 'var(--mono)', fontSize: 11,
        lineHeight: 1.5, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}>
        {logText || 'No output yet — agent starting...'}
      </pre>
    </div>
  )
}

interface ParsedLearning {
  path: string
  title: string
  date: string
  severity: string
  tags: string[]
  component: string
  content: string
  category: string
}

function parseLearningFrontmatter(filePath: string, raw: string): ParsedLearning | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return null
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) {
      let val = kv[2].trim()
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
      fm[kv[1]] = val
    }
  }
  const tagsRaw = m[1].match(/tags:\s*\[([^\]]*)\]/)
  const tags = tagsRaw ? tagsRaw[1].split(',').map(t => t.trim()) : []
  // Extract category from path: learnings/security/foo.md → security
  const pathParts = filePath.split('/')
  const catIdx = pathParts.indexOf('learnings')
  const category = catIdx >= 0 && pathParts[catIdx + 1] ? pathParts[catIdx + 1] : 'general'

  return {
    path: filePath,
    title: fm.title || filePath.split('/').pop()?.replace('.md', '') || '',
    date: fm.date || '',
    severity: fm.severity || 'medium',
    tags,
    component: fm.component || 'general',
    content: m[2].trim(),
    category,
  }
}

function LearningsPreview() {
  const { baseUrl } = useProject()
  const [learnings, setLearnings] = useState<ParsedLearning[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const data = await fetch(`${baseUrl}/api/files`).then(r => r.json())
        // Match files in learnings/<category>/<slug>.md (not .gitkeep)
        const learningFiles = (data.files || []).filter(
          (f: { path: string }) => f.path.match(/^learnings\/\w+\/.*\.md$/)
        )
        const parsed = await Promise.all(
          learningFiles.map(async (f: { path: string }) => {
            const fileData = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(f.path)}`).then(r => r.json())
            return parseLearningFrontmatter(f.path, fileData.content || '')
          })
        )
        setLearnings(parsed.filter((l): l is ParsedLearning => l !== null))
      } catch {}
      setLoading(false)
    }
    load()
  }, [baseUrl])

  if (loading) {
    return (
      <div style={{ padding: 16, marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--surface)' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>Loading learnings...</div>
      </div>
    )
  }

  if (learnings.length === 0) {
    return (
      <div style={{ padding: 16, marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--surface)' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>No learnings captured yet.</div>
      </div>
    )
  }

  // Group by category
  const grouped: Record<string, ParsedLearning[]> = {}
  for (const l of learnings) {
    if (!grouped[l.category]) grouped[l.category] = []
    grouped[l.category].push(l)
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--accent)', marginBottom: 10,
      }}>
        Review Learnings Before Approving ({learnings.length} total)
      </div>
      {Object.entries(grouped).sort().map(([cat, entries]) => (
        <LearningsCategoryGroup key={cat} category={cat} entries={entries} />
      ))}
    </div>
  )
}

function LearningsCategoryGroup({ category, entries }: { category: string; entries: ParsedLearning[] }) {
  const [expanded, setExpanded] = useState(true)
  const sevIcon = (s: string) => s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '⚪'

  return (
    <div style={{
      border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', marginBottom: 8, overflow: 'hidden',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', cursor: 'pointer',
          background: 'var(--surface2)',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          {expanded ? '▼' : '▶'}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>
          {category}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
          {entries.length}
        </span>
      </div>
      {expanded && (
        <div style={{ padding: '6px 14px' }}>
          {entries.map((l, i) => (
            <div key={l.path} style={{
              padding: '8px 0',
              borderBottom: i < entries.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span>{sevIcon(l.severity)}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                  {l.title}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
                  {l.severity}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 4 }}>
                {l.content}
              </div>
              {l.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {l.tags.map(t => (
                    <span key={t} style={{
                      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                      background: 'var(--surface3)', padding: '1px 5px', borderRadius: 3,
                    }}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OwnerSignoffContext() {
  // Reuses the /api/deployment endpoint (already polled by the CI/CD tab) so
  // we don't add a new API surface for v1. The file list shown here is
  // EXACTLY what `git add -A && git commit` will capture on Approve.
  const [info, setInfo] = useState<{ stagedFiles?: string[]; unstagedFiles?: string[]; untrackedFiles?: string[] } | null>(null)
  const { baseUrl } = useProject()
  useEffect(() => {
    fetch(`${baseUrl}/api/deployment`).then(r => r.ok ? r.json() : null).then(setInfo).catch(() => setInfo(null))
  }, [baseUrl])

  if (!info) return null
  const staged = info.stagedFiles || []
  const unstaged = info.unstagedFiles || []
  const untracked = info.untrackedFiles || []
  const total = staged.length + unstaged.length + untracked.length

  return (
    <div style={{
      background: 'var(--surface2)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 10,
      fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8,
      }}>
        Files in this onboarding commit ({total})
      </div>
      {total === 0 ? (
        <div style={{ color: 'var(--muted)' }}>
          Nothing to commit — workflow agents staged no files. Investigate before approving.
        </div>
      ) : (
        <div style={{ color: 'var(--text-dim)', maxHeight: 220, overflow: 'auto' }}>
          {[...staged, ...unstaged, ...untracked].map((f, i) => (
            <div key={i} style={{ padding: '2px 0' }}>{f}</div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 9, color: 'var(--muted)' }}>
        Approve runs <code style={{ color: 'var(--accent)' }}>git add -A &amp;&amp; git commit -m &quot;chore: onboard to build-studio via PRD-001&quot;</code>.
        No tag, no push.
      </div>
    </div>
  )
}

function OwnerConsultationContext({ wf }: { wf: Workflow }) {
  // Show the PM scoping feedback so the owner can read what they're consulting on
  // before adding their notes. Mirrors the OwnerSignoffContext pattern.
  const pmFeedback = wf.steps.pm_scoping?.agents?.find(a => a.feedback)?.feedback || ''
  return (
    <div style={{
      background: 'var(--surface2)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 10,
      fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8,
      }}>
        PM scoping output — read before adding consultation notes
      </div>
      {pmFeedback ? (
        <div className="md-rendered" style={{ color: 'var(--text-dim)', maxHeight: 320, overflow: 'auto', fontSize: 11 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{pmFeedback}</ReactMarkdown>
        </div>
      ) : (
        <div style={{ color: 'var(--muted)' }}>
          No PM feedback captured — read docs/project-state.md and docs/prds/PRD-001*.md directly.
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 9, color: 'var(--muted)' }}>
        Notes saved to <code style={{ color: 'var(--accent)' }}>docs/inputs/owner-consultation-round-N.md</code> and surfaced to team_review + pm_revision agents.
      </div>
    </div>
  )
}

function DemoReviewContext({ wf }: { wf: Workflow }) {
  // Extract AC coverage info from the ac_verification and qa_tests steps
  const acStep = wf.steps.ac_verification
  const qaStep = wf.steps.qa_tests
  const acFeedback = acStep?.agents?.find(a => a.feedback)?.feedback || ''
  const _qaFeedback = qaStep?.agents?.find(a => a.feedback)?.feedback || ''

  // Parse the AC verification matrix from feedback
  // Handles both old format (4 cols) and new format (5 cols with Test Type)
  // Identifier accepts AC-N (example-web-style flat numbering), US-N.M, or US-N.Mx
  // (example-site-style per-user-story numbering with optional sub-letters like US-2.11a).
  // Agents are instructed to mirror the PRD's own scheme verbatim.
  const acIdRe = '((?:AC|US)-[\\w.]+)'
  const acLines: { ac: string; desc: string; status: string; testType: string; evidence: string }[] = []
  for (const line of acFeedback.split('\n')) {
    // New format: | AC-1 | desc | STATUS | TEST_TYPE | evidence |
    const m5 = line.match(new RegExp(`\\|\\s*${acIdRe}\\s*\\|\\s*(.*?)\\s*\\|\\s*(MET|MOCK-ONLY|PARTIAL|UNMET|AT-RISK|UNTESTABLE)\\s*\\|\\s*(AUTOMATED|MOCK|MANUAL|[^|]*?)\\s*\\|\\s*(.*?)\\s*\\|`))
    if (m5) { acLines.push({ ac: m5[1], desc: m5[2], status: m5[3], testType: m5[4].trim(), evidence: m5[5] }); continue }
    // Old format: | AC-1 | desc | STATUS | evidence |
    const m4 = line.match(new RegExp(`\\|\\s*${acIdRe}\\s*\\|\\s*(.*?)\\s*\\|\\s*(MET|MOCK-ONLY|PARTIAL|UNMET|AT-RISK|UNTESTABLE)\\s*\\|\\s*(.*?)\\s*\\|`))
    if (m4) acLines.push({ ac: m4[1], desc: m4[2], status: m4[3], testType: '', evidence: m4[4] })
  }

  // Categorize ACs for the demo review display
  const mockOnlyACs = acLines.filter(ac => ac.status === 'MOCK-ONLY' || ac.status === 'AT-RISK' || (ac.testType === 'MOCK' && ac.status === 'MET'))
  const manualACs = acLines.filter(ac => ac.status === 'UNTESTABLE' || ac.testType === 'MANUAL')
  const needsManualVerification = [...mockOnlyACs, ...manualACs]
  const metACs = acLines.filter(ac => ac.status === 'MET' && ac.testType !== 'MOCK')
  const hasACData = acLines.length > 0

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Where to test */}
      {wf.reviewBranch && (
        <div style={{
          background: 'var(--surface2)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 10,
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8 }}>
            Where to test
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)', marginBottom: 4 }}>
            Branch: <strong>{wf.reviewBranch}</strong>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
            Worktree: <code style={{ color: 'var(--accent)', background: 'var(--surface3)', padding: '1px 5px', borderRadius: 3 }}>tmp/.worktrees/{wf.reviewBranch.replace('/', '-')}</code>
          </div>
        </div>
      )}

      {/* AC coverage summary */}
      {hasACData ? (
        <div style={{
          background: 'var(--surface2)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 10,
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 10 }}>
            Acceptance Criteria — {metACs.length}/{acLines.length} verified by integration tests
            {needsManualVerification.length > 0 && <span style={{ color: 'var(--orange)' }}> · {needsManualVerification.length} need your verification</span>}
          </div>

          {/* AT-RISK: mock-only coverage for LLM/API flows */}
          {mockOnlyACs.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--orange)', marginBottom: 6 }}>
                ⚠ Mock-only coverage — real integration unverified ({mockOnlyACs.length}):
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
                These ACs pass with mocked external service responses. Verify manually that the real feature works with actual APIs.
              </div>
              {mockOnlyACs.map(ac => (
                <div key={ac.ac} style={{
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <span style={{ color: 'var(--orange)', fontWeight: 600, flexShrink: 0 }}>{ac.ac}</span>
                  <span style={{ color: 'var(--text-dim)', flex: 1 }}>{ac.desc}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 9, flexShrink: 0 }}>{ac.testType || 'MOCK'}</span>
                </div>
              ))}
            </div>
          )}

          {/* MANUAL/UNTESTABLE: needs human verification */}
          {manualACs.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--orange)', marginBottom: 6 }}>
                ⚠ Requires manual verification ({manualACs.length}):
              </div>
              {manualACs.map(ac => (
                <div key={ac.ac} style={{
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <span style={{ color: 'var(--orange)', fontWeight: 600, flexShrink: 0 }}>{ac.ac}</span>
                  <span style={{ color: 'var(--text-dim)', flex: 1 }}>{ac.desc}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 9, flexShrink: 0 }}>{ac.evidence}</span>
                </div>
              ))}
            </div>
          )}

          {/* ACs covered by tests */}
          {metACs.length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--green)', marginBottom: 6 }}>
                ✓ Covered by automated tests ({metACs.length}):
              </div>
              {metACs.map(ac => (
                <div key={ac.ac} style={{
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 0',
                  color: 'var(--muted)',
                }}>
                  <span style={{ fontWeight: 600, flexShrink: 0 }}>{ac.ac}</span>
                  <span style={{ flex: 1 }}>{ac.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          background: 'var(--surface2)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 10,
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8 }}>
            Manual Testing Checklist
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 6px' }}>No AC verification matrix available. Verify manually:</p>
            <p style={{ margin: '0 0 4px', color: 'var(--orange)' }}>• Read the PRD acceptance criteria and test each one against the running app</p>
            <p style={{ margin: '0 0 4px', color: 'var(--orange)' }}>• E2E tests use mocks — verify the real API/LLM integration works end-to-end</p>
            <p style={{ margin: 0, color: 'var(--orange)' }}>• Test the full user flow: configure → generate → publish → verify published result</p>
          </div>
        </div>
      )}

      {/* Reminder about mocks */}
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
        background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)',
        borderRadius: 'var(--radius)', padding: '8px 12px', marginBottom: 10,
      }}>
        <strong style={{ color: 'var(--accent)' }}>Note:</strong> E2E tests use mocked API responses — they verify UI flows but not real LLM output, actual data persistence, or third-party integrations. Test these manually.
      </div>
    </div>
  )
}

function ActionArea({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginTop: 8 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>{label}</div>
      {children}
    </div>
  )
}

function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 32 }}>{icon}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text-dim)' }}>{text}</div>
    </div>
  )
}

// --- Feedback verdict detection ---

type Verdict = 'approved' | 'changes' | 'blocking' | 'working' | 'error'

// Parse the structured comment counts a reviewer reports
// ("**Blocking:** 0  |  **Medium:** 0  |  **Low:** 1"). Returns null when the
// agent has no feedback or no structured counts (e.g. qa_tests / fix steps).
function parseCommentCounts(feedback?: string): { blocking: number; medium: number; low: number } | null {
  if (!feedback) return null
  const b = feedback.match(/\*\*Blocking:\*\*\s*(\d+)/i)
  const m = feedback.match(/\*\*Medium:\*\*\s*(\d+)/i)
  const l = feedback.match(/\*\*Low:\*\*\s*(\d+)/i)
  if (!b && !m && !l) return null
  return { blocking: b ? parseInt(b[1]) : 0, medium: m ? parseInt(m[1]) : 0, low: l ? parseInt(l[1]) : 0 }
}

function detectVerdict(agent: WorkflowAgent): Verdict {
  if (agent.status === 'error') return 'error'
  if (agent.status === 'running' || agent.status === 'pending') return 'working'
  if (!agent.feedback) return 'working'

  const fb = agent.feedback

  // 1. Parse structured format: **Approved:** yes/no (strongest signal)
  const approvedMatch = fb.match(/\*\*Approved:\*\*\s*(yes|no)/i)
  if (approvedMatch) {
    if (approvedMatch[1].toLowerCase() === 'yes') return 'approved'
    const blockingMatch = fb.match(/\*\*Blocking:\*\*\s*(\d+)/i)
    const failuresMatch = fb.match(/\*\*Failures:\*\*\s*(\d+)/i)
    const blockingCount = blockingMatch ? parseInt(blockingMatch[1]) : 0
    const failureCount = failuresMatch ? parseInt(failuresMatch[1]) : 0
    return (blockingCount > 0 || failureCount > 0) ? 'blocking' : 'changes'
  }

  // 2. Parse fix report format: **All issues addressed:** yes/no
  const fixMatch = fb.match(/\*\*All issues addressed:\*\*\s*(yes|no)/i)
  if (fixMatch) {
    return fixMatch[1].toLowerCase() === 'yes' ? 'approved' : 'changes'
  }

  // 2b. Parse **Verdict:** format (common variant)
  const verdictMatch = fb.match(/\*\*Verdict:\*\*\s*(.*)/i)
  if (verdictMatch) {
    const verdict = verdictMatch[1].toLowerCase()
    if (/approve/i.test(verdict)) return 'approved'
    if (/changes requested|blocking/i.test(verdict)) return 'blocking'
    if (/non-blocking/i.test(verdict)) return 'changes'
  }

  // 3. Fallback for free-text feedback (transition period)
  // Check for blocking headings at any level (##, ###)
  const hasBlockingSection = /^#{2,3}\s*Blocking\b/m.test(fb)

  // Check for APPROVE/LGTM
  if (/\bAPPROVE\b/i.test(fb) || /\bLGTM\b/i.test(fb)) {
    return hasBlockingSection ? 'blocking' : 'approved'
  }

  // No APPROVE found — check for blocking section
  if (hasBlockingSection) return 'blocking'

  // Check for "CHANGES REQUESTED" anywhere
  if (/changes requested/i.test(fb)) return 'blocking'

  if (agent.status === 'done') return 'approved'
  return 'working'
}

function extractSummary(feedback: string): string {
  // 1. Try to extract the ### Summary section from structured format
  const summaryMatch = feedback.match(/### Summary\n([\s\S]*?)(?=\n###|\n##|$)/)
  if (summaryMatch) {
    const summary = summaryMatch[1].trim().split('\n')[0].trim()
    if (summary) {
      const cleaned = summary.replace(/\*\*/g, '').replace(/\*/g, '')
      return cleaned.length > 140 ? cleaned.slice(0, 137) + '...' : cleaned
    }
  }

  // 2. Fallback: take the first meaningful line
  const lines = feedback.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('**'))
  if (lines.length === 0) return ''

  let summary = lines[0]
  summary = summary.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^[-•]\s*/, '')
  if (summary.length > 120) summary = summary.slice(0, 117) + '...'
  return summary
}

const VERDICT_CONFIG: Record<Verdict, { label: string; icon: string; color: string; borderColor: string; bgColor: string }> = {
  approved: { label: 'Approved', icon: '✓', color: 'var(--green)', borderColor: 'rgba(61,220,132,0.3)', bgColor: 'rgba(61,220,132,0.06)' },
  changes:  { label: 'Changes requested', icon: '↻', color: 'var(--orange)', borderColor: 'rgba(249,115,22,0.3)', bgColor: 'rgba(249,115,22,0.06)' },
  blocking: { label: 'Blocking issues', icon: '✗', color: 'var(--red)', borderColor: 'rgba(255,95,95,0.3)', bgColor: 'rgba(255,95,95,0.06)' },
  working:  { label: 'Working...', icon: '◌', color: 'var(--yellow)', borderColor: 'rgba(245,197,24,0.2)', bgColor: 'transparent' },
  error:    { label: 'Error', icon: '!', color: 'var(--red)', borderColor: 'rgba(255,95,95,0.3)', bgColor: 'rgba(255,95,95,0.06)' },
}

function OverseerCard({ overseer, onDismiss, onNudgeAgent }: { overseer: OverseerState; onDismiss: () => void; onNudgeAgent: (window: string) => void }) {
  const [historyOpen, setHistoryOpen] = useState(false)

  const STATUS_CONFIG = {
    watching:   { icon: '👁', label: 'Watching',   color: 'var(--text-dim)',   border: 'rgba(120,120,140,0.25)', bg: 'rgba(120,120,140,0.05)' },
    acting:     { icon: '⚙️', label: 'Acting',    color: 'var(--yellow)',     border: 'rgba(255,200,60,0.3)',  bg: 'rgba(255,200,60,0.06)' },
    escalating: { icon: '⚠️', label: 'Needs attention', color: 'var(--red)', border: 'rgba(255,95,95,0.4)',   bg: 'rgba(255,95,95,0.08)' },
    idle:       { icon: '○',  label: 'Idle',       color: 'var(--text-dim)',   border: 'rgba(120,120,140,0.25)', bg: 'rgba(120,120,140,0.05)' },
  } as const

  const sc = STATUS_CONFIG[overseer.status] ?? STATUS_CONFIG.watching

  return (
    <div style={{
      border: `1px solid ${sc.border}`,
      borderRadius: 8,
      background: sc.bg,
      padding: '12px 14px',
      marginBottom: 12,
      fontSize: 12,
      fontFamily: 'var(--mono)',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: overseer.pendingEscalation || overseer.interventions.length > 0 ? 10 : 0 }}>
        <span style={{ fontSize: 14 }}>{sc.icon}</span>
        <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Overseer</span>
        <span style={{ background: 'rgba(120,120,140,0.15)', borderRadius: 4, padding: '1px 6px', color: sc.color, fontSize: 10, fontWeight: 500 }}>
          {sc.label}
        </span>
        <span style={{ flex: 1, color: 'var(--text-dim)', fontSize: 11 }}>{overseer.activity}</span>
        {overseer.interventions.length > 0 && (
          <button
            onClick={() => setHistoryOpen(o => !o)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 10, padding: '2px 6px' }}
          >
            {historyOpen ? '▲' : '▼'} {overseer.interventions.length} action{overseer.interventions.length !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {/* Pending escalation banner */}
      {overseer.pendingEscalation && (
        <div style={{
          background: 'rgba(255,95,95,0.08)',
          border: '1px solid rgba(255,95,95,0.3)',
          borderRadius: 6,
          padding: '8px 10px',
          marginTop: 6,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}>
          <span style={{ flex: 1, color: 'var(--text)', lineHeight: 1.5 }}>
            {overseer.pendingEscalation.description}
          </span>
          {overseer.pendingEscalation.action === 'nudge-agent' && overseer.pendingEscalation.actionTarget && (
            <button
              onClick={() => onNudgeAgent(overseer.pendingEscalation!.actionTarget!)}
              style={{
                background: 'rgba(95,180,255,0.15)',
                border: '1px solid rgba(95,180,255,0.4)',
                borderRadius: 4,
                color: 'var(--accent)',
                cursor: 'pointer',
                fontSize: 10,
                padding: '3px 8px',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--mono)',
                fontWeight: 700,
              }}
            >
              ↻ Nudge
            </button>
          )}
          <button
            onClick={onDismiss}
            style={{
              background: 'rgba(255,95,95,0.15)',
              border: '1px solid rgba(255,95,95,0.35)',
              borderRadius: 4,
              color: 'var(--red)',
              cursor: 'pointer',
              fontSize: 10,
              padding: '3px 8px',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--mono)',
            }}
          >
            Acknowledged
          </button>
        </div>
      )}

      {/* Intervention history */}
      {historyOpen && overseer.interventions.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid rgba(120,120,140,0.2)', paddingTop: 8 }}>
          {[...overseer.interventions].reverse().map((iv, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, color: 'var(--text-dim)', fontSize: 10 }}>
              <span style={{ whiteSpace: 'nowrap' }}>{new Date(iv.at).toLocaleTimeString()}</span>
              <span style={{ color: 'var(--text)' }}>{iv.symptom}</span>
              <span>→ {iv.action}</span>
              <span style={{ flex: 1, color: 'var(--text-dim)' }}>{iv.result}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentFeedbackCard({ agent, taskLabel, onViewLog, onMarkDone, onRelaunchTask }: { agent: WorkflowAgent; taskLabel?: string; onViewLog: (w: string) => void; onMarkDone: (role: string) => void; onRelaunchTask?: (taskIndex: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const verdict = detectVerdict(agent)
  const vc = VERDICT_CONFIG[verdict]
  const summary = agent.feedback ? extractSummary(agent.feedback) : ''
  const hasFullFeedback = agent.feedback && agent.feedback.split('\n').length > 1

  return (
    <div style={{
      background: 'var(--surface2)',
      border: `1px solid ${vc.borderColor}`,
      borderLeft: `3px solid ${vc.color}`,
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* Header — always visible */}
      <div
        onClick={() => hasFullFeedback && setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          cursor: hasFullFeedback ? 'pointer' : 'default',
          background: vc.bgColor,
        }}
      >
        {/* Role */}
        {avatarSrc(agent.role, 88)
          ? <img src={avatarSrc(agent.role, 88)!} alt={agent.role} style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 6 }} />
          : <span style={{ fontSize: 16, flexShrink: 0 }}>{roleConfig(agent.role).avatar}</span>}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)', minWidth: 80 }}>
          {agent.role}
        </span>

        {/* Model badge — show the ACTUAL model/CLI. A codex reviewer must read
            "Codex", not "Sonnet" (the old `opus ? 'Opus' : 'Sonnet'` collapsed every
            non-opus model — including codex — to "Sonnet", hiding the reviewer flip). */}
        {agent.model && (() => {
          const m = String(agent.model).toLowerCase()
          const isCodex = m.startsWith('codex')
          const isOpus = m.startsWith('opus')
          const isHaiku = m.startsWith('haiku')
          const label = isCodex ? 'Codex' : isOpus ? 'Opus' : isHaiku ? 'Haiku' : 'Sonnet'
          const color = isCodex ? 'var(--green, #10a37f)' : isOpus ? 'var(--purple, #a78bfa)' : 'var(--text-dim)'
          const background = isCodex ? 'rgba(16,163,127,0.12)' : isOpus ? 'rgba(167,139,250,0.1)' : 'var(--surface3)'
          return (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
              color, background,
              padding: '2px 6px', borderRadius: 4, flexShrink: 0, letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              {label}
            </span>
          )
        })()}

        {/* Token usage badge */}
        {agent.tokenUsage && (() => {
          const total = agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens
          const display = total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : total >= 1000 ? `${Math.round(total / 1000)}k` : String(total)
          const isHeavy = total >= 100_000
          return (
            <span
              title={`Input: ${agent.tokenUsage.inputTokens.toLocaleString()} · Output: ${agent.tokenUsage.outputTokens.toLocaleString()} · Cache read: ${agent.tokenUsage.cacheRead.toLocaleString()} · API-equiv: $${agent.tokenUsage.costUSD.toFixed(3)}`}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600,
                color: isHeavy ? 'var(--yellow, #fbbf24)' : 'var(--text-dim)',
                background: isHeavy ? 'rgba(251,191,36,0.1)' : 'var(--surface3)',
                padding: '2px 6px', borderRadius: 4, flexShrink: 0, letterSpacing: '0.04em',
              }}
            >
              {display} tok
            </span>
          )
        })()}

        {/* Task label */}
        {taskLabel && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
            background: 'var(--surface3)', padding: '2px 7px', borderRadius: 4,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            maxWidth: 200, flexShrink: 1,
          }}>
            {taskLabel}
          </span>
        )}

        {/* Verdict badge */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          color: vc.color, background: `${vc.color}15`,
          padding: '2px 8px', borderRadius: 10,
          letterSpacing: '0.03em',
        }}>
          <span style={{ fontSize: 11 }}>{vc.icon}</span>
          {vc.label}
        </span>

        {/* Summary */}
        {summary && !expanded && (
          <span style={{
            flex: 1, fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--text-dim)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>
            {summary}
          </span>
        )}

        <span style={{ flex: expanded ? 1 : 0 }} />

        {/* Actions */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {(agent.status === 'error' || agent.logError) && onRelaunchTask && agent.taskIndex !== undefined && (
            <button
              onClick={(e) => { e.stopPropagation(); onRelaunchTask(agent.taskIndex!) }}
              style={{
                padding: '2px 8px', borderRadius: 4,
                border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.1)',
                color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, cursor: 'pointer',
              }}
            >
              ↺ Relaunch
            </button>
          )}
          {agent.status === 'running' && (
            <button
              onClick={(e) => { e.stopPropagation(); onMarkDone(agent.role) }}
              style={{
                padding: '2px 8px', borderRadius: 4,
                border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.08)',
                color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, cursor: 'pointer',
              }}
            >
              ✗ Cancel
            </button>
          )}
          {agent.window && (
            <button
              onClick={(e) => { e.stopPropagation(); onViewLog(agent.window!) }}
              style={{
                padding: '2px 8px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'none',
                color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer',
              }}
            >
              Log
            </button>
          )}
          {hasFullFeedback && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              {expanded ? '▲' : '▼'}
            </span>
          )}
        </span>
      </div>

      {/* Expanded feedback */}
      {expanded && agent.feedback && (
        <div style={{
          padding: '0 14px 12px',
          borderTop: '1px solid var(--border)',
          marginTop: 0,
        }}>
          <pre style={{
            fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6,
            color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            margin: '10px 0 0', padding: 0, background: 'none', border: 'none',
          }}>
            {agent.feedback}
          </pre>
        </div>
      )}

      {/* Error */}
      {agent.error && (
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
        }}>
          {agent.error}
        </div>
      )}
    </div>
  )
}
