import type { Metadata } from 'next'
import './globals.css'
import { GlobalStatusBar } from '@/components/global-status-bar'

export const metadata: Metadata = {
  title: 'Build Studio',
  description: 'Mission control for multi-agent Claude Code workflows',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <div className="h-screen flex flex-col overflow-hidden">
          <header
            className="flex items-center gap-3 shrink-0 app-drag"
            style={{
              height: 44,
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--surface)',
              paddingLeft: 80,
              paddingRight: 16,
            }}
          >
            <a
              href="/"
              className="flex items-center gap-2 no-underline app-no-drag"
              style={{ color: 'var(--text-dim)', transition: 'color 0.15s' }}
              onMouseEnter={undefined}
            >
              <span style={{
                fontFamily: 'var(--mono)',
                fontWeight: 600,
                fontSize: 12,
                letterSpacing: '0.03em',
                color: 'var(--accent)',
              }}>
                &#9670;
              </span>
              <span style={{
                fontFamily: 'var(--mono)',
                fontWeight: 600,
                fontSize: 12,
                letterSpacing: '0.02em',
              }}>
                build studio
              </span>
            </a>
            <span className="flex-1" />
          </header>
          <GlobalStatusBar />
          <main className="flex-1 flex flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
