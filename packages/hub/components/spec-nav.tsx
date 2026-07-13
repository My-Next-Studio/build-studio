'use client'

import { useEffect, useState } from 'react'
import { useProject } from '@/lib/project-context'

interface FileEntry {
  path: string
  name?: string
}

export function SpecNav({
  activeFile,
  onSelectFile,
  recentFiles,
  fileVersion = 0,
  collapsed,
  onCollapsedChange,
}: {
  activeFile: string | null
  onSelectFile: (path: string) => void
  recentFiles: Set<string>
  fileVersion?: number
  collapsed: Set<string>
  onCollapsedChange: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void
}) {
  const { baseUrl } = useProject()
  const [files, setFiles] = useState<FileEntry[]>([])

  useEffect(() => {
    fetch(`${baseUrl}/api/files`)
      .then(r => r.json())
      .then(data => setFiles(data.files || []))
  }, [baseUrl, fileVersion])

  // Periodic re-fetch as a safety net for missed fs events (e.g. deletions while server was down)
  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`${baseUrl}/api/files`)
        .then(r => r.json())
        .then(data => setFiles(data.files || []))
        .catch(() => {})
    }, 30000)
    return () => clearInterval(interval)
  }, [baseUrl])

  // Auto-expand folder containing the active file
  useEffect(() => {
    if (!activeFile) return
    const parts = activeFile.split('/')
    if (parts.length > 1) {
      const folder = parts.slice(0, -1).join('/')
      onCollapsedChange((prev) => {
        if (!prev.has(folder)) return prev
        const next = new Set(prev)
        next.delete(folder)
        return next
      })
    }
  }, [activeFile])

  // Group files by folder
  const groups: Record<string, FileEntry[]> = {}
  for (const f of files) {
    const parts = f.path.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '·'
    if (!groups[folder]) groups[folder] = []
    groups[folder].push(f)
  }

  const folders = Object.keys(groups).filter(f => f !== '·')

  function toggleFolder(folder: string) {
    onCollapsedChange((prev) => {
      const next = new Set(prev)
      next.has(folder) ? next.delete(folder) : next.add(folder)
      return next
    })
  }

  function expandAll() { onCollapsedChange(new Set()) }
  function collapseAll() { onCollapsedChange(new Set(folders)) }

  return (
    <nav style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface)',
      padding: '8px 0',
    }}>
      <div style={{
        padding: '4px 12px 6px',
        display: 'flex', alignItems: 'center',
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--text-dim)', flex: 1,
        }}>Docs</span>
        {folders.length > 0 && (
          <span style={{ display: 'flex', gap: 2 }}>
            <button onClick={expandAll} title="Expand all" style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '1px 5px',
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
              borderRadius: 'var(--radius)', letterSpacing: '0.02em',
            }}>+ all</button>
            <button onClick={collapseAll} title="Collapse all" style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '1px 5px',
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
              borderRadius: 'var(--radius)', letterSpacing: '0.02em',
            }}>− all</button>
          </span>
        )}
      </div>
      {Object.entries(groups).map(([folder, folderFiles]) => {
        const isCollapsed = collapsed.has(folder)
        const hasActive = folderFiles.some(f => f.path === activeFile)
        const hasRecent = folderFiles.some(f => recentFiles.has(f.path))
        return (
          <div key={folder}>
            {folder !== '·' && (
              <div
                onClick={() => toggleFolder(folder)}
                style={{
                  padding: '5px 12px 3px',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: hasActive ? 'var(--text-dim)' : 'var(--muted)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5,
                  userSelect: 'none',
                }}
              >
                <span style={{ fontSize: 8, opacity: 0.7, flexShrink: 0, lineHeight: 1 }}>
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {folder}
                </span>
                {hasRecent && !isCollapsed && (
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
                )}
              </div>
            )}
            {!isCollapsed && folderFiles.map(f => {
              const name = f.path.split('/').pop()
              const isActive = activeFile === f.path
              const isRecent = recentFiles.has(f.path)
              return (
                <div
                  key={f.path}
                  onClick={() => onSelectFile(f.path)}
                  style={{
                    padding: '4px 12px 4px',
                    paddingLeft: folder !== '·' ? 24 : 16,
                    fontFamily: 'var(--mono)', fontSize: 11,
                    color: isActive ? 'var(--text)' : 'var(--text-dim)',
                    background: isActive ? 'var(--surface2)' : 'transparent',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <span style={{ color: 'var(--muted)', fontSize: 10, flexShrink: 0 }}>≡</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  {isRecent && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />}
                </div>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
