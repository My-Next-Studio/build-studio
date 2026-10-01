'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * A fix-plan task as the fix planner writes it. Older plans used `name` where
 * newer ones use `title`, and not every plan carries priority or acceptance.
 */
export interface FixPlanTask {
  id?: string | number
  title?: string
  name?: string
  priority?: string
  role?: string
  description?: string
  acceptance?: string
}

interface Props {
  tasks: FixPlanTask[]
  /** The review step whose findings these are (e.g. qa_validation). */
  sourceStep: string
  /** That step's last report, verbatim. */
  sourceReport?: string
  /** The fix agent's report for the round that addressed them. */
  fixReport?: string
}

/**
 * The findings left open at a fix-loop cap, shown before the owner decides to
 * accept them. Built from the fix plan rather than by parsing the review's
 * prose: the planner already turned each finding into a structured task, while
 * review reports come in too many formats to parse reliably. Each row expands
 * to the full task; the two raw reports sit below for anything the plan lost.
 *
 * "Open" means not re-verified: the cap fires after the fix round, so these
 * were worked on, but the review that raised them has not checked the result.
 */
export function OpenFindings({ tasks, sourceStep, sourceReport, fixReport }: Props) {
  if (!tasks.length && !sourceReport) return null
  const source = sourceStep.replace(/_/g, ' ')

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginBottom: 6,
      }}>
        Open findings · {tasks.length} from {source}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8, lineHeight: 1.5 }}>
        The last fix round worked on these, but {source} has not re-checked them. Accepting moves on without that check.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tasks.map((t, i) => <FindingRow key={String(t.id ?? i)} task={t} />)}
      </div>
      {fixReport && <RawReport label="Fix agent's report" text={fixReport} />}
      {sourceReport && <RawReport label={`Full ${source} report`} text={sourceReport} />}
    </div>
  )
}

function priorityColor(priority?: string) {
  const p = (priority || '').toLowerCase()
  if (p.startsWith('block') || p === 'high') return 'var(--red)'
  if (p.startsWith('med')) return 'var(--orange)'
  return 'var(--text-dim)'
}

function FindingRow({ task }: { task: FixPlanTask }) {
  const color = priorityColor(task.priority)
  return (
    <details style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${color}`,
      borderRadius: 6, padding: '6px 10px',
    }}>
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)' }}>
        {task.priority && (
          <span style={{
            fontSize: 9, fontWeight: 700, color, letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '1px 4px', border: `1px solid ${color}`, borderRadius: 3, flexShrink: 0,
          }}>
            {task.priority}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{task.title || task.name || String(task.id ?? '')}</span>
        {task.role && <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>{task.role}</span>}
      </summary>
      <div style={{
        marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap',
      }}>
        {task.description}
        {task.acceptance && (
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            <span style={{ fontWeight: 700 }}>Acceptance: </span>{task.acceptance}
          </div>
        )}
      </div>
    </details>
  )
}

function RawReport({ label, text }: { label: string; text: string }) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
        {label}
      </summary>
      <div className="md-rendered" style={{
        fontSize: 12, marginTop: 6, padding: '8px 12px', maxHeight: 400, overflowY: 'auto',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
      }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </details>
  )
}
