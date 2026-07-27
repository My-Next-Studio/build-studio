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

type SlotKey = 'default' | 'developer' | 'reviewer'
const ROWS: {
  slot: SlotKey
  label: string
  hint: string
  cliKey: 'default' | 'developer_cli' | 'reviewer_cli'
  modelKey: 'default_model' | 'developer_model' | 'reviewer_model'
  effortKey: 'default_effort' | 'developer_effort' | 'reviewer_effort'
}[] = [
  { slot: 'default', label: 'Default', hint: 'every role not covered by the Developer/Reviewer slots', cliKey: 'default', modelKey: 'default_model', effortKey: 'default_effort' },
  { slot: 'developer', label: 'Developer', hint: 'implementation agents (task_execution, fix_execution)', cliKey: 'developer_cli', modelKey: 'developer_model', effortKey: 'developer_effort' },
  { slot: 'reviewer', label: 'Reviewer', hint: 'Code Reviewer, Security + Final Reviewer, in every workflow type', cliKey: 'reviewer_cli', modelKey: 'reviewer_model', effortKey: 'reviewer_effort' },
]

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

// Placeholder for a Developer/Reviewer model slot left unset: it now inherits
// default_model, but only when that model fits the row's CLI (opencode ids are
// provider-scoped and always contain '/', claude/codex slugs never do — the
// same test resolveModelForRole applies). Returns null when nothing is
// inherited, so the caller falls back to "<CLI> default".
function inheritedLabel(slot: SlotKey, defaultModel: string | null, rowCli: Cli): string | null {
  if (slot === 'default' || !defaultModel) return null
  const fits = rowCli === 'opencode' ? defaultModel.includes('/') : !defaultModel.includes('/')
  return fits ? `↳ ${defaultModel}` : null
}

export function CliRoleSelectors({ value, catalog, onChange, disabled = false }: {
  value: CliBlock
  catalog: CliCatalog | null
  onChange: (patch: Partial<CliBlock>) => void
  disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {ROWS.map(row => {
        // Developer/Reviewer inherit the Default CLI when their own slot is
        // unset, so the row DISPLAYS a CLI it hasn't been assigned — which is
        // why moving Default looks like it silently moved them too. Track that
        // state so an inherited pick renders as an outline rather than as a
        // solid (explicitly-chosen) one, and stays re-clickable to opt out.
        const ownCli = value[row.cliKey] as Cli | null
        const inherits = row.slot !== 'default' && !ownCli
        const rowCli: Cli = ownCli || value.default
        const model = value[row.modelKey]
        const effort = value[row.effortKey]
        const modelOptions = catalog ? catalog[rowCli].models : []
        const effortOptions = catalog ? effortOptionsFor(rowCli, model, catalog) : []
        return (
          <div key={row.slot} style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap',
            minWidth: 0,
          }}>
            <div style={{ width: 140, flexShrink: 0 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text)' }}>{row.label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>{row.hint}</div>
            </div>
            {/* 1. CLI for this role slot */}
            <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              {CLIS.map(c => {
                const active = rowCli === c
                const viaDefault = active && inherits // showing Default's pick, not one set here
                return (
                  <button
                    key={c}
                    disabled={disabled}
                    onClick={() => onChange(
                      // Re-clicking an explicitly-set CLI on a Developer/Reviewer
                      // row clears it, handing the slot back to Default.
                      active && !inherits && row.slot !== 'default'
                        ? { [row.cliKey]: null, [row.modelKey]: null, [row.effortKey]: null } as Partial<CliBlock>
                        : { [row.cliKey]: c, [row.modelKey]: null, [row.effortKey]: null } as Partial<CliBlock>
                    )}
                    title={
                      viaDefault ? `${CLI_LABELS[c]} — inherited from Default. Click to pin it to this slot.`
                        : active && row.slot !== 'default' ? `${CLI_LABELS[c]} — set for this slot. Click again to inherit from Default.`
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
                onChange={v => onChange({ [row.modelKey]: v, [row.effortKey]: null } as Partial<CliBlock>)}
                placeholder={inheritedLabel(row.slot, value.default_model, rowCli)
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
                  onChange={v => onChange({ [row.effortKey]: v } as Partial<CliBlock>)}
                  placeholder={row.slot !== 'default' && value.default_effort ? `↳ ${value.default_effort}` : 'effort'}
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
