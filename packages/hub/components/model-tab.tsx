'use client'

import { GlobalCliCard } from '@/components/global-cli-card'
import { UsageTab } from '@/components/usage-tab'

// The Model tab (Home): global agent-CLI/model/effort defaults that projects
// inherit via their Agents-tab "Use default" toggle, plus the account-usage
// widget (Claude / Codex / OpenRouter remaining limits).
export function ModelTab() {
  return (
    <div style={{
      padding: '20px 32px', overflow: 'auto', height: 'calc(100vh - 124px)',
      display: 'flex', flexDirection: 'column', gap: 24,
    }}>
      <GlobalCliCard />
      <UsageTab />
    </div>
  )
}
