'use client'

import { useCallback, useEffect, useState } from 'react'

// Usage display (full cards + compact strip). Data from hub GET /api/usage.
// `providers` filters which of claude/codex/openrouter to show — undefined = all.

export type UsageProvider = 'claude' | 'codex' | 'openrouter'

interface WindowUsage { utilizationPct: number | null; resetsAt: string | null }
interface ClaudeData {
  fiveHour?: WindowUsage
  sevenDay?: WindowUsage
  extraUsage?: { is_enabled?: boolean; monthly_limit?: number; used_credits?: number; currency?: string } | null
}
interface OpenRouterData {
  usageDaily: number | null; usageWeekly: number | null; usageMonthly: number | null; usageTotal: number | null
  limit: number | null; limitRemaining: number | null; isFreeTier: boolean
  creditsTotal?: number; creditsRemaining?: number
}
interface CodexData {
  planType: string | null
  primary: { usedPercent: number | null; resetAt: string | null }
  additional: { name: string | null; usedPercent: number | null; resetAt: string | null }[]
}
type ProviderResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unavailable' | 'auth_expired' | 'error'; reason?: string }
export interface UsageResponse {
  fetchedAt: string
  cached?: boolean
  claude: ProviderResult<ClaudeData>
  codex: ProviderResult<CodexData>
  openrouter: ProviderResult<OpenRouterData>
  error?: string
}

const mono = 'var(--mono)'

function pctColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'var(--text-dim)'
  if (pct >= 95) return 'var(--red)'
  if (pct >= 80) return 'var(--orange)'
  return 'var(--green)'
}

function fmtCountdown(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const diff = t - nowMs
  if (diff <= 0) return 'resetting…'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `resets in ${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `resets in ${days}d ${hours % 24}h`
}

const fmtUsd = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${v.toFixed(2)}`

function Bar({ pct, h = 6 }: { pct: number | null | undefined; h?: number }) {
  const shown = pct === null || pct === undefined ? 0 : Math.min(100, pct)
  return (
    <div style={{ height: h, borderRadius: h / 2, background: 'var(--surface3, var(--surface2))', overflow: 'hidden', marginTop: 3 }}>
      <div style={{ height: '100%', width: `${shown}%`, background: pctColor(pct), borderRadius: h / 2, transition: 'width 0.4s' }} />
    </div>
  )
}

function WindowRow({ label, w, nowMs }: { label: string; w?: WindowUsage; nowMs: number }) {
  if (!w) return null
  const cd = fmtCountdown(w.resetsAt, nowMs)
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontSize: 10 }}>
        <span style={{ color: 'var(--text-dim)' }}>{label}</span>
        <span style={{ color: pctColor(w.utilizationPct), fontWeight: 700 }}>
          {w.utilizationPct === null ? '—' : `${Math.round(w.utilizationPct)}%`}
          {cd ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {cd}</span> : null}
        </span>
      </div>
      <Bar pct={w.utilizationPct} />
    </div>
  )
}

function Card({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div style={{
      width: 320, padding: '14px 16px', borderRadius: 'var(--radius)',
      border: '1px solid var(--border)', background: 'var(--surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
        {badge && (
          <span style={{
            fontFamily: mono, fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: 'var(--accent)', background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4,
          }}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function CardStatus({ result }: { result: { status: string; reason?: string } }) {
  const tone = result.status === 'auth_expired' ? 'var(--orange)' : 'var(--muted)'
  const label = result.status === 'unavailable' ? 'unavailable' : result.status === 'auth_expired' ? 'auth expired' : 'error'
  return (
    <div style={{ fontFamily: mono, fontSize: 10, color: tone, marginTop: 8, lineHeight: 1.5 }}>
      {label}{result.reason ? ` — ${result.reason}` : ''}
    </div>
  )
}

function useUsage() {
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async () => {
    const r = await fetch('/api/usage').then((x) => x.json()).catch(() => null)
    if (r && !r.error) {
      setUsage(r as UsageResponse)
      setFetchFailed(false)
      setNowMs(Date.now())
    } else {
      setFetchFailed(true)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, 60_000)
    const tick = setInterval(() => setNowMs(Date.now()), 15_000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [load])

  return { usage, fetchFailed, nowMs }
}

function showProvider(providers: UsageProvider[] | undefined, p: UsageProvider) {
  return !providers || providers.length === 0 || providers.includes(p)
}

/** Full three-card account usage (filtered by providers when set). */
export function UsagePanel({ providers, title = 'Account usage' }: {
  providers?: UsageProvider[]
  title?: string
}) {
  const { usage, fetchFailed, nowMs } = useUsage()
  const sectionHead = { fontFamily: mono, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: 'var(--text-dim)' }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <div style={sectionHead}>{title}</div>
        {usage && (
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted)' }}>
            updated {new Date(usage.fetchedAt).toLocaleTimeString()}{usage.cached ? ' · cached' : ''}
          </div>
        )}
        {fetchFailed && !usage && (
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--red)' }}>/api/usage unreachable</div>
        )}
      </div>

      {!usage && !fetchFailed && (
        <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--muted)' }}>Loading…</div>
      )}

      {usage && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {showProvider(providers, 'claude') && (
            <Card title="Claude">
              {usage.claude.status === 'ok' ? (
                <>
                  <WindowRow label="5-hour window" w={usage.claude.data.fiveHour} nowMs={nowMs} />
                  <WindowRow label="Weekly window" w={usage.claude.data.sevenDay} nowMs={nowMs} />
                  {usage.claude.data.extraUsage?.is_enabled === true && (
                    <div style={{ fontFamily: mono, fontSize: 9, color: 'var(--muted)', marginTop: 10 }}>
                      extra usage: {fmtUsd(usage.claude.data.extraUsage.used_credits ?? null)}
                      {usage.claude.data.extraUsage.monthly_limit ? ` / ${fmtUsd(usage.claude.data.extraUsage.monthly_limit)}` : ''}
                      {usage.claude.data.extraUsage.currency && usage.claude.data.extraUsage.currency !== 'USD' ? ` ${usage.claude.data.extraUsage.currency}` : ''}
                    </div>
                  )}
                </>
              ) : <CardStatus result={usage.claude} />}
            </Card>
          )}

          {showProvider(providers, 'codex') && (
            <Card title="Codex" badge={usage.codex.status === 'ok' && usage.codex.data.planType ? usage.codex.data.planType : undefined}>
              {usage.codex.status === 'ok' ? (
                <>
                  <WindowRow label="Weekly window" w={{ utilizationPct: usage.codex.data.primary.usedPercent, resetsAt: usage.codex.data.primary.resetAt }} nowMs={nowMs} />
                  {usage.codex.data.additional.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      {usage.codex.data.additional.map((l, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
                          <span>{l.name || 'model limit'}</span>
                          <span style={{ color: pctColor(l.usedPercent) }}>
                            {l.usedPercent === null ? '—' : `${Math.round(l.usedPercent)}%`}
                            {fmtCountdown(l.resetAt, nowMs) ? <span style={{ color: 'var(--muted)' }}> · {fmtCountdown(l.resetAt, nowMs)}</span> : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : <CardStatus result={usage.codex} />}
            </Card>
          )}

          {showProvider(providers, 'openrouter') && (
            <Card title="OpenRouter" badge={usage.openrouter.status === 'ok' && usage.openrouter.data.isFreeTier ? 'free tier' : undefined}>
              {usage.openrouter.status === 'ok' ? (
                <>
                  {usage.openrouter.data.creditsRemaining !== undefined && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--text-dim)' }}>credits remaining</div>
                      <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                        {fmtUsd(usage.openrouter.data.creditsRemaining)}
                        {usage.openrouter.data.creditsTotal !== undefined && (
                          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--muted)' }}> / {fmtUsd(usage.openrouter.data.creditsTotal)}</span>
                        )}
                      </div>
                    </div>
                  )}
                  {usage.openrouter.data.limit !== null && usage.openrouter.data.limit > 0 && (
                    <WindowRow
                      label="per-key limit"
                      w={{
                        utilizationPct: usage.openrouter.data.limit && usage.openrouter.data.limitRemaining !== null
                          ? Math.round((1 - usage.openrouter.data.limitRemaining / usage.openrouter.data.limit) * 1000) / 10
                          : null,
                        resetsAt: null,
                      }}
                      nowMs={nowMs}
                    />
                  )}
                  <div style={{ marginTop: 10, fontFamily: mono, fontSize: 9, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span>day {fmtUsd(usage.openrouter.data.usageDaily)} · week {fmtUsd(usage.openrouter.data.usageWeekly)}</span>
                    <span>month {fmtUsd(usage.openrouter.data.usageMonthly)} · total {fmtUsd(usage.openrouter.data.usageTotal)}</span>
                  </div>
                </>
              ) : <CardStatus result={usage.openrouter} />}
            </Card>
          )}
        </div>
      )}
    </section>
  )
}

/** Compact strip for the workflow start panel — only the providers in use. */
export function CompactUsageMeter({ providers }: { providers?: UsageProvider[] }) {
  const { usage, fetchFailed, nowMs } = useUsage()
  if (fetchFailed && !usage) {
    return (
      <div style={{ fontFamily: mono, fontSize: 9, color: 'var(--muted)', marginBottom: 10 }}>
        usage unavailable
      </div>
    )
  }
  if (!usage) {
    return (
      <div style={{ fontFamily: mono, fontSize: 9, color: 'var(--muted)', marginBottom: 10 }}>
        usage…
      </div>
    )
  }

  const rows: { key: string; label: string; pct: number | null; sub?: string }[] = []
  if (showProvider(providers, 'claude') && usage.claude.status === 'ok') {
    const d = usage.claude.data
    const five = d.fiveHour?.utilizationPct ?? null
    const week = d.sevenDay?.utilizationPct ?? null
    rows.push({
      key: 'claude',
      label: 'Claude',
      pct: five ?? week,
      sub: [
        five !== null ? `5h ${Math.round(five)}%` : null,
        week !== null ? `wk ${Math.round(week)}%` : null,
        fmtCountdown(d.fiveHour?.resetsAt ?? d.sevenDay?.resetsAt ?? null, nowMs),
      ].filter(Boolean).join(' · '),
    })
  } else if (showProvider(providers, 'claude') && usage.claude.status !== 'ok') {
    rows.push({ key: 'claude', label: 'Claude', pct: null, sub: usage.claude.status })
  }

  if (showProvider(providers, 'codex') && usage.codex.status === 'ok') {
    const p = usage.codex.data.primary
    rows.push({
      key: 'codex',
      label: 'Codex',
      pct: p.usedPercent,
      sub: [
        p.usedPercent !== null ? `${Math.round(p.usedPercent)}%` : null,
        usage.codex.data.planType,
        fmtCountdown(p.resetAt, nowMs),
      ].filter(Boolean).join(' · '),
    })
  } else if (showProvider(providers, 'codex') && usage.codex.status !== 'ok') {
    rows.push({ key: 'codex', label: 'Codex', pct: null, sub: usage.codex.status })
  }

  if (showProvider(providers, 'openrouter') && usage.openrouter.status === 'ok') {
    const d = usage.openrouter.data
    const limitPct = d.limit && d.limit > 0 && d.limitRemaining !== null
      ? Math.round((1 - d.limitRemaining / d.limit) * 1000) / 10
      : null
    rows.push({
      key: 'openrouter',
      label: 'OpenRouter',
      pct: limitPct,
      sub: [
        d.creditsRemaining !== undefined ? fmtUsd(d.creditsRemaining) : null,
        d.creditsTotal !== undefined ? `/ ${fmtUsd(d.creditsTotal)}` : null,
        d.usageDaily !== null ? `day ${fmtUsd(d.usageDaily)}` : null,
      ].filter(Boolean).join(' '),
    })
  } else if (showProvider(providers, 'openrouter') && usage.openrouter.status !== 'ok') {
    rows.push({ key: 'openrouter', label: 'OpenRouter', pct: null, sub: usage.openrouter.status })
  }

  if (rows.length === 0) return null

  return (
    <div style={{
      marginBottom: 12, padding: '8px 10px', borderRadius: 6,
      border: '1px solid var(--border)', background: 'var(--surface2)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        fontFamily: mono, fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'var(--text-dim)',
      }}>
        Usage
      </div>
      {rows.map(r => (
        <div key={r.key}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: mono, fontSize: 10 }}>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>{r.label}</span>
            <span style={{ color: pctColor(r.pct), fontWeight: 600, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.sub || (r.pct === null ? '—' : `${Math.round(r.pct)}%`)}
            </span>
          </div>
          {r.pct !== null && <Bar pct={r.pct} h={4} />}
        </div>
      ))}
    </div>
  )
}
