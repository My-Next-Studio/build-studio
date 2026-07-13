'use client'

/**
 * PRD-001 preview page — renders CommitRibbon + PathologyPanel + FindingsChecklist
 * with realistic mock data, no backend dependency. View at /preview while running
 * `cd packages/hub && npm run dev`.
 *
 * Delete this route before merging — it's a development aid, not part of the
 * shipped UI.
 */

import { useState } from 'react'
import { CommitRibbon, type RibbonCommit } from '@/components/commit-ribbon'
import { PathologyPanel, type PathologySignals } from '@/components/pathology-panel'
import { FindingsChecklist, type Finding } from '@/components/findings-checklist'
import { ProjectProvider } from '@/lib/project-context'

// Mock commits modeled on the actual b-sonnet monolithic run
const sampleCommits: RibbonCommit[] = [
  { sha: '1465c2adeadbeef00000001', shortSha: '1465c2a', subject: 'feat(prd-009): add EN+SE localisation strings for all 8 PRD-009 copy keys', type: 'feat',     isoDate: new Date(Date.now() - 6  * 60_000).toISOString(), additions: 38,  deletions: 0 },
  { sha: 'baccbeddeadbeef00000002', shortSha: 'baccbed', subject: 'feat(prd-009): day-view per-entry context menu + XCUITest coverage',             type: 'feat',     isoDate: new Date(Date.now() - 22 * 60_000).toISOString(), additions: 412, deletions: 18 },
  { sha: 'cf06d67deadbeef00000003', shortSha: 'cf06d67', subject: 'feat(prd-009): picker slot-entries list, edit-mode detail, and log wiring',      type: 'feat',     isoDate: new Date(Date.now() - 38 * 60_000).toISOString(), additions: 580, deletions: 92 },
  { sha: 'de79445deadbeef00000004', shortSha: 'de79445', subject: 'test(prd-009): un-skip EDIT-MODE-VM + SLOT-ENTRIES tests; fix MyApp.Unit ambig',  type: 'test',     isoDate: new Date(Date.now() - 51 * 60_000).toISOString(), additions: 96,  deletions: 14 },
  { sha: '1cf6902deadbeef00000005', shortSha: '1cf6902', subject: 'feat(prd-009): ViewModel layer — FoodDetailViewModel edit mode + slotEntries',   type: 'feat',     isoDate: new Date(Date.now() - 64 * 60_000).toISOString(), additions: 268, deletions: 22 },
  { sha: '6536ca0deadbeef00000006', shortSha: '6536ca0', subject: 'feat(prd-009): data layer — EditValues struct + replaceEntry (ADR-007 §3)',      type: 'feat',     isoDate: new Date(Date.now() - 76 * 60_000).toISOString(), additions: 142, deletions: 12 },
]

// Three demo scenarios for the pathology panel — toggle via the buttons at the top
const pathologyScenarios: Record<string, PathologySignals> = {
  Healthy: {
    minutesSinceLastCommit: 6,
    compactionDetected: false,
    building: true,
    secondsSincePaneActivity: 8,
    formatPostRetried: false,
  },
  Stale: {
    minutesSinceLastCommit: 38,
    compactionDetected: false,
    building: false,
    secondsSincePaneActivity: 12,
    formatPostRetried: false,
  },
  'Pathology firing': {
    minutesSinceLastCommit: 62,
    compactionDetected: true,
    building: false,
    secondsSincePaneActivity: 4,
    formatPostRetried: true,
  },
}

// Findings modeled on the actual b-codex medium-effort run 1 verdict
const sampleFindings: Finding[] = [
  { id: 'code_review-r1-blocking-1', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 21 broken — picker hard-delete Task removed; soft-deleted rows linger until next scenePhase sweep', status: 'done',        matchedBy: 'a1b2c3d', body: 'FoodPickerViewModel.deleteEntry only sets pendingEntryUndo + calls softDelete. Previous implementation started an independent Task that survived VM dealloc on picker close. Restore it.' },
  { id: 'code_review-r1-blocking-2', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 14 negative case regressed — ingredient-add picker no longer dismisses on commit',                                  status: 'done',        matchedBy: 'e4f5a6b', body: 'handleDetailCommit removed the if pickerViewModel?.isIngredientAddMode == true { pickerViewModel = nil } branch.' },
  { id: 'code_review-r1-blocking-3', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 2 missing — List switched to ScrollView+VStack; native .swipeActions is dead code',                                  status: 'in_progress',                              body: 'Custom DragGesture+ZStack replacement competes with vertical scrolling. Revert to List.' },
  { id: 'code_review-r1-blocking-4', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 1b — Multi-entry contextMenu both items just open the sheet (PRD says long-press goes directly)',                    status: 'pending' },
  { id: 'code_review-r1-blocking-5', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 22 — Action sheet identifier renamed to old name; sub-line copy diverges from PRD-009-copy.md',                      status: 'pending' },
  { id: 'code_review-r1-blocking-6', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 15 — 5s banner persistence Task removed',                                                                            status: 'pending' },
  { id: 'code_review-r1-blocking-7', severity: 'BLOCKING', source: 'code_review-r1', label: 'AC 9 — Missing UIAccessibility.post(.announcement) after VO-triggered delete',                                          status: 'pending' },
  { id: 'code_review-r1-blocking-8', severity: 'BLOCKING', source: 'code_review-r1', label: '~3,000 lines of PRD-009 QA test files deleted; replaced with one 101-line file (4 tests)',                              status: 'pending' },
  { id: 'code_review-r1-medium-6',   severity: 'MEDIUM',   source: 'code_review-r1', label: 'replaceEntry does not preserve carbohydrateG when values.carbsG is nil',                                                status: 'pending' },
  { id: 'code_review-r1-medium-7',   severity: 'MEDIUM',   source: 'code_review-r1', label: 'softDelete + restoreSoftDeleted missing explicit context.save()',                                                       status: 'pending' },
  { id: 'code_review-r1-medium-8',   severity: 'MEDIUM',   source: 'code_review-r1', label: 'UndoToast accessibilityIdentifier per-source missing',                                                                  status: 'pending' },
]

export default function PreviewPage() {
  const [scenario, setScenario] = useState<keyof typeof pathologyScenarios>('Stale')
  const [running, setRunning] = useState(true)
  const [taskExecComplete, setTaskExecComplete] = useState(false)
  const [findings, setFindings] = useState(sampleFindings)

  function toggleFinding(id: string, next: Finding['status']) {
    setFindings(prev => prev.map(f => f.id === id ? { ...f, status: next, matchedBy: next === 'manual_override' ? 'manual' : f.matchedBy } : f))
  }

  return (
    <ProjectProvider name="preview" port={4800}>
      <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', maxWidth: 1100, margin: '0 auto' }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.02em', marginBottom: 4 }}>PRD-001 UI preview</h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Mock-data renders of the new monolithic-mode components. No backend calls.
            Use the toggles below to flip between scenarios.
          </p>
        </header>

        <section style={{ marginBottom: 28, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 10 }}>Scenario controls</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.keys(pathologyScenarios).map(s => (
              <button key={s} onClick={() => setScenario(s as keyof typeof pathologyScenarios)} style={{
                padding: '4px 10px', borderRadius: 4,
                background: scenario === s ? 'var(--accent)' : 'transparent',
                color: scenario === s ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${scenario === s ? 'var(--accent)' : 'var(--border)'}`,
                fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
              }}>{s}</button>
            ))}
            <span style={{ flex: 1 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
              <input type="checkbox" checked={running} onChange={e => setRunning(e.target.checked)} />
              Agent running (pulsing dot)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
              <input type="checkbox" checked={taskExecComplete} onChange={e => { setTaskExecComplete(e.target.checked); setRunning(!e.target.checked) }} />
              task_execution complete
            </label>
          </div>
        </section>

        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 12, marginBottom: 12, color: 'var(--text-dim)' }}>1. Monolithic task_execution view (single agent)</h2>
          <div style={{ padding: '16px 20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
              {taskExecComplete ? 'Monolithic agent complete · 1h 26m' : 'Monolithic agent running · 1h 16m · 310k tok'}
            </div>
            <PathologyPanel signals={pathologyScenarios[scenario]} isRunning={running} />
            <CommitRibbon sinceISO={new Date(Date.now() - 90 * 60_000).toISOString()} isRunning={running} commitsOverride={sampleCommits} />
          </div>
        </section>

        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 12, marginBottom: 12, color: 'var(--text-dim)' }}>2. Fix_execution view — findings checklist</h2>
          <div style={{ padding: '16px 20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <FindingsChecklist findings={findings} onToggle={toggleFinding} />
          </div>
        </section>

        <footer style={{ fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          Components: <code>commit-ribbon.tsx</code>, <code>pathology-panel.tsx</code>, <code>findings-checklist.tsx</code>.
          Wiring lives in <code>workflow-view.tsx</code> (<code>MonolithicProgress</code> wrapper).
          Backend: new <code>GET /workflow/branch-commits</code> endpoint + <code>pathologySignals</code>+<code>findings</code> fields on <code>GET /workflow</code>.
        </footer>
      </div>
    </ProjectProvider>
  )
}
