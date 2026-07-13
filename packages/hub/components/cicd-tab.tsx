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
  const [deployingId, setDeployingId] = useState<string | null>(null)
  const [deployResults, setDeployResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [showCommitInput, setShowCommitInput] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [ciStatus, setCiStatus] = useState<CiStatus | null>(null)
  const ciPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
  const canPush = info.hasRemote && info.deployCommits.length > 0
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
        maxWidth: 560,
      }}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {/* Avatar */}
          {devOpsAvatar
            ? <img src={devOpsAvatar} alt="DevOps" style={{ width: 88, height: 88, flexShrink: 0, borderRadius: 8 }} />
            : <span style={{ fontSize: 22, lineHeight: '28px', flexShrink: 0 }}>{devOpsCfg.avatar}</span>}

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
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

            {/* Remote status */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              {info.hasRemote ? (
                <>
                  <span>ahead: <span style={{ color: info.ahead > 0 ? 'var(--orange)' : 'var(--text-dim)' }}>{info.ahead}</span></span>
                  <span>behind: <span style={{ color: info.behind > 0 ? 'var(--red)' : 'var(--text-dim)' }}>{info.behind}</span></span>
                </>
              ) : (
                <span style={{ color: 'var(--red)' }}>no remote configured</span>
              )}
            </div>
          </div>

          {/* Commit + Push + Deploy buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
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
                fontFamily: 'var(--mono)', fontSize: 9,
                color: commitResult.ok ? 'var(--green)' : 'var(--red)',
                maxWidth: 180, textAlign: 'right',
              }}>
                {commitResult.message}
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
                fontFamily: 'var(--mono)', fontSize: 9,
                color: pushResult.ok ? 'var(--green)' : 'var(--red)',
                maxWidth: 180, textAlign: 'right',
              }}>
                {pushResult.message}
              </span>
            )}
            {/* Deploy targets (web GHA + iOS local fastlane etc.) — one per target,
                clearly labelled so it's unambiguous WHAT deploys. A target that
                auto-deploys on push shows its label + note instead of a button. */}
            {(info.targets || []).map((target) => {
              const busy = deployingId === target.id
              const result = deployResults[target.id]
              return (
                <div key={target.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                      }}
                    >
                      {busy ? 'Deploying…' : `Deploy: ${target.label}`}
                    </button>
                  ) : (
                    <span title={target.description || ''} style={{
                      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                    }}>
                      {target.label} — {target.description || 'auto on push'}
                    </span>
                  )}
                  {result && (
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 9,
                      color: result.ok ? 'var(--green)' : 'var(--red)',
                      maxWidth: 220, textAlign: 'right',
                    }}>
                      {result.message}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

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
