'use client'

import { useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { CliRoleSelectors } from './cli-role-selectors'
import type { CliCatalog } from './cli-role-selectors'

export type Cli = 'claude' | 'codex' | 'opencode'

export interface CliBlock {
  default: Cli
  developer_cli: Cli | null
  reviewer_cli: Cli | null
  default_model: string | null
  developer_model: string | null
  reviewer_model: string | null
  default_effort: string | null
  developer_effort: string | null
  reviewer_effort: string | null
  use_global?: boolean
}

interface CliConfigResponse {
  cli: CliBlock
  use_global: boolean
  global_cli: CliBlock | null
  valid_clis: Cli[]
  enabled_clis: Cli[]
  detected_clis: Record<string, boolean>
}

const CLI_LABELS: Record<Cli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

export { CLI_LABELS }

// Project-wide agent-CLI settings (Agents tab): per-role CLI → model → effort
// cascade, or "Use default" to inherit the global defaults (Home → Model tab)
// read-only. Writes go to the project's .build-studio/local.json via PUT
// /api/config/cli — per-project, never global; hand-maintained config.yaml is
// never rewritten by the hub.
export function CliSettingsCard() {
  const api = useProjectApi()
  const [cfg, setCfg] = useState<CliConfigResponse | null>(null)
  const [catalog, setCatalog] = useState<CliCatalog | null>(null)
  const [catalogNote, setCatalogNote] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get('/config/cli').then((d: CliConfigResponse) => setCfg(d)).catch(() => {})
    // The catalog is machine-global (claude/codex/opencode model lists + effort
    // variants) — served by the hub, identical for every project.
    fetch('/api/cli-catalog').then(r => r.json())
      .then((d: CliCatalog & { stale?: boolean }) => {
        setCatalog(d)
        if (d.stale) setCatalogNote('Using cached model catalog — refresh failed')
      })
      .catch(() => setCatalogNote('Could not load the model catalog'))
  }, [api])

  const save = (patch: Partial<CliBlock>) => {
    setSaveState('saving')
    setError(null)
    api.put('/config/cli', patch).then((d: { cli?: CliBlock; use_global?: boolean; global_cli?: CliBlock | null; error?: string }) => {
      if (d.error) {
        setSaveState('error')
        setError(d.error)
        return
      }
      if (d.cli) setCfg(c => c ? {
        ...c,
        cli: d.cli!,
        use_global: d.use_global ?? c.use_global,
        global_cli: d.global_cli !== undefined ? d.global_cli : c.global_cli,
      } : c)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1500)
    }).catch(() => setSaveState('error'))
  }

  if (!cfg) return null

  const { cli, enabled_clis, detected_clis } = cfg
  const useGlobal = cfg.use_global === true
  const missingBins = enabled_clis.filter(c => detected_clis[c] === false)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '16px 20px',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)',
        }}>
          Agent CLIs — this project only
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
          {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved ✓' : saveState === 'error' ? (error || 'save failed') : 'changes save immediately'}
        </span>
        <label style={{
          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          fontFamily: 'var(--mono)', fontSize: 10, color: useGlobal ? 'var(--accent)' : 'var(--text-dim)',
        }}>
          <input
            type="checkbox"
            checked={useGlobal}
            onChange={e => save({ use_global: e.target.checked })}
            style={{ cursor: 'pointer' }}
          />
          Use default
        </label>
      </div>

      {useGlobal && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', lineHeight: 1.5 }}>
          {cfg.global_cli
            ? 'Inherited from the global defaults (Home → Model tab) — read-only here. Uncheck to set project-specific values.'
            : 'No global defaults set yet (Home → Model tab) — project values apply meanwhile.'}
        </div>
      )}

      <fieldset disabled={useGlobal} style={{ border: 'none', margin: 0, padding: 0, opacity: useGlobal ? 0.55 : 1 }}>
        <CliRoleSelectors value={cli} catalog={catalog} onChange={save} disabled={useGlobal} />
      </fieldset>

      {!useGlobal && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
          {catalog
            ? `${catalog.opencode.models.length + catalog.codex.models.length + catalog.claude.models.length} models across the three CLIs${catalogNote ? ` — ${catalogNote}` : ''}`
            : (catalogNote || 'loading model catalog…')}
          {' '}<RefreshCatalogLink onRefreshed={setCatalog} />
        </div>
      )}

      {missingBins.length > 0 && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--orange)',
          borderTop: '1px solid var(--border)', paddingTop: 10,
        }}>
          ⚠ enabled but binary not found: {missingBins.map(c => CLI_LABELS[c]).join(', ')} — workflow launches needing it will fail the pre-flight check.
        </div>
      )}
    </div>
  )
}

function RefreshCatalogLink({ onRefreshed }: { onRefreshed: (c: CliCatalog) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <span
      onClick={() => {
        if (busy) return
        setBusy(true)
        fetch('/api/cli-catalog?refresh=1').then(r => r.json())
          .then((d: CliCatalog) => { if (d.opencode) onRefreshed(d) })
          .catch(() => {})
          .finally(() => setBusy(false))
      }}
      style={{ color: 'var(--accent)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
    >
      {busy ? 'refreshing…' : 'refresh'}
    </span>
  )
}
