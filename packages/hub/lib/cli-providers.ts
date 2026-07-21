// Browser-safe mirror of shared/cli.js → providersFromCliConfig (that module
// pulls in fs/child_process and can't run in client components). Keep in sync.

export type UsageProvider = 'claude' | 'codex' | 'openrouter'

const VALID = new Set(['claude', 'codex', 'opencode'])

/** Which account-usage providers the effective project cli block will hit. */
export function providersFromCliConfig(cliConfig: {
  default?: string | null
  developer_cli?: string | null
  reviewer_cli?: string | null
} | null | undefined): UsageProvider[] {
  const cfg = cliConfig || {}
  const def = cfg.default && VALID.has(cfg.default) ? cfg.default : 'claude'
  const slots = [
    def,
    cfg.developer_cli && VALID.has(cfg.developer_cli) ? cfg.developer_cli : def,
    cfg.reviewer_cli && VALID.has(cfg.reviewer_cli) ? cfg.reviewer_cli : def,
  ]
  const out: UsageProvider[] = []
  const seen = new Set<string>()
  for (const cli of slots) {
    const p = cli === 'claude' ? 'claude' : cli === 'codex' ? 'codex' : cli === 'opencode' ? 'openrouter' : null
    if (p && !seen.has(p)) { seen.add(p); out.push(p) }
  }
  return out
}
