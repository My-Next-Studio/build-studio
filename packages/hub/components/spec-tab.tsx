'use client'

import { useEffect, useState, useRef } from 'react'
import { useProject } from '@/lib/project-context'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function SpecTab({ activeFile, fileVersion = 0 }: { activeFile: string | null; fileVersion?: number }) {
  const { baseUrl } = useProject()
  const [content, setContent] = useState<string>('')
  const [displayFile, setDisplayFile] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevFileRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeFile) { setContent(''); setDisplayFile(null); return }

    const isNewFile = activeFile !== prevFileRef.current
    prevFileRef.current = activeFile

    let cancelled = false
    fetch(`${baseUrl}/api/file?path=${encodeURIComponent(activeFile)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        setContent(data.content || '')
        setDisplayFile(activeFile)
        // Only scroll to top when switching files, not on content updates
        if (isNewFile && scrollRef.current) scrollRef.current.scrollTop = 0
      })
    return () => { cancelled = true }
  }, [activeFile, baseUrl, fileVersion])

  if (!activeFile && !displayFile) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13,
      }}>
        Select a file from the sidebar
      </div>
    )
  }

  return (
    <div ref={scrollRef} style={{ height: '100%', overflow: 'auto', padding: '20px 32px 40px' }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
        marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--border)',
      }}>
        {displayFile || activeFile}
      </div>
      <div className="md-rendered">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  )
}
