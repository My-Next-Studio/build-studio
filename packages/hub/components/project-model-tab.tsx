'use client'

import { CliSettingsCard } from './cli-settings-card'
import { UsagePanel } from './usage-panel'

// Project-level Model tab — same layout as the Home Model tab (CLI cascade +
// usage), plus the "Use default" checkbox on CliSettingsCard.
export function ProjectModelTab() {
  return (
    <div style={{
      padding: '20px 32px', overflow: 'auto', height: '100%',
      display: 'flex', flexDirection: 'column', gap: 24,
    }}>
      <CliSettingsCard />
      <UsagePanel title="Account usage" />
    </div>
  )
}
