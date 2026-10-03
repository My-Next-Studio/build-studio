'use client'

import { useState } from 'react'
import { AgentTerminal } from './agent-terminal'

export interface InterviewSession {
  cli?: string
  window: string
  launchedAt?: string
  endedAt?: string
  cliSessionId?: string | null
}

interface Props {
  session: InterviewSession | null
  /** From GET /workflow: is the session's window up, and is the agent in it. */
  live: { live: boolean; agentRunning: boolean } | null
  disabled: boolean
  onAdvance: (action: string) => void
}

/**
 * The kickoff's owner_interview step: the PM interviews the owner in a live
 * terminal, embedded here so the owner answers in place.
 *
 * The step waits for the owner. Auto-advance never acts on it and nothing times
 * out, so an interview can span days: End session stops the agent and keeps the
 * conversation, and Resume picks it up again.
 */
export function OwnerInterviewCard({ session, live, disabled, onAdvance }: Props) {
  const [minimised, setMinimised] = useState(false)
  const running = !!live?.agentRunning
  const started = !!session
  const canResume = started && !running

  const btn = (label: string, action: string, primary = false, title?: string, confirmText?: string) => (
    <button
      onClick={() => {
        if (confirmText && !confirm(confirmText)) return
        onAdvance(action)
      }}
      disabled={disabled}
      className={`wf-btn ${primary ? 'primary' : 'secondary'}`}
      title={title}
    >
      {label}
    </button>
  )

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)', lineHeight: 1.5, marginBottom: 10 }}>
        The PM asks you about the decisions that shape the whole product: who it is for, pricing,
        platforms, what the first release must contain, hard constraints, how success is measured.
        Questions about a single story are written into that backlog item and asked when you draft it.
        &quot;Not decided yet&quot; is always a fine answer. Answers are recorded in the Key Decisions Log
        and <code>docs/inputs/owner-interview.md</code>, which the review and revision steps read.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {!started && btn('Start interview →', 'launch', true, 'Open an interactive PM session')}
        {canResume && btn('Resume interview', 'launch', true, 'Continue the same conversation')}
        {running && btn('End session', 'end_session', false, 'Stop the agent; the conversation is kept and can be resumed')}
        {started && btn('Finish interview →', 'approve', !running, 'Commit what the interview wrote and continue to the team review')}
        {btn('Skip interview', 'skip', false, 'Continue without an interview',
          'Skip the interview? The review will work from the PM\'s assumptions instead of your answers.')}
      </div>

      {started && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 10px', background: 'var(--surface)', borderBottom: minimised ? 'none' : '1px solid var(--border)',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
          }}>
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
              Interview {running ? '· live' : '· ended'}{session?.cli ? ` · ${session.cli}` : ''}
            </span>
            <button
              onClick={() => setMinimised(m => !m)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11 }}
            >
              {minimised ? 'maximise' : 'minimise'}
            </button>
          </div>
          {!minimised && (
            <div style={{ height: 420 }}>
              {/* Keyed on launchedAt: a resume replaces the pane, and a terminal
                  that only watches the window name would stay on the old one. */}
              <AgentTerminal key={`${session!.window}#${session!.launchedAt || ''}`} agentWindow={session!.window} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
