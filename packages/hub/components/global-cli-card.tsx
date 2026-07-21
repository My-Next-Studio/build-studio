'use client'

import { useEffect, useState } from 'react'
import { CliRoleSelectors } from './cli-role-selectors'
import type { CliCatalog } from './cli-role-selectors'
import type { CliBlock } from './cli-settings-card'

const EMPTY_BLOCK: CliBlock = {
  default: 'claude', developer_cli: null, reviewer_cli: null,
  default_model: null, developer_model: null, reviewer_model: null,
  default_effort: null, developer_effort: null, reviewer_effort: null,
}

// Global (installation-wide) agent-CLI defaults, edited on the hub's Model
// tab. Backed by ~/.build-studio/config.json → `cli` via /api/cli-defaults;
// applies to every project whose Agents tab has "Use default" checked.
export function GlobalCliCard() {
  const [cli, setCli] = useState<CliBlock | null>(null)
  const [catalog, setCatalog] = useState<CliCatalog | null>(null)
  const [catalogNote, setCatalogNote] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/cli-defaults').then(r => r.json())
      .then((d: { cli?: CliBlock | null }) => setCli(d.cli || EMPTY_BLOCK))
      .catch(() => setCli(EMPTY_BLOCK))
    fetch('/api/cli-catalog').then(r => r.json())
      .then((d: CliCatalog & { stale?: boolean }) => {
        setCatalog(d)
        if (d.stale) setCatalogNote('Using cached model catalog — refresh failed')
      })
      .catch(() => setCatalogNote('Could not load the model catalog'))
  }, [])

  const save = (patch: Partial<CliBlock>) => {
    setSaveState('saving')
    setError(null)
    fetch('/api/cli-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(r => r.json()).then((d: { cli?: CliBlock | null; error?: string }) => {
      if (d.error) {
        setSaveState('error')
        setError(d.error)
        return
      }
      if (d.cli !== undefined) setCli(d.cli || EMPTY_BLOCK)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1500)
    }).catch(() => setSaveState('error'))
  }

  if (!cli) return null

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)',
        }}>
          Global agent defaults
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
          {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved ✓' : saveState === 'error' ? (error || 'save failed') : 'applies to every project with “Use default” enabled — saves immediately'}
        </span>
      </div>

      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '16px 20px',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <CliRoleSelectors value={cli} catalog={catalog} onChange={save} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)' }}>
          {catalog
            ? `${catalog.opencode.models.length + catalog.codex.models.length + catalog.claude.models.length} models across the three CLIs${catalogNote ? ` — ${catalogNote}` : ''}`
            : (catalogNote || 'loading model catalog…')}
        </div>
      </div>
    </section>
  )
}
