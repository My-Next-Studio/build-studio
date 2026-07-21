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
  claude: { models: string[]; efforts: string[] }
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
  { slot: 'developer', label: 'Developer', hint: 'implementation agents (task_execution, fix_execution) — falls back to Default when unset', cliKey: 'developer_cli', modelKey: 'developer_model', effortKey: 'developer_effort' },
  { slot: 'reviewer', label: 'Reviewer', hint: 'Code Reviewer + Security (execution runs) — falls back to Default when unset', cliKey: 'reviewer_cli', modelKey: 'reviewer_model', effortKey: 'reviewer_effort' },
]

const CLIS: Cli[] = ['claude', 'codex', 'opencode']

function effortOptionsFor(cli: Cli, model: string | null, catalog: CliCatalog): string[] {
  // Claude/Codex expose a static (or default) effort set without a model —
  // always show the picker. OpenCode variants are model-specific (models.dev
  // reasoning_options) so the picker stays empty until a model is chosen.
  if (cli === 'opencode') {
    if (!model) return []
    return catalog.opencode.efforts[model] || []
  }
  if (cli === 'codex') {
    if (model && catalog.codex.efforts[model]?.length) return catalog.codex.efforts[model]
    return catalog.codex.defaultEfforts
  }
  // claude — xhigh is Opus-only deep-reasoning; hide it for non-opus models
  const all = catalog.claude.efforts
  if (model && !model.startsWith('opus')) return all.filter(e => e !== 'xhigh')
  return all
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
        const rowCli: Cli = (value[row.cliKey] as Cli | null) || value.default
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
              {CLIS.map(c => (
                <button
                  key={c}
                  disabled={disabled}
                  onClick={() => onChange({ [row.cliKey]: c, [row.modelKey]: null, [row.effortKey]: null } as Partial<CliBlock>)}
                  title={CLI_LABELS[c]}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 10,
                    padding: '4px 9px', borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
                    border: '1px solid var(--border)',
                    background: rowCli === c ? 'var(--accent)' : 'transparent',
                    color: rowCli === c ? '#0d0f14' : 'var(--text-dim)',
                    fontWeight: rowCli === c ? 700 : 400,
                  }}
                >
                  {c === 'claude' ? 'Claude' : c === 'codex' ? 'Codex' : 'OC'}
                </button>
              ))}
            </div>
            {/* 2. Model — fixed width, ellipsis on overflow (parent SearchableSelect) */}
            <div style={{ width: 240, flexShrink: 0, minWidth: 0 }}>
              <SearchableSelect
                value={model}
                options={modelOptions}
                onChange={v => onChange({ [row.modelKey]: v, [row.effortKey]: null } as Partial<CliBlock>)}
                placeholder={`${rowCli === 'claude' ? 'Claude' : rowCli === 'codex' ? 'Codex' : 'OC'} default`}
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
                  placeholder="effort"
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
