// Browser-safe mirror of shared/cli.js → providersFromCliConfig (that module
// pulls in fs/child_process and can't run in client components). Keep in sync.

export type UsageProvider = 'claude' | 'codex' | 'openrouter'

const VALID = new Set(['claude', 'codex', 'opencode'])

/**
 * Which account-usage providers the effective project cli block will hit.
 *
 * Reads the step-group slots rather than a fixed developer/reviewer pair —
 * group keys are user-definable, so the set is whatever config declares, plus
 * the block default for any group that sets no CLI of its own.
 */
export function providersFromCliConfig(cliConfig: {
  default?: string | null
  groups?: Record<string, { cli?: string | null }> | null
} | null | undefined): UsageProvider[] {
  const cfg = cliConfig || {}
  const def = cfg.default && VALID.has(cfg.default) ? cfg.default : 'claude'
  const slots = [def]
  for (const slot of Object.values(cfg.groups || {})) {
    slots.push(slot?.cli && VALID.has(slot.cli) ? slot.cli : def)
  }
  const out: UsageProvider[] = []
  const seen = new Set<string>()
  for (const cli of slots) {
    const p = cli === 'claude' ? 'claude' : cli === 'codex' ? 'codex' : cli === 'opencode' ? 'openrouter' : null
    if (p && !seen.has(p)) { seen.add(p); out.push(p) }
  }
  return out
}
