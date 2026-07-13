'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface DevCommand { name: string; cmd: string; cwd?: string; port?: number; type?: string }
interface DeploymentDetect {
  repo: string | null
  ciWorkflow: string | null
  autoDeployHint: string | null
  deployedOnPush: boolean
}
interface DocEntry { path: string; kind: string; bytes: number }

interface PreviewResult {
  preset: string
  presetReason: string
  deployment: DeploymentDetect
  devCommands: DevCommand[]
  existingDocs: DocEntry[]
  existingDocCounts: { existingPrds: number; existingAdrs: number; existingContracts: number }
  claudeMdPresent: boolean
  agentsMdPresent: boolean
  specsDirPresent: boolean
}

type Step = 'input' | 'preview' | 'submitting'

export function OnboardProjectDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [step, setStep] = useState<Step>('input')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [error, setError] = useState('')

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !dirPath.trim()) return
    setError('')
    const res = await fetch('/api/projects/onboard/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirPath: dirPath.trim() }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Preview failed'); return }
    setPreview(data.preview)
    setStep('preview')
  }

  async function handleConfirm() {
    setStep('submitting')
    setError('')
    const res = await fetch('/api/projects/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), dirPath: dirPath.trim() }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Onboard failed'); setStep('preview'); return }
    await fetch(`/api/projects/${data.name}/start`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 1200))
    router.push(`/projects/${data.name}`)
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px 28px',
          width: '100%', maxWidth: 540,
          maxHeight: '85vh', overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{
          fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13,
          letterSpacing: '0.02em', margin: '0 0 4px', color: 'var(--text)',
        }}>
          Onboard existing project
        </h2>
        <p style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
          margin: '0 0 20px',
        }}>
          {step === 'input' && 'Bring an existing git repo under dashboard management. Nothing is overwritten; no commits are made.'}
          {step === 'preview' && 'Review what will be detected. Click Confirm to scaffold.'}
          {step === 'submitting' && 'Scaffolding…'}
        </p>

        {step === 'input' && (
          <form onSubmit={handlePreview} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <FormField label="Name" placeholder="my-existing-project" value={name} onChange={setName} autoFocus />
            <FormField label="Directory" placeholder="~/projects/my-project" value={dirPath} onChange={setDirPath} />
            {error && <ErrorLine>{error}</ErrorLine>}
            <ButtonRow>
              <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
              <PrimaryButton type="submit" disabled={!name.trim() || !dirPath.trim()}>Preview</PrimaryButton>
            </ButtonRow>
          </form>
        )}

        {step === 'preview' && preview && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <PreviewSection label="Preset" value={preview.preset} hint={preview.presetReason} />
            <PreviewSection
              label="Deployment"
              value={preview.deployment.repo || '(no git remote)'}
              hint={
                preview.deployment.ciWorkflow
                  ? `Manual deploy via .github/workflows/${preview.deployment.ciWorkflow} (Deploy button enabled)`
                  : 'Push to main = deploy (Deploy button hidden)'
              }
            />
            {preview.devCommands.length > 0 && (
              <div>
                <PreviewLabel>Dev commands ({preview.devCommands.length})</PreviewLabel>
                <div style={{
                  background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius)', padding: '8px 10px',
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
                }}>
                  {preview.devCommands.map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                      <span style={{ color: 'var(--accent)', minWidth: 80 }}>{c.name}</span>
                      <span style={{ flex: 1 }}>{c.cwd ? `${c.cwd}/` : ''}{c.cmd}</span>
                      {c.port && <span style={{ color: 'var(--muted)' }}>:{c.port}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <PreviewLabel>Existing docs ({preview.existingDocs.length})</PreviewLabel>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
                display: 'flex', flexWrap: 'wrap', gap: 8,
              }}>
                {summariseDocs(preview)}
              </div>
            </div>
            {error && <ErrorLine>{error}</ErrorLine>}
            <ButtonRow>
              <SecondaryButton onClick={() => setStep('input')}>Back</SecondaryButton>
              <PrimaryButton onClick={handleConfirm}>Confirm and onboard</PrimaryButton>
            </ButtonRow>
          </div>
        )}

        {step === 'submitting' && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', padding: '8px 0' }}>
            Scaffolding files… (no git commits made)
          </div>
        )}
      </div>
    </div>
  )
}

function summariseDocs(p: PreviewResult): React.ReactNode {
  const tags: string[] = []
  for (const d of p.existingDocs) tags.push(`${d.kind}:${d.path}`)
  if (p.existingDocCounts.existingPrds > 0) tags.push(`+${p.existingDocCounts.existingPrds} PRDs`)
  if (p.existingDocCounts.existingAdrs > 0) tags.push(`+${p.existingDocCounts.existingAdrs} ADRs`)
  if (tags.length === 0) return <span>(none)</span>
  return tags.map((t, i) => (
    <span key={i} style={{
      padding: '2px 6px', borderRadius: 3,
      background: 'var(--surface2)', whiteSpace: 'nowrap',
    }}>{t}</span>
  ))
}

function FormField({ label, value, onChange, placeholder, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean
}) {
  return (
    <label>
      <span style={{
        display: 'block', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
        marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 'var(--radius)',
          background: 'var(--bg)', border: '1px solid var(--border-subtle)',
          color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
          outline: 'none',
        }}
      />
    </label>
  )
}

function PreviewLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'block', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
      marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>{children}</div>
  )
}

function PreviewSection({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <PreviewLabel>{label}</PreviewLabel>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)',
        background: 'var(--bg)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)', padding: '6px 10px',
      }}>{value}</div>
      {hint && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>{hint}</div>
      )}
    </div>
  )
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{children}</div>
}

function ButtonRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>{children}</div>
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '8px 0', borderRadius: 'var(--radius)',
        background: 'none', border: '1px solid var(--border)',
        color: 'var(--text-dim)', fontFamily: 'var(--mono)',
        fontSize: 11, fontWeight: 500, cursor: 'pointer',
      }}
    >{children}</button>
  )
}

function PrimaryButton({ children, onClick, type, disabled }: {
  children: React.ReactNode; onClick?: () => void; type?: 'submit' | 'button'; disabled?: boolean
}) {
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, padding: '8px 0', borderRadius: 'var(--radius)',
        background: 'var(--accent)', border: 'none',
        color: '#111114', fontFamily: 'var(--mono)',
        fontSize: 11, fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >{children}</button>
  )
}
