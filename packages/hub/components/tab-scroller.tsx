'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** The `data-tab` value of the tab to keep in view (the current project). */
  activeKey: string | null
}

/**
 * A horizontal row of tabs that scrolls when it does not fit.
 *
 * With enough projects the top bar ran off the window and the last tabs could
 * not be reached at all. Arrows appear only on the side where tabs are hidden,
 * and whether they show is recomputed whenever anything changes the fit: the
 * window resizing, a tab growing or shrinking as its status changes (a running
 * workflow adds "qa tests 0/1" to a tab), or tabs being added or removed.
 *
 * Also: the active tab scrolls into view when you switch project, the mouse
 * wheel and trackpad scroll the row, and the clipped edge fades so it reads as
 * "more this way".
 */
export function TabScroller({ children, activeKey }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 1px slack: subpixel layout leaves scrollWidth a fraction over clientWidth.
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  // No hand-managed listeners: a first version attached them once at mount,
  // and React's mount/unmount/remount cycles (StrictMode in dev) left the row
  // on screen with none, so the arrows never appeared. Instead:
  //   - scrolling   → the onScroll prop below, owned by React;
  //   - a tab growing or shrinking as its status changes → the top bar
  //     re-renders on every status poll, and this re-measures after every render;
  //   - the window resizing → a ResizeObserver, re-subscribed on every render
  //     so it always watches the row that is actually there.
  useLayoutEffect(() => { update() })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const c of Array.from(el.children)) ro.observe(c)
    return () => ro.disconnect()
  })

  useEffect(() => {
    const el = ref.current
    if (!el || !activeKey) return
    const tab = Array.from(el.querySelectorAll<HTMLElement>('[data-tab]')).find(t => t.dataset.tab === activeKey)
    tab?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [activeKey])

  const scrollByPage = (dir: -1 | 1) => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' })
  }

  const fade = 18
  const mask = canLeft || canRight
    ? `linear-gradient(to right, ${canLeft ? 'transparent' : '#000'} 0, #000 ${fade}px, #000 calc(100% - ${fade}px), ${canRight ? 'transparent' : '#000'} 100%)`
    : undefined

  return (
    <div className="app-no-drag" style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, gap: 2 }}>
      {canLeft && <Arrow dir={-1} onClick={() => scrollByPage(-1)} />}
      <div
        ref={ref}
        onScroll={update}
        className="tab-scroller"
        onWheel={e => {
          // A plain mouse wheel scrolls vertically; turn it sideways here.
          // Trackpads already send deltaX, which the browser handles.
          const el = ref.current
          if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
          overflowX: 'auto', overflowY: 'hidden',
          maskImage: mask, WebkitMaskImage: mask,
        }}
      >
        {children}
      </div>
      {canRight && <Arrow dir={1} onClick={() => scrollByPage(1)} />}
    </div>
  )
}

function Arrow({ dir, onClick }: { dir: -1 | 1; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={dir < 0 ? 'Scroll project tabs left' : 'Scroll project tabs right'}
      aria-label={dir < 0 ? 'Scroll project tabs left' : 'Scroll project tabs right'}
      style={{
        flexShrink: 0, width: 20, height: 20, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 'var(--radius)', border: 'none',
        background: 'var(--surface2)', color: 'var(--text-dim)',
        fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1, cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface3)'; e.currentTarget.style.color = 'var(--text)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface2)'; e.currentTarget.style.color = 'var(--text-dim)' }}
    >
      {dir < 0 ? '‹' : '›'}
    </button>
  )
}
