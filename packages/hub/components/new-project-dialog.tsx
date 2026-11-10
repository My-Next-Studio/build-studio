'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  // Existing files init would replace, merge or move: shown for confirmation
  // before anything is written (api/projects/init, needsConfirm).
  const [changes, setChanges] = useState<{ path: string; action: string; note: string }[] | null>(null)
  // Shown after a successful init that left something for the owner to know
  // (e.g. the repository is not on main); the owner opens the project from here.
  const [warnings, setWarnings] = useState<string[] | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  async function openProject(projectName: string) {
    await fetch(`/api/projects/${projectName}/start`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 1200))
    router.push(`/projects/${projectName}`)
  }

  async function create(confirm: boolean) {
    if (!name.trim() || !dirPath.trim()) return
    setCreating(true)
    setError('')
    const res = await fetch('/api/projects/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), dirPath: dirPath.trim(), ...(confirm ? { confirm: true } : {}) }),
    })
    const data = await res.json()
    if (!res.ok) {
      if (data.needsConfirm) setChanges(data.changes || [])
      else {
        const list: string[] | undefined = data.dirty?.length ? data.dirty : data.symlinks
        setError(list?.length ? `${data.error}\n${list.join('\n')}` : data.error)
      }
      setCreating(false)
      return
    }
    setChanges(null)
    if (data.warnings?.length) {
      setWarnings(data.warnings)
      setCreated(data.name)
      setCreating(false)
      return
    }
    await openProject(data.name)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    await create(!!changes)
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
          width: '100%', maxWidth: 420,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{
          fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13,
          letterSpacing: '0.02em', margin: '0 0 20px', color: 'var(--text)',
        }}>
          New Project
        </h2>

        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label>
            <span style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Name
            </span>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setChanges(null) }}
              placeholder="my-project"
              autoFocus
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 'var(--radius)',
                background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
                outline: 'none', transition: 'border-color 0.15s',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
            />
          </label>

          <label>
            <span style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Directory
            </span>
            <input
              value={dirPath}
              onChange={e => { setDirPath(e.target.value); setChanges(null) }}
              placeholder="~/projects/my-project"
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 'var(--radius)',
                background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
                outline: 'none', transition: 'border-color 0.15s',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
            />
          </label>

          {error && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}

          {changes && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <div style={{ color: 'var(--orange)', fontWeight: 600, marginBottom: 6 }}>
                This folder already has files. Init will change these:
              </div>
              <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 8px' }}>
                {changes.map(c => (
                  <div key={c.path}>
                    <span style={{ color: 'var(--text)' }}>{c.path}</span> — {c.action}: {c.note}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 6 }}>
                Everything else in the folder is left as it is. Your vision, project state, decisions, AGENTS.md and ARCHITECTURE.md are never overwritten.
              </div>
            </div>
          )}

          {warnings && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)', lineHeight: 1.5 }}>
              {warnings.map(w => <div key={w}>{w}</div>)}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 'var(--radius)',
                background: 'none', border: '1px solid var(--border)',
                color: 'var(--text-dim)', fontFamily: 'var(--mono)',
                fontSize: 11, fontWeight: 500, cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              Cancel
            </button>
            {created ? (
            <button
              type="button"
              onClick={() => void openProject(created)}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 'var(--radius)',
                background: 'var(--accent)', border: 'none',
                color: '#111114', fontFamily: 'var(--mono)',
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Open project
            </button>
            ) : (
            <button
              type="submit"
              disabled={creating || !name.trim() || !dirPath.trim()}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 'var(--radius)',
                background: 'var(--accent)', border: 'none',
                color: '#111114', fontFamily: 'var(--mono)',
                fontSize: 11, fontWeight: 700, cursor: creating ? 'wait' : 'pointer',
                opacity: creating || !name.trim() || !dirPath.trim() ? 0.4 : 1,
                transition: 'all 0.15s',
              }}
            >
              {creating ? 'Creating...' : changes ? 'Initialize anyway' : 'Create'}
            </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
