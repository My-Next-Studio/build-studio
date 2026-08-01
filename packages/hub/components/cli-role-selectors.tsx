'use client'

import { SearchableSelect } from './searchable-select'
import { CLI_LABELS } from './cli-settings-card'
import type { Cli, CliBlock } from './cli-settings-card'

// The CLI → model → effort cascade, shared verbatim between the project
// Agents tab (CliSettingsCard) and the global Model tab (GlobalCliCard):
//   1. pick the row's CLI
//   2. model picker shows that CLI's models
//   3. effort picker shows that model's own effort variants
// Switching a row's CLI clears its model + effort (they're CLI-namespaced).
export interface CliCatalog {
  claude: { models: string[]; efforts: Record<string, string[]>; defaultEfforts: string[] }
  codex: { models: string[]; efforts: Record<string, string[]>; defaultEfforts: string[] }
  opencode: { models: string[]; efforts: Record<string, string[]> }
}

/** A configurable step group, as defined in config and served by the API. */
export interface StepGroup {
  key: string
  label: string
  hint: string
  steps: string[]
}

/**
 * Rows are derived from the server's step-group definition, not hardcoded.
 * The first row is always the block-level Default — the fallback a group
 * inherits when it sets nothing — followed by one row per group, in the order
 * config lists them.
 */
const DEFAULT_ROW = {
  key: '__default__',
  label: 'Default',
  hint: 'fallback for any group that sets nothing, and for steps in no group',
  steps: [] as string[],
}

const CLIS: Cli[] = ['claude', 'codex', 'opencode']

function effortOptionsFor(cli: Cli, model: string | null, catalog: CliCatalog): string[] {
  // Every CLI's effort set is now per-model (models.dev reasoning_options).
  // OpenCode has no sensible default, so its picker stays empty until a model
  // is chosen; Claude and Codex fall back to their documented ladder so the
  // control is still reachable when models.dev has no entry for the model.
  if (cli === 'opencode') {
    if (!model) return []
    return catalog.opencode.efforts[model] || []
  }
  const per = cli === 'codex' ? catalog.codex.efforts : catalog.claude.efforts
  if (model && per[model]?.length) return per[model]
  return cli === 'codex' ? catalog.codex.defaultEfforts : catalog.claude.defaultEfforts
}

// Placeholder for a group's model slot left unset: it inherits default_model,
// but only when that model fits the row's CLI (opencode ids are provider-scoped
// and always contain '/', claude/codex slugs never do — the same test
// resolveStepLaunchSettings applies). Returns null when nothing is inherited,
// so the caller falls back to "<CLI> default".
function inheritedLabel(isDefaultRow: boolean, defaultModel: string | null, rowCli: Cli): string | null {
  if (isDefaultRow || !defaultModel) return null
  const fits = rowCli === 'opencode' ? defaultModel.includes('/') : !defaultModel.includes('/')
  return fits ? `↳ ${defaultModel}` : null
}

export function CliRoleSelectors({ value, groups, catalog, onChange, disabled = false }: {
  value: CliBlock
  groups: StepGroup[]
  catalog: CliCatalog | null
  onChange: (patch: Partial<CliBlock>) => void
  disabled?: boolean
}) {
  const rows = [DEFAULT_ROW, ...groups]
  const slots = value.groups || {}

  /** Patch one group's slot, leaving the others untouched. */
  const patchGroup = (key: string, slot: { cli?: Cli | null; model?: string | null; effort?: string | null }) => {
    const current = slots[key] || { cli: null, model: null, effort: null }
    onChange({ groups: { ...slots, [key]: { ...current, ...slot } } } as Partial<CliBlock>)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map(row => {
        const isDefaultRow = row.key === DEFAULT_ROW.key
        const slot = isDefaultRow ? null : (slots[row.key] || { cli: null, model: null, effort: null })
        // A group inherits the Default CLI when its own slot is unset, so the
        // row DISPLAYS a CLI it has not been assigned — which is why moving
        // Default looks like it silently moved the groups too. Track that so an
        // inherited pick renders as an outline rather than a solid
        // (explicitly-chosen) one, and stays re-clickable to opt out.
        const ownCli = (isDefaultRow ? value.default : slot!.cli) as Cli | null
        const inherits = !isDefaultRow && !ownCli
        const rowCli: Cli = ownCli || value.default
        const model = isDefaultRow ? value.default_model : slot!.model
        const effort = isDefaultRow ? value.default_effort : slot!.effort
        const modelOptions = catalog ? catalog[rowCli].models : []
        const effortOptions = catalog ? effortOptionsFor(rowCli, model, catalog) : []
        const setCli = (c: Cli | null) => isDefaultRow
          ? onChange({ default: c || 'claude', default_model: null, default_effort: null } as Partial<CliBlock>)
          : patchGroup(row.key, { cli: c, model: null, effort: null })
        const setModel = (v: string | null) => isDefaultRow
          ? onChange({ default_model: v, default_effort: null } as Partial<CliBlock>)
          : patchGroup(row.key, { model: v, effort: null })
        const setEffort = (v: string | null) => isDefaultRow
          ? onChange({ default_effort: v } as Partial<CliBlock>)
          : patchGroup(row.key, { effort: v })
        return (
          <div key={row.key} style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap',
            minWidth: 0,
          }}>
            <div style={{ width: 140, flexShrink: 0 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text)' }}>{row.label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>{row.hint}</div>
            </div>
            {/* 1. CLI for this group */}
            <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              {CLIS.map(c => {
                const active = rowCli === c
                const viaDefault = active && inherits // showing Default's pick, not one set here
                return (
                  <button
                    key={c}
                    disabled={disabled}
                    onClick={() => setCli(
                      // Re-clicking an explicitly-set CLI on a group row clears
                      // it, handing the slot back to Default.
                      active && !inherits && !isDefaultRow ? null : c
                    )}
                    title={
                      viaDefault ? `${CLI_LABELS[c]} — inherited from Default. Click to pin it to this group.`
                        : active && !isDefaultRow ? `${CLI_LABELS[c]} — set for this group. Click again to inherit from Default.`
                          : CLI_LABELS[c]
                    }
                    style={{
                      fontFamily: 'var(--mono)', fontSize: 10,
                      padding: '4px 9px', borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
                      border: `1px ${viaDefault ? 'dashed' : 'solid'} ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active && !viaDefault ? 'var(--accent)' : 'transparent',
                      color: active ? (viaDefault ? 'var(--accent)' : '#0d0f14') : 'var(--text-dim)',
                      fontWeight: active && !viaDefault ? 700 : 400,
                    }}
                  >
                    {c === 'claude' ? 'Claude' : c === 'codex' ? 'Codex' : 'OC'}
                  </button>
                )
              })}
            </div>
            {/* 2. Model — fixed width, ellipsis on overflow (parent SearchableSelect) */}
            <div style={{ width: 240, flexShrink: 0, minWidth: 0 }}>
              <SearchableSelect
                value={model}
                options={modelOptions}
                onChange={v => setModel(v)}
                placeholder={inheritedLabel(isDefaultRow, value.default_model, rowCli)
                  || `${rowCli === 'claude' ? 'Claude' : rowCli === 'codex' ? 'Codex' : 'OC'} default`}
                allowClear
                disabled={disabled || !catalog}
              />
            </div>
            {/* 3. Effort — always reserved column; picker when the CLI has options */}
            <div style={{ width: 120, flexShrink: 0, minWidth: 0 }}>
              {effortOptions.length > 0 ? (
                <SearchableSelect
                  value={effort}
                  options={effortOptions}
                  onChange={v => setEffort(v)}
                  placeholder={!isDefaultRow && value.default_effort ? `↳ ${value.default_effort}` : 'effort'}
                  allowClear
                  disabled={disabled}
                />
              ) : model && rowCli === 'opencode' ? (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                  padding: '6px 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }} title="This OpenCode model has no effort variants">
                  no effort
                </div>
              ) : rowCli === 'opencode' ? (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                  padding: '6px 8px', opacity: 0.55,
                }} title="Pick a model to unlock effort variants">
                  pick model
                </div>
              ) : (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                  padding: '6px 8px', opacity: 0.5,
                }}>
                  —
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
