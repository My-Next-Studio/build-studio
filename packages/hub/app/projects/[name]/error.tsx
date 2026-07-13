'use client'

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div style={{
      padding: 32, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', flex: 1,
      fontFamily: 'var(--mono)',
    }}>
      <div style={{ fontSize: 14, color: 'var(--red)', marginBottom: 8 }}>
        Failed to load project
      </div>
      <pre style={{
        fontSize: 11, color: 'var(--muted)', maxWidth: 600,
        overflow: 'auto', whiteSpace: 'pre-wrap', marginBottom: 16,
        padding: 12, background: 'var(--surface2)', borderRadius: 'var(--radius)',
      }}>
        {error.message}
        {error.digest && `\nDigest: ${error.digest}`}
      </pre>
      <button onClick={reset} style={{
        padding: '6px 16px', borderRadius: 'var(--radius)',
        background: 'var(--surface3)', border: 'none', color: 'var(--text)',
        fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
      }}>
        Try again
      </button>
    </div>
  )
}
