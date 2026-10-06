'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { roleConfig, avatarSrc } from '@/lib/roles'

interface CommitEntry {
  hash: string
  subject: string
  author: string
  date: string
}

interface DeployTarget {
  id: string
  kind: 'github-workflow' | 'local-command' | string
  label: string
  description?: string
  canDeploy: boolean
}

interface DeploymentInfo {
  latestTag: string | null
  tagMessage: string | null
  nextVersion: string | null
  deployCommits: CommitEntry[]
  ahead: number
  behind: number
  hasRemote: boolean
  compareRef?: string | null
  remoteFetchedAt?: string | null
  remoteFetchError?: string | null
  canRebase?: boolean
  branch?: string | null
  detachedHead?: boolean
  autoTag: boolean
  versioning: string
  canDeploy?: boolean
  canShowCiStatus?: boolean
  canInvestigateCi?: boolean
  ciFixStrategy?: 'push' | 'pr' | string
  targets?: DeployTarget[]
  stagedFiles?: string[]
  unstagedFiles?: string[]
  untrackedFiles?: string[]
}

interface CiJob {
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

interface CiRun {
  id: number
  status: string
  conclusion: string | null
  title: string
  event: string
  createdAt: string
  updatedAt: string
}

interface CiStatus {
  run: CiRun | null
  jobs: CiJob[]
}

interface CiProposal {
  rootCause: string
  summary: string
  fixable: boolean | null
  filesChanged: string[]
  diff: string
  untracked: string[]
  hasChanges: boolean
}

/** GET /deployment/local-ci — see project-server lib/local-ci.js. */
interface LocalCiStep { label: string; status: 'pending' | 'running' | 'passed' | 'failed'; seconds: number | null }
interface LocalCi {
  configured: boolean
  cmd?: string
  verdict?: {
    state: 'idle' | 'starting' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted'
    failedStep?: string | null
    beforeStatus?: boolean
    exitCode?: number | null
  }
  badge?: { tone: 'ok' | 'neutral' | 'warn'; label: string }
  status?: {
    state: string; full: boolean; commit: string; dirty: boolean
    startedAt: string; finishedAt: string | null
    current: { index: number; total: number; label: string } | null
    steps: LocalCiStep[]
  } | null
  elapsedMs?: number | null
  logTail?: string
  canCancel?: boolean
}

type InvestigatePhase =
  | { phase: 'idle' }
  | { phase: 'running'; runId: string }
  | { phase: 'proposal'; proposal: CiProposal }
  | { phase: 'accepting' }
  | { phase: 'accepted'; message: string }
  | { phase: 'error'; message: string }

export function CicdTab() {
  const api = useProjectApi()
  const [info, setInfo] = useState<DeploymentInfo | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [rebasing, setRebasing] = useState(false)
  const [rebaseResult, setRebaseResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [deployingId, setDeployingId] = useState<string | null>(null)
  const [deployResults, setDeployResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [showCommitInput, setShowCommitInput] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [ciStatus, setCiStatus] = useState<CiStatus | null>(null)
  const ciPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Local CI (deployment.local_ci). Polled every 5 s while a run is in
  // progress and every 30 s otherwise: a run takes 45–85 minutes and is read
  // back from the server on every load, so a reload never loses it.
  const [localCi, setLocalCi] = useState<LocalCi | null>(null)
  const [localCiBusy, setLocalCiBusy] = useState(false)
  const [localCiError, setLocalCiError] = useState<string | null>(null)
  const loadLocalCi = useCallback(() => {
    api.get('/deployment/local-ci').then((d: LocalCi) => setLocalCi(d)).catch(() => {})
  }, [api])
  const localCiActive = localCi?.verdict?.state === 'running' || localCi?.verdict?.state === 'starting'
  useEffect(() => {
    loadLocalCi()
    const id = setInterval(loadLocalCi, localCiActive ? 5000 : 30000)
    return () => clearInterval(id)
  }, [loadLocalCi, localCiActive])
  const localCiAction = async (action: 'start' | 'cancel') => {
    setLocalCiBusy(true)
    setLocalCiError(null)
    try {
      const d = await api.post(`/deployment/local-ci/${action}`, {})
      if (d && d.error) setLocalCiError(d.error)
      else if (d) setLocalCi(d)
    } catch (e) {
      setLocalCiError(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalCiBusy(false)
    }
  }

  // CI-fix investigation
  const [investigate, setInvestigate] = useState<InvestigatePhase>({ phase: 'idle' })
  const [autofix, setAutofix] = useState(false)
  const investigatePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoFiredRunRef = useRef<number | null>(null) // dedupe auto-investigate per failing run

  const load = useCallback(() => {
    api.get('/deployment').then((data: DeploymentInfo) => {
      if (data.latestTag !== undefined) setInfo(data)
    }).catch(() => {})
  }, [api])

  const loadCiStatus = useCallback(() => {
    api.get('/deployment/ci-status').then((data: CiStatus) => {
      setCiStatus(data)
      // Stop polling when completed
      if (data.run && data.run.status === 'completed' && ciPollRef.current) {
        clearInterval(ciPollRef.current)
        ciPollRef.current = null
      }
    }).catch(() => {})
  }, [api])

  useEffect(() => {
    load()
    const interval = setInterval(load, 10000)
    return () => clearInterval(interval)
  }, [load])

  // Clean up CI polling on unmount
  useEffect(() => {
    return () => {
      if (ciPollRef.current) clearInterval(ciPollRef.current)
    }
  }, [])

  const startCiPolling = useCallback(() => {
    if (ciPollRef.current) clearInterval(ciPollRef.current)
    loadCiStatus()
    ciPollRef.current = setInterval(loadCiStatus, 5000)
  }, [loadCiStatus])

  // Always-on CI health: load once + poll lightly so the badge stays current
  // without the user clicking anything (this is what replaces the email-check).
  useEffect(() => {
    loadCiStatus()
    const id = setInterval(loadCiStatus, 20000)
    return () => clearInterval(id)
  }, [loadCiStatus])

  // Load the auto-investigate toggle
  useEffect(() => {
    api.get('/deployment/ci-autofix')
      .then((d: { enabled?: boolean }) => setAutofix(d.enabled === true))
      .catch(() => {})
  }, [api])

  // Clean up investigation polling on unmount
  useEffect(() => () => {
    if (investigatePollRef.current) clearInterval(investigatePollRef.current)
  }, [])

  const stopInvestigatePolling = useCallback(() => {
    if (investigatePollRef.current) { clearInterval(investigatePollRef.current); investigatePollRef.current = null }
  }, [])

  const startInvestigatePolling = useCallback((runId: string) => {
    stopInvestigatePolling()
    const poll = async () => {
      try {
        const data = await api.get(`/deployment/ci-investigate/${encodeURIComponent(runId)}/status`)
        if (data.state === 'running' || data.state === 'submitting') return
        stopInvestigatePolling()
        if (data.state === 'complete' && data.proposal) {
          setInvestigate({ phase: 'proposal', proposal: data.proposal })
        } else {
          setInvestigate({ phase: 'error', message: data.error || 'Investigation failed.' })
        }
      } catch {
        stopInvestigatePolling()
        setInvestigate({ phase: 'error', message: 'Status check failed.' })
      }
    }
    investigatePollRef.current = setInterval(poll, 3000)
    poll()
  }, [api, stopInvestigatePolling])

  // Rediscover an investigation this tab did not start — or started before it
  // was unmounted. The runId used to live only in this component's state, so
  // navigating away discarded the only handle to a run that was still going:
  // the agent finished, wrote its proposal, and nothing could ever surface it.
  // The server records the run, and a completed proposal survives on disk, so
  // coming back to the tab picks up where it left off.
  useEffect(() => {
    let cancelled = false
    api.get('/deployment/ci-investigate/active').then((d: {
      active?: { runId: string; state: string; proposal?: CiProposal; error?: string } | null
    }) => {
      if (cancelled || !d.active) return
      const a = d.active
      if (a.state === 'running') {
        setInvestigate({ phase: 'running', runId: a.runId })
        startInvestigatePolling(a.runId)
      } else if (a.state === 'complete' && a.proposal) {
        setInvestigate({ phase: 'proposal', proposal: a.proposal })
      } else if (a.state === 'lost') {
        // Started, but the run is gone and left no proposal — almost always a
        // server restart. Say that, rather than spinning on a run that will
        // never report.
        setInvestigate({
          phase: 'error',
          message: 'The previous investigation did not survive a restart, and left no proposal. Start it again.',
        })
      } else if (a.error) {
        setInvestigate({ phase: 'error', message: a.error })
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [api, startInvestigatePolling])

  const handleInvestigate = useCallback(async (runId?: number) => {
    setInvestigate({ phase: 'running', runId: '' })
    const data = await api.post('/deployment/ci-investigate', runId ? { runId } : {})
    if (data.runId) {
      setInvestigate({ phase: 'running', runId: data.runId })
      startInvestigatePolling(data.runId)
    } else {
      setInvestigate({ phase: 'error', message: data.error || 'Could not start investigation.' })
    }
  }, [api, startInvestigatePolling])

  const handleAcceptFix = useCallback(async (summary: string) => {
    setInvestigate({ phase: 'accepting' })
    const data = await api.post('/deployment/ci-fix-accept', { summary })
    if (data.ok) {
      const msg = data.mode === 'pr'
        ? (data.prUrl ? `PR opened: ${data.prUrl}` : `Pushed fix branch ${data.branch}`)
        : `Pushed ${data.hash} — CI re-running`
      setInvestigate({ phase: 'accepted', message: msg })
      load()
      loadCiStatus()
    } else {
      setInvestigate({ phase: 'error', message: data.error || 'Accept failed.' })
    }
  }, [api, load, loadCiStatus])

  const handleDismissFix = useCallback(async () => {
    await api.post('/deployment/ci-fix-dismiss')
    setInvestigate({ phase: 'idle' })
    load()
  }, [api, load])

  const handleToggleAutofix = useCallback(async () => {
    const next = !autofix
    setAutofix(next)
    try { await api.post('/deployment/ci-autofix', { enabled: next }) }
    catch { setAutofix(!next) }
  }, [api, autofix])

  // Auto-investigate: when enabled and a fresh failure appears, fire once per failing run.
  useEffect(() => {
    if (!autofix) return
    const run = ciStatus?.run
    if (!run || run.status !== 'completed' || run.conclusion !== 'failure') return
    if (autoFiredRunRef.current === run.id) return
    if (investigate.phase !== 'idle') return
    autoFiredRunRef.current = run.id
    handleInvestigate(run.id)
  }, [autofix, ciStatus, investigate.phase, handleInvestigate])

  const handleCommitAll = async () => {
    const msg = commitMessage.trim()
    if (!msg) {
      setCommitResult({ ok: false, message: 'Commit message required' })
      return
    }
    setCommitting(true)
    setCommitResult(null)
    try {
      const result = await api.post('/deployment/commit-all', { message: msg })
      if (result.ok) {
        setCommitResult({ ok: true, message: `Committed ${result.hash}` })
        setCommitMessage('')
        setShowCommitInput(false)
        load()
      } else {
        setCommitResult({ ok: false, message: result.error || 'Commit failed' })
      }
    } catch (e) {
      setCommitResult({ ok: false, message: 'Commit failed' })
    }
    setCommitting(false)
  }

  const handlePush = async () => {
    setPushing(true)
    setPushResult(null)
    try {
      const result = await api.post('/deployment/push')
      if (result.ok) {
        setPushResult({ ok: true, message: result.results?.join(', ') || 'Pushed successfully' })
        load()
      } else {
        setPushResult({ ok: false, message: result.error || 'Push failed' })
      }
    } catch (e) {
      setPushResult({ ok: false, message: 'Push failed' })
    }
    setPushing(false)
  }

  const handleRebase = async () => {
    setRebasing(true)
    setRebaseResult(null)
    setPushResult(null) // a stale "non-fast-forward" from the push that sent you here
    try {
      const result = await api.post('/deployment/rebase')
      if (result.ok) {
        // stashConflicts means the rebase landed but the working tree needs you —
        // reporting that as a plain success is how someone pushes a broken tree.
        const clean = !result.stashConflicts?.length
        setRebaseResult({ ok: clean, message: result.message || 'Rebased' })
      } else {
        const files = result.conflicts?.length ? ` (${result.conflicts.join(', ')})` : ''
        setRebaseResult({ ok: false, message: `${result.error || 'Rebase failed'}${files}` })
      }
      load()
    } catch {
      setRebaseResult({ ok: false, message: 'Rebase failed' })
    }
    setRebasing(false)
  }

  const handleDeploy = async (target: DeployTarget) => {
    setDeployingId(target.id)
    setDeployResults(prev => { const next = { ...prev }; delete next[target.id]; return next })
    try {
      const result = await api.post('/deployment/deploy', { targetId: target.id })
      if (result.ok) {
        setDeployResults(prev => ({ ...prev, [target.id]: { ok: true, message: result.message || 'Triggered' } }))
        // Only a github-workflow deploy produces a CI run to poll.
        if (target.kind === 'github-workflow') setTimeout(startCiPolling, 3000)
      } else {
        setDeployResults(prev => ({ ...prev, [target.id]: { ok: false, message: result.error || 'Deploy failed' } }))
      }
    } catch (e) {
      setDeployResults(prev => ({ ...prev, [target.id]: { ok: false, message: 'Deploy trigger failed' } }))
    }
    setDeployingId(null)
  }

  if (!info) {
    return (
      <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
        Loading...
      </div>
    )
  }

  const devOpsCfg = roleConfig('DevOps')
  const devOpsAvatar = avatarSrc('DevOps', 88)
  // A detached HEAD has no branch to push, and pushing was producing git's
  // "invalid refspec ''" rather than saying so.
  const canPush = info.hasRemote && info.deployCommits.length > 0 && !info.detachedHead
  // Strictly the server's verdict, and deliberately not inferred from `behind`.
  // A project-server still running an older bundle sends neither `canRebase` nor
  // `compareRef` and has no /deployment/rebase route — inferring the button into
  // existence there would render "Rebase onto undefined" and 404 on click. No
  // button at all is the honest rendering of "this server cannot do that yet".
  const canRebase = info.canRebase === true && Boolean(info.compareRef)
  const workingTreeCount =
    (info.stagedFiles?.length || 0) +
    (info.unstagedFiles?.length || 0) +
    (info.untrackedFiles?.length || 0)
  const canCommit = workingTreeCount > 0

  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Section header */}
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--text-dim)',
      }}>
        CI / CD
      </div>

      {/* DevOps agent card + deploy controls */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        width: '100%',
      }}>
        {/* wrap: on a narrow pane the controls drop below the info column
            instead of squeezing it to nothing. */}
        <div style={{
          padding: '12px 16px', display: 'flex', alignItems: 'flex-start',
          gap: 12, flexWrap: 'wrap',
        }}>
          {/* Avatar */}
          {devOpsAvatar
            ? <img src={devOpsAvatar} alt="DevOps" style={{ width: 88, height: 88, flexShrink: 0, borderRadius: 8 }} />
            : <span style={{ fontSize: 22, lineHeight: '28px', flexShrink: 0 }}>{devOpsCfg.avatar}</span>}

          {/* Info */}
          <div style={{ flex: '1 1 260px', minWidth: 240 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                DevOps
              </span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: 'var(--muted)', opacity: 0.8,
              }}>
                deployment
              </span>
            </div>

            {/* Version info */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>
              <span>current: <span style={{ color: 'var(--text-dim)' }}>{info.latestTag || 'no tags'}{info.tagMessage ? ` — ${info.tagMessage}` : ''}</span></span>
              {info.nextVersion && (
                <span>next: <span style={{ color: 'var(--green)' }}>{info.nextVersion}</span></span>
              )}
              <span>versioning: <span style={{ color: 'var(--text-dim)' }}>{info.versioning}</span></span>
            </div>

            {/* A detached HEAD is not an error, but every push-shaped action is
                unavailable until it is resolved, and a commit made while
                detached belongs to no branch — so the warning leads with the
                work at risk rather than with the disabled button. */}
            {info.detachedHead && (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--orange)',
                border: '1px solid var(--orange)', borderRadius: 4,
                padding: '5px 8px', marginBottom: 6, lineHeight: 1.5,
              }}>
                HEAD is detached — no branch to push or rebase. Check out a branch
                (<code>git checkout main</code>) to re-enable them. If you have committed
                while detached, save it first with <code>git branch &lt;name&gt; HEAD</code> —
                those commits belong to no branch and become unreachable once you switch.
              </div>
            )}

            {/* Remote status */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              {info.hasRemote ? (
                <>
                  <span>ahead: <span style={{ color: info.ahead > 0 ? 'var(--orange)' : 'var(--text-dim)' }}>{info.ahead}</span></span>
                  {/* The tooltip is not decoration: this number is only as true
                      as the last fetch, and "behind: 0" is otherwise impossible
                      to tell apart from "nobody has looked since yesterday". */}
                  <span title={
                    info.remoteFetchError ? `Could not reach origin: ${info.remoteFetchError}`
                      : info.remoteFetchedAt ? `origin last checked ${new Date(info.remoteFetchedAt).toLocaleTimeString()}`
                      : 'origin not checked yet'
                  }>
                    behind: <span style={{ color: info.behind > 0 ? 'var(--red)' : 'var(--text-dim)' }}>{info.behind}</span>
                    {info.remoteFetchError && <span style={{ color: 'var(--orange)' }}> ?</span>}
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--red)' }}>no remote configured</span>
              )}
            </div>
          </div>

          {/* Commit + Push + Deploy buttons */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
            gap: 6, minWidth: 0, marginLeft: 'auto',
          }}>
            <button
              onClick={() => {
                setCommitResult(null)
                setShowCommitInput(v => !v)
              }}
              disabled={!canCommit || committing}
              title={canCommit ? `Stage and commit all ${workingTreeCount} working-tree change${workingTreeCount === 1 ? '' : 's'}` : 'Working tree is clean'}
              style={{
                padding: '6px 16px', borderRadius: 6,
                border: '1px solid var(--border)',
                background: canCommit && !committing ? 'var(--surface2)' : 'var(--surface2)',
                color: canCommit && !committing ? 'var(--text)' : 'var(--muted)',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                cursor: canCommit && !committing ? 'pointer' : 'default',
                opacity: committing ? 0.6 : 1,
                transition: 'all 0.15s',
              }}
            >
              {committing ? 'Committing...' : `Commit all changes${canCommit ? ` (${workingTreeCount})` : ''}`}
            </button>
            {commitResult && !showCommitInput && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: commitResult.ok ? 'var(--green)' : 'var(--red)',
                maxWidth: 260, textAlign: 'right',
              }}>
                {commitResult.message}
              </span>
            )}
            {/* Rebase sits ABOVE Push and only appears when there is something
                to rebase onto. It is the step that unblocks the push below it,
                and it shows up in the same moment the push would be rejected —
                so the order on screen matches the order you do them in. */}
            {canRebase && (
              <button
                onClick={handleRebase}
                disabled={rebasing}
                title={`Replay your local commits on top of ${info.compareRef} (${info.behind} commit${info.behind === 1 ? '' : 's'} behind). Uncommitted changes are stashed and restored.`}
                style={{
                  padding: '6px 16px', borderRadius: 6,
                  border: '1px solid var(--orange)',
                  background: 'transparent',
                  color: 'var(--orange)',
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                  cursor: rebasing ? 'default' : 'pointer',
                  opacity: rebasing ? 0.6 : 1,
                  transition: 'all 0.15s',
                }}
              >
                {rebasing ? 'Rebasing...' : `Rebase onto ${info.compareRef} (${info.behind})`}
              </button>
            )}
            {rebaseResult && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: rebaseResult.ok ? 'var(--green)' : 'var(--red)',
                maxWidth: 260, textAlign: 'right',
              }}>
                {rebaseResult.message}
              </span>
            )}
            {/* Local CI sits above Push for the same reason Rebase does: it is
                the step you take before pushing. It never gates Push. */}
            {localCi?.configured && (
              localCi.canCancel ? (
                <button
                  onClick={() => { void localCiAction('cancel') }}
                  disabled={localCiBusy}
                  title="Stop the local CI run (SIGTERM to the process group Build Studio started)."
                  style={{
                    padding: '6px 16px', borderRadius: 6, border: '1px solid var(--red)',
                    background: 'transparent', color: 'var(--red)',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    cursor: localCiBusy ? 'default' : 'pointer', opacity: localCiBusy ? 0.6 : 1,
                  }}
                >
                  {localCiBusy ? 'Cancelling…' : 'Cancel local CI'}
                </button>
              ) : (
                <button
                  onClick={() => { void localCiAction('start') }}
                  disabled={localCiBusy || localCiActive}
                  title={`Run CI on this machine before pushing: ${localCi.cmd || ''}. Takes 45–85 minutes and keeps running if you leave this tab.`}
                  style={{
                    padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--surface2)', color: localCiActive ? 'var(--muted)' : 'var(--text)',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    cursor: localCiBusy || localCiActive ? 'default' : 'pointer', opacity: localCiBusy ? 0.6 : 1,
                  }}
                >
                  {localCiBusy ? 'Starting…' : localCiActive ? 'Local CI running…' : 'Run CI locally'}
                </button>
              )
            )}
            {localCiError && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', maxWidth: 260, textAlign: 'right' }}>
                {localCiError}
              </span>
            )}
            <button
              onClick={handlePush}
              disabled={!canPush || pushing}
              style={{
                padding: '6px 16px', borderRadius: 6,
                border: 'none',
                background: canPush && !pushing ? 'var(--green)' : 'var(--surface2)',
                color: canPush && !pushing ? '#000' : 'var(--muted)',
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                cursor: canPush && !pushing ? 'pointer' : 'default',
                opacity: pushing ? 0.6 : 1,
                transition: 'all 0.15s',
              }}
            >
              {pushing ? 'Pushing...' : 'Push to GitHub'}
            </button>
            {pushResult && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: pushResult.ok ? 'var(--green)' : 'var(--red)',
                maxWidth: 260, textAlign: 'right',
              }}>
                {pushResult.message}
              </span>
            )}
            {/* Information only: whether the last local run still describes
                HEAD. Push stays enabled whatever it says. */}
            {localCi?.configured && localCi.badge && (
              <span
                title="Whether the last local CI run covered exactly this commit: a full run, a clean tree, and the current HEAD."
                style={{
                  fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 10,
                  border: `1px solid ${localCi.badge.tone === 'ok' ? 'var(--green)' : localCi.badge.tone === 'warn' ? 'var(--orange)' : 'var(--border)'}`,
                  color: localCi.badge.tone === 'ok' ? 'var(--green)' : localCi.badge.tone === 'warn' ? 'var(--orange)' : 'var(--muted)',
                  maxWidth: 300, textAlign: 'right',
                }}
              >
                {localCi.badge.label}
              </span>
            )}
            {/* Deploy targets (web GHA + iOS local fastlane etc.) — one per target,
                clearly labelled so it's unambiguous WHAT deploys. A target that
                auto-deploys on push shows its label + note instead of a button. */}
            {(info.targets || []).map((target) => {
              const busy = deployingId === target.id
              const result = deployResults[target.id]
              return (
                // Column, not row: a long target.label (e.g. "iOS → App Store
                // metadata (fastlane deliver)") beside its post-deploy result
                // message makes a very wide row, which used to clip against the
                // card and overlap the Commit/Push controls. Stack instead,
                // matching how Commit/Push's own result spans render below
                // their buttons. The label itself is width-bounded and wraps
                // (see maxWidth below), so it can no longer set the column's
                // width on its own.
                <div key={target.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  {target.canDeploy ? (
                    <button
                      onClick={() => handleDeploy(target)}
                      disabled={busy || deployingId !== null}
                      title={target.description || ''}
                      style={{
                        padding: '6px 16px', borderRadius: 6,
                        border: 'none',
                        background: !busy ? 'var(--accent)' : 'var(--surface2)',
                        color: !busy ? '#fff' : 'var(--muted)',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                        cursor: !busy && deployingId === null ? 'pointer' : 'default',
                        opacity: busy ? 0.6 : (deployingId !== null ? 0.5 : 1),
                        transition: 'all 0.15s',
                        maxWidth: 340, whiteSpace: 'normal', textAlign: 'right', lineHeight: 1.35,
                      }}
                    >
                      {busy ? 'Deploying…' : `Deploy: ${target.label}`}
                    </button>
                  ) : (
                    <span title={target.description || ''} style={{
                      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                      maxWidth: 340, textAlign: 'right', lineHeight: 1.4,
                    }}>
                      {target.label} — {target.description || 'auto on push'}
                    </span>
                  )}
                  {result && (
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11,
                      color: result.ok ? 'var(--green)' : 'var(--red)',
                      maxWidth: 320, textAlign: 'right',
                    }}>
                      {result.message}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {localCi?.configured && localCi.verdict && localCi.verdict.state !== 'idle' && (
          <LocalCiPanel ci={localCi} />
        )}

        {/* Inline commit-message input — full card width, appears on Commit click */}
        {showCommitInput && (
          <div style={{
            padding: '10px 16px 12px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--surface2)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)',
            }}>
              Commit message — staging {workingTreeCount} file{workingTreeCount === 1 ? '' : 's'} (`git add -A`)
            </div>
            <textarea
              autoFocus
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleCommitAll()
                } else if (e.key === 'Escape') {
                  setShowCommitInput(false)
                }
              }}
              placeholder="type(scope): short description"
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '6px 8px', borderRadius: 4,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                fontFamily: 'var(--mono)', fontSize: 11,
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              {commitResult && !commitResult.ok && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--red)', flex: 1 }}>
                  {commitResult.message}
                </span>
              )}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
                ⌘↵ to commit · esc to cancel
              </span>
              <button
                onClick={() => { setShowCommitInput(false); setCommitResult(null) }}
                disabled={committing}
                style={{
                  padding: '4px 10px', borderRadius: 4,
                  border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--muted)',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCommitAll}
                disabled={committing || !commitMessage.trim()}
                style={{
                  padding: '4px 12px', borderRadius: 4,
                  border: 'none',
                  background: committing || !commitMessage.trim() ? 'var(--surface2)' : 'var(--green)',
                  color: committing || !commitMessage.trim() ? 'var(--muted)' : '#000',
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                  cursor: committing || !commitMessage.trim() ? 'default' : 'pointer',
                }}
              >
                {committing ? 'Committing...' : 'Commit'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* CI Health — always-on status + failure investigation */}
      {info.canShowCiStatus && (
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.1em',
            color: 'var(--text-dim)', marginBottom: 10,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            CI Health
            {ciStatus?.run && (
              <>
                <StatusDot status={ciStatus.run.status} conclusion={ciStatus.run.conclusion} size={8} />
                <span style={{
                  fontWeight: 500, textTransform: 'none', fontSize: 10,
                  color: statusColor(ciStatus.run.status, ciStatus.run.conclusion),
                }}>
                  {ciStatus.run.status === 'completed' ? ciStatus.run.conclusion : ciStatus.run.status}
                </span>
                <span style={{ fontWeight: 500, textTransform: 'none', color: 'var(--muted)', fontSize: 9 }}>
                  {formatRelativeDate(ciStatus.run.updatedAt || ciStatus.run.createdAt)}
                </span>
              </>
            )}

            {/* Investigate (on failure) + auto-investigate toggle */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
              {info.canInvestigateCi
                && ciStatus?.run?.status === 'completed'
                && ciStatus.run.conclusion === 'failure'
                && investigate.phase === 'idle' && (
                <button
                  onClick={() => handleInvestigate(ciStatus.run!.id)}
                  style={{
                    padding: '4px 12px', borderRadius: 4, border: 'none',
                    background: 'var(--accent)', color: '#fff',
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Investigate failure
                </button>
              )}
              {info.canInvestigateCi && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                  title="When a run fails, automatically fire the investigation agent (one proposal per failing run; nothing is committed until you accept).">
                  <input type="checkbox" checked={autofix} onChange={handleToggleAutofix}
                    style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 12, height: 12 }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 500, textTransform: 'none', color: 'var(--muted)' }}>
                    Auto-investigate
                  </span>
                </label>
              )}
            </div>
          </div>

          {!ciStatus?.run ? (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              padding: '12px 16px', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 8,
            }}>
              No recent workflow runs found.
            </div>
          ) : (
            <div style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, overflow: 'hidden',
            }}>
              {/* Run header */}
              <div style={{
                padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12,
                borderBottom: ciStatus.jobs.length > 0 ? '1px solid var(--border)' : undefined,
                fontFamily: 'var(--mono)', fontSize: 11,
              }}>
                <StatusDot status={ciStatus.run.status} conclusion={ciStatus.run.conclusion} />
                <span style={{ color: 'var(--text)', flex: 1 }}>{ciStatus.run.title}</span>
                <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                  {ciStatus.run.event === 'workflow_dispatch' ? 'manual' : ciStatus.run.event}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                  {formatRelativeDate(ciStatus.run.createdAt)}
                </span>
              </div>

              {/* Jobs */}
              {ciStatus.jobs.map((job, i) => (
                <div
                  key={job.name}
                  style={{
                    padding: '8px 16px 8px 36px', display: 'flex', alignItems: 'center', gap: 10,
                    borderTop: i > 0 ? '1px solid var(--border-subtle)' : undefined,
                    fontFamily: 'var(--mono)', fontSize: 10,
                  }}
                >
                  <StatusDot status={job.status} conclusion={job.conclusion} size={8} />
                  <span style={{ color: 'var(--text-dim)', flex: 1 }}>{job.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                    {job.status === 'completed' ? job.conclusion : job.status}
                  </span>
                  {job.completedAt && job.startedAt && (
                    <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                      {formatDuration(job.startedAt, job.completedAt)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Investigation panel */}
          {investigate.phase !== 'idle' && (
            <InvestigationPanel
              state={investigate}
              strategy={info.ciFixStrategy}
              onAccept={handleAcceptFix}
              onDismiss={handleDismissFix}
              onReset={() => setInvestigate({ phase: 'idle' })}
            />
          )}
        </div>
      )}

      {/* Changelog delta */}
      <div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.1em',
          color: 'var(--text-dim)', marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          Changelog
          <span style={{ fontWeight: 500, textTransform: 'none', color: 'var(--muted)', fontSize: 9 }}>
            {info.deployCommits.length} commit{info.deployCommits.length !== 1 ? 's' : ''} to deploy
          </span>
        </div>

        {info.deployCommits.length === 0 ? (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
            padding: '12px 16px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}>
            No new commits. Up to date.
          </div>
        ) : (
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            {info.deployCommits.map((commit, i) => (
              <div
                key={commit.hash}
                style={{
                  padding: '8px 16px',
                  display: 'flex', alignItems: 'baseline', gap: 10,
                  borderTop: i > 0 ? '1px solid var(--border-subtle)' : undefined,
                  fontFamily: 'var(--mono)', fontSize: 11,
                }}
              >
                <span style={{ color: 'var(--accent)', flexShrink: 0, fontSize: 10 }}>
                  {commit.hash}
                </span>
                <span style={{ color: 'var(--text)', flex: 1, minWidth: 0 }}>
                  {commit.subject}
                </span>
                <span style={{ color: 'var(--muted)', flexShrink: 0, fontSize: 9 }}>
                  {formatRelativeDate(commit.date)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Working tree — staged / modified / untracked file lists */}
      <WorkingTree
        staged={info.stagedFiles || []}
        unstaged={info.unstagedFiles || []}
        untracked={info.untrackedFiles || []}
      />
    </div>
  )
}

const ciBtnPrimary: React.CSSProperties = {
  padding: '5px 14px', borderRadius: 4, border: 'none', background: 'var(--green)', color: '#000',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
}
const ciBtnGhost: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
}

function fmtSecs(total: number | null | undefined): string {
  if (total == null) return ''
  const s = Math.round(total)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Progress and result of the local CI run, full card width. */
function LocalCiPanel({ ci }: { ci: LocalCi }) {
  const v = ci.verdict!
  const st = ci.status
  const [showLog, setShowLog] = useState(false)
  const color = v.state === 'passed' ? 'var(--green)'
    : v.state === 'failed' || v.state === 'interrupted' ? 'var(--red)'
    : v.state === 'cancelled' ? 'var(--muted)' : 'var(--accent)'
  const headline = {
    starting: 'Starting…',
    running: st?.current ? `Step ${st.current.index} of ${st.current.total} — ${st.current.label}` : 'Running',
    passed: `Passed${st && !st.full ? ' (partial run)' : ''}${st?.dirty ? ' — on a dirty tree' : ''}`,
    failed: v.failedStep ? `Failed at ${v.failedStep}`
      : v.beforeStatus ? `Failed before the runner started${v.exitCode != null ? ` (exit ${v.exitCode})` : ''}` : 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted — the run stopped without finishing (Build Studio or the machine went down). Run it again.',
    idle: '',
  }[v.state]
  const logOpen = showLog || v.state === 'failed'
  const icon = (s: LocalCiStep['status']) => s === 'passed' ? '✔' : s === 'failed' ? '✖' : s === 'running' ? '▶' : '·'
  const iconColor = (s: LocalCiStep['status']) => s === 'passed' ? 'var(--green)' : s === 'failed' ? 'var(--red)' : s === 'running' ? 'var(--accent)' : 'var(--muted)'
  return (
    <div style={{
      padding: '10px 16px 12px', borderTop: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'var(--mono)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)' }}>
          Local CI
        </span>
        <span style={{ fontSize: 11, color }}>{headline}</span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          {ci.elapsedMs != null ? fmtSecs(ci.elapsedMs / 1000) : ''}
          {st?.commit ? ` · ${st.commit.slice(0, 7)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {ci.logTail && v.state !== 'failed' && (
          <button onClick={() => setShowLog(x => !x)} className="wf-btn secondary" style={{ fontSize: 10, padding: '2px 8px' }}>
            {showLog ? 'Hide log' : 'Show log'}
          </button>
        )}
      </div>
      {st && st.steps && st.steps.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '2px 16px' }}>
          {st.steps.map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 10, color: step.status === 'pending' ? 'var(--muted)' : 'var(--text-dim)', minWidth: 0 }}>
              <span style={{ color: iconColor(step.status), width: 10, flexShrink: 0 }}>{icon(step.status)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={step.label}>{step.label}</span>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{fmtSecs(step.seconds)}</span>
            </div>
          ))}
        </div>
      )}
      {logOpen && ci.logTail && (
        <pre style={{
          margin: 0, maxHeight: 260, overflow: 'auto', padding: '8px 10px', borderRadius: 4,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          fontSize: 10, lineHeight: 1.45, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{ci.logTail}</pre>
      )}
    </div>
  )
}

function CiField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', lineHeight: 1.5 }}>{value}</div>
    </div>
  )
}

function InvestigationPanel({
  state, strategy, onAccept, onDismiss, onReset,
}: {
  state: InvestigatePhase
  strategy?: string
  onAccept: (summary: string) => void
  onDismiss: () => void
  onReset: () => void
}) {
  const card: React.CSSProperties = {
    marginTop: 12, background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '14px 16px',
  }
  if (state.phase === 'running') {
    return <div style={card}><span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)' }}>⟳ Investigating the failure — the DevOps agent is reading the logs and preparing a fix…</span></div>
  }
  if (state.phase === 'accepting') {
    return <div style={card}><span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)' }}>⟳ Applying the fix…</span></div>
  }
  if (state.phase === 'accepted') {
    return (
      <div style={card}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)', marginBottom: 10, wordBreak: 'break-all' }}>✓ {state.message}</div>
        <button onClick={onReset} style={ciBtnGhost}>Done</button>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div style={card}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', marginBottom: 10 }}>✕ {state.message}</div>
        <button onClick={onReset} style={ciBtnGhost}>Dismiss</button>
      </div>
    )
  }

  if (state.phase !== 'proposal') return null

  // proposal
  const p = state.proposal
  const willText = strategy === 'pr' ? 'open a pull request' : 'commit + push to main (re-runs CI)'
  return (
    <div style={card}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: 10 }}>
        Fix proposal
      </div>
      {p.rootCause && <CiField label="Root cause" value={p.rootCause} />}
      {p.summary && <CiField label="Proposed fix" value={p.summary} />}
      {p.fixable === false && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--orange)', marginBottom: 8 }}>
          The agent judged this isn't a code fix (likely environmental) — review the root cause.
        </div>
      )}
      {p.filesChanged && p.filesChanged.length > 0 && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 8 }}>
          Files: {p.filesChanged.join(', ')}
        </div>
      )}
      {p.diff ? (
        <pre style={{
          maxHeight: 280, overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--border-subtle)',
          borderRadius: 6, padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.5,
          color: 'var(--text-dim)', whiteSpace: 'pre', margin: '0 0 4px',
        }}>{p.diff}</pre>
      ) : (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 8 }}>
          {p.hasChanges ? '(new files added — see Files above)' : 'No working-tree changes were made.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        {p.hasChanges ? (
          <>
            <button onClick={() => onAccept(p.summary)} style={ciBtnPrimary} title={`Accept will ${willText}`}>
              Accept — {strategy === 'pr' ? 'open PR' : 'commit & push'}
            </button>
            <button onClick={onDismiss} style={ciBtnGhost}>Dismiss</button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>Accept will {willText}.</span>
          </>
        ) : (
          <button onClick={onDismiss} style={ciBtnGhost}>Close</button>
        )}
      </div>
    </div>
  )
}

function WorkingTree({ staged, unstaged, untracked }: { staged: string[]; unstaged: string[]; untracked: string[] }) {
  const total = staged.length + unstaged.length + untracked.length

  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--text-dim)', marginBottom: 10,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        Working Tree
        <span style={{ fontWeight: 500, textTransform: 'none', color: 'var(--muted)', fontSize: 9 }}>
          {total === 0
            ? 'clean'
            : `${staged.length} staged · ${unstaged.length} modified · ${untracked.length} untracked`}
        </span>
      </div>

      {total === 0 ? (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
          padding: '12px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}>
          No uncommitted changes.
        </div>
      ) : (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}>
          <FileGroup label="Staged"     color="var(--green)"  files={staged} />
          <FileGroup label="Modified"   color="var(--orange)" files={unstaged} borderTop={staged.length > 0} />
          <FileGroup label="Untracked"  color="var(--muted)"  files={untracked} borderTop={staged.length + unstaged.length > 0} />
        </div>
      )}
    </div>
  )
}

function FileGroup({ label, color, files, borderTop }: { label: string; color: string; files: string[]; borderTop?: boolean }) {
  if (files.length === 0) return null
  return (
    <div style={{ borderTop: borderTop ? '1px solid var(--border-subtle)' : undefined }}>
      <div style={{
        padding: '8px 16px',
        fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.08em', color,
        background: 'var(--surface2)',
      }}>
        {label} ({files.length})
      </div>
      {files.map((f, i) => (
        <div key={`${label}-${f}-${i}`} style={{
          padding: '5px 16px',
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text)',
          borderTop: i > 0 ? '1px solid var(--border-subtle)' : undefined,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {f}
        </div>
      ))}
    </div>
  )
}

function StatusDot({ status, conclusion, size = 10 }: { status: string; conclusion: string | null; size?: number }) {
  const color = statusColor(status, conclusion)
  const isActive = status !== 'completed'
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: color, flexShrink: 0,
      boxShadow: isActive ? `0 0 6px ${color}` : undefined,
    }} />
  )
}

function statusColor(status: string, conclusion: string | null): string {
  if (status === 'completed') {
    if (conclusion === 'success') return 'var(--green)'
    if (conclusion === 'failure') return 'var(--red)'
    if (conclusion === 'cancelled') return 'var(--muted)'
    return 'var(--muted)'
  }
  if (status === 'in_progress') return 'var(--orange)'
  if (status === 'queued' || status === 'waiting') return 'var(--muted)'
  return 'var(--muted)'
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return `${min}m ${remSec}s`
}

function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
