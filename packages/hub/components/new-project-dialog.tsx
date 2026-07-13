'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !dirPath.trim()) return
    setCreating(true)
    setError('')
    const res = await fetch('/api/projects/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), dirPath: dirPath.trim() }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); setCreating(false); return }
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
              onChange={e => setName(e.target.value)}
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
              onChange={e => setDirPath(e.target.value)}
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
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>
              {error}
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
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
