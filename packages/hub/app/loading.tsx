export default function Loading() {
  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <div style={{
          fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14,
          letterSpacing: '0.02em', color: 'var(--text-dim)',
        }}>
          Projects
        </div>
      </div>
      <div style={{
        display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
      }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: '16px 18px',
            opacity: 1 - i * 0.2,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--surface3)' }} />
              <div style={{ width: 100, height: 13, borderRadius: 4, background: 'var(--surface3)' }} />
            </div>
            <div style={{ width: '70%', height: 10, borderRadius: 4, background: 'var(--surface3)', marginBottom: 14 }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ width: 48, height: 26, borderRadius: 'var(--radius)', background: 'var(--surface3)' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
