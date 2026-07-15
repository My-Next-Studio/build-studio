'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  closestCorners, type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ─── Types ────────────────────────────────────────────────────────────────
interface Item {
  id: string
  title?: string
  type?: 'Feature' | 'Bug' | 'Task'
  status?:
    | 'Backlog' | 'Drafted' | 'Reviewed' | 'Implemented' | 'Done' | 'Blocked'  // current Feature lifecycle
    | 'Fixing'                                                                 // Bug lifecycle (bugfix workflow in flight)
    | 'Ready' | 'In Progress' | 'In Review'                                    // legacy values
  release?: string | null
  created?: string
  prd?: string | null
  depends_on?: string[]
  cost_actual_usd?: number | null
  body?: string
  /** Companion-spec entries parsed from the PRD's Companion Specs table
   * (or set explicitly via frontmatter). `exists=false` items are normal —
   * companion specs are typically drafted during the review workflow, so a
   * pending spec is shown as a placeholder rather than hidden. */
  companion_specs?: Array<{ path: string; exists: boolean }>
}

interface BacklogGroup {
  release: string
  items: string[]
}

interface BacklogResponse {
  groups: BacklogGroup[]
  items: Record<string, Item>
}

type TypeFilter = 'all' | 'Feature' | 'Bug' | 'Task'

// ─── Component ────────────────────────────────────────────────────────────
export function BacklogTab({
  onOpenPRD,
  expanded: expandedProp,
  onExpandedChange,
}: {
  onOpenPRD?: (path: string) => void
  /** Controlled expand state. When omitted the tab manages its own Set
   * (preserves the legacy standalone usage). When provided, the parent owns
   * it — used by project-dashboard to survive function-switches and reloads. */
  expanded?: Set<string>
  onExpandedChange?: (next: Set<string>) => void
} = {}) {
  const api = useProjectApi()
  const [groups, setGroups] = useState<BacklogGroup[]>([])
  const [items, setItems] = useState<Record<string, Item>>({})
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set())
  const expanded = expandedProp ?? internalExpanded
  const setExpanded = (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof updater === 'function' ? (updater as (p: Set<string>) => Set<string>)(expanded) : updater
    if (onExpandedChange) onExpandedChange(next)
    else setInternalExpanded(next)
  }
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  // Hide-done is sticky across function switches (Project ↔ Development).
  // Bug-fix history: the first attempt used a lazy-init + write-on-every-change
  // pattern, which clobbered the persisted value on every mount: SSR renders
  // `false`, client hydrates `false`, then the write effect fires post-hydration
  // and overwrites localStorage with `"false"` BEFORE any user toggle. Current
  // pattern: read once post-mount, write only on user action via a callback
  // wrapper. No write fires during the initial render, so the stored value
  // survives mount.
  const [hideDone, setHideDoneInternal] = useState<boolean>(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem('build-studio:backlog:hideDone') === 'true') {
      setHideDoneInternal(true)
    }
  }, [])
  const setHideDone = useCallback((value: boolean) => {
    setHideDoneInternal(value)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('build-studio:backlog:hideDone', String(value))
    }
  }, [])
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const data: BacklogResponse = await api.get('/backlog')
      setGroups(data.groups || [])
      // Defensive coercion — historical API versions returned companion_specs
      // as string[]; current shape is Array<{path, exists}>. Accept either so
      // a project-server / hub-bundle version mismatch doesn't crash render.
      const coerced: Record<string, Item> = {}
      for (const [id, raw] of Object.entries(data.items || {})) {
        const cs = (raw as Item).companion_specs
        const normalized = Array.isArray(cs)
          ? cs.map((s: unknown) =>
              typeof s === 'string' ? { path: s, exists: true } : s as { path: string; exists: boolean }
            )
          : undefined
        coerced[id] = { ...(raw as Item), companion_specs: normalized }
      }
      setItems(coerced)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load backlog')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Manual status change — called from the clickable StatusPill. The server-side
  // workflow hooks still drive automated transitions (PRD merge → Implemented,
  // etc.); this handles operator-initiated moves: Done after manual verify,
  // Blocked when external work stalls, corrections when an auto-transition
  // misfired. PATCH writes the item file + re-renders the BACKLOG section,
  // then returns the updated item which we splice into local state.
  const setItemStatus = useCallback(async (id: string, status: string) => {
    try {
      const data: { item?: Item; movedToShipped?: boolean; error?: string } =
        await api.patch(`/backlog/items/${id}`, { status })
      if (data.error) { setError(data.error); return }
      if (data.item) setItems(prev => ({ ...prev, [id]: data.item! }))
      // If the item moved to a Shipped release (Done auto-move), the groups
      // structure changed — re-fetch to pick up the new ordering. For other
      // transitions the groups are unchanged; the splice above is sufficient.
      if (data.movedToShipped) load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status update failed')
    }
  }, [api, load])

  // ─── Filtering / counts ─────────────────────────────────────────────────
  const counts = useMemo(() => {
    let all = 0, feat = 0, bug = 0, task = 0
    for (const g of groups) for (const id of g.items) {
      const it = items[id]
      if (!it) continue
      all++
      if (it.type === 'Feature') feat++
      else if (it.type === 'Bug') bug++
      else if (it.type === 'Task') task++
    }
    return { all, feat, bug, task }
  }, [groups, items])

  // Item files with no line between the BACKLOG markers in project-state.md.
  // They belong to no release group, so without this strip they render nowhere.
  const unlisted = useMemo(() => {
    const grouped = new Set<string>()
    for (const g of groups) for (const id of g.items) grouped.add(id)
    return Object.keys(items).filter(id => !grouped.has(id)).sort()
  }, [groups, items])

  function shouldShow(item: Item | undefined): boolean {
    if (!item) return false
    if (typeFilter !== 'all' && item.type !== typeFilter) return false
    if (hideDone && item.status === 'Done') return false
    if (search) {
      const q = search.toLowerCase()
      const hay = `${item.id} ${item.title || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }

  // ─── Drag-and-drop ──────────────────────────────────────────────────────
  // Filter-aware drag is intentionally disabled — filtered/searched items can
  // be reordered relative to other visible items, but the underlying groups[]
  // state always contains the full ordered set. dnd-kit operates on the full
  // visible-id list per release, so filtering hides rows but doesn't shrink
  // the data model.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const [activeId, setActiveId] = useState<string | null>(null)

  // Find which group's items array contains `id`.
  function containerOf(id: string, gs: BacklogGroup[] = groups): string | null {
    for (const g of gs) if (g.items.includes(id)) return g.release
    return null
  }

  function persist(newGroups: BacklogGroup[]) {
    api.post('/backlog/reorder', { groups: newGroups })
      .then((d: BacklogResponse) => {
        if (d.groups) setGroups(d.groups)
        if (d.items) setItems(d.items)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Reorder failed'))
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
  }

  // Move the active item between containers as it's dragged. Local state
  // only — wait for onDragEnd to persist.
  function onDragOver(event: { active: { id: string | number }; over: { id: string | number } | null }) {
    if (!event.over) return
    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    if (activeId === overId) return
    setGroups(prev => {
      const from = containerOf(activeId, prev)
      // overId may be either an item id (we're hovering another row) or a
      // release name (we're hovering an empty release droppable).
      const overIsRelease = prev.some(g => g.release === overId)
      const to = overIsRelease ? overId : containerOf(overId, prev)
      if (!from || !to || from === to) return prev
      const next = prev.map(g => ({ ...g, items: [...g.items] }))
      const fromG = next.find(g => g.release === from)!
      const toG = next.find(g => g.release === to)!
      fromG.items = fromG.items.filter(x => x !== activeId)
      // Insert at the position of overId in toG, or append if hovering the
      // release itself.
      const insertIdx = overIsRelease ? toG.items.length : toG.items.indexOf(overId)
      toG.items.splice(insertIdx < 0 ? toG.items.length : insertIdx, 0, activeId)
      return next
    })
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    if (!overId || activeId === overId) {
      persist(groups)  // cross-release move already happened in onDragOver
      return
    }
    setGroups(prev => {
      const containerId = containerOf(activeId, prev)
      if (!containerId) { persist(prev); return prev }
      const g = prev.find(x => x.release === containerId)!
      const oldIdx = g.items.indexOf(activeId)
      const newIdx = g.items.indexOf(overId)
      if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) { persist(prev); return prev }
      const next = prev.map(x => x.release === containerId
        ? { ...x, items: arrayMove(x.items, oldIdx, newIdx) }
        : x
      )
      persist(next)
      return next
    })
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--mono)', overflow: 'auto' }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' }}>Backlog</h1>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, margin: 0, maxWidth: 700 }}>
          Ordered list of features, bugs, and tasks. Click a row to expand details inline. Drag the <code style={{ background: 'var(--surface3)', color: 'var(--accent)', padding: '0 4px', borderRadius: 2 }}>⋮⋮</code> handle to reorder, including across releases. Items are created and edited via the project terminal — tell PM &ldquo;Add issue&rdquo; or &ldquo;Edit issue {'<ID>'}&rdquo;.
        </p>
      </div>

      {/* Filter bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 0 16px', borderBottom: '1px solid var(--border-subtle)',
      }}>
        <FilterChip active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>All · {counts.all}</FilterChip>
        <FilterChip active={typeFilter === 'Feature'} onClick={() => setTypeFilter('Feature')}>Features · {counts.feat}</FilterChip>
        <FilterChip active={typeFilter === 'Bug'} onClick={() => setTypeFilter('Bug')}>Bugs · {counts.bug}</FilterChip>
        <FilterChip active={typeFilter === 'Task'} onClick={() => setTypeFilter('Task')}>Tasks · {counts.task}</FilterChip>
        <span style={{ flex: 1 }} />
        <FilterChip active={hideDone} onClick={() => setHideDone(!hideDone)}>Hide done</FilterChip>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter…"
          style={{
            width: 220, padding: '5px 10px',
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
          }}
        />
      </div>

      {/* Error or empty state */}
      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(255,95,95,0.08)', border: '1px solid var(--red)', borderRadius: 4, color: 'var(--red)', fontSize: 11 }}>
          {error}
        </div>
      )}

      {/* Unlisted items — orphaned item files that no release group renders */}
      {!loading && !error && unlisted.length > 0 && (
        <div style={{ padding: '8px 12px', background: 'rgba(245,158,11,0.08)', border: '1px solid var(--orange)', borderRadius: 4, fontSize: 11, lineHeight: 1.6 }}>
          <span style={{ color: 'var(--orange)', fontWeight: 700 }}>
            ⚠ {unlisted.length} unlisted item{unlisted.length === 1 ? '' : 's'}
          </span>
          <span style={{ color: 'var(--text-dim)' }}>
            {' '}— item file exists in <Code>docs/backlog/</Code> but has no line between the BACKLOG markers in <Code>docs/project-state.md</Code>, so it belongs to no release. Tell PM to re-splice it, or add the line by hand.
          </span>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {unlisted.map(id => {
              const it = items[id]
              return (
                <div key={id} style={{ color: 'var(--text)' }}>
                  {id} — {it?.title || '(untitled)'}{' '}
                  <span style={{ color: 'var(--muted)' }}>[{it?.type || '?'} · {it?.status || '?'}]</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div style={{ padding: 24, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6 }}>
          <p style={{ margin: 0 }}>
            No backlog markers in <Code>docs/project-state.md</Code>.
          </p>
          <p style={{ marginTop: 8 }}>
            Add a <Code>{'<!-- BACKLOG-START -->'}…{'<!-- BACKLOG-END -->'}</Code> section and put item files at <Code>docs/backlog/{'<ID>'}.md</Code>.
          </p>
        </div>
      )}

      {/* Filter-active hint */}
      {(typeFilter !== 'all' || hideDone || search.length > 0) && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: -8 }}>
          Drag-to-reorder disabled while a filter is active — clear filters to reorder.
        </div>
      )}

      {/* Release groups — wrapped in DndContext for drag-and-drop */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        {groups.map((g, gi) => {
          const visibleIds = g.items.filter(id => shouldShow(items[id]))
          if (visibleIds.length === 0 && search) return null
          const isCurrent = /current/i.test(g.release)
          const dragDisabled = typeFilter !== 'all' || hideDone || search.length > 0
          return (
            <section key={`${g.release}-${gi}`} style={{ marginTop: 8 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 8,
                fontSize: 10, fontWeight: 700,
                color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em',
              }}>
                {g.release}
                {isCurrent && <span style={{
                  color: 'var(--green)', background: 'rgba(34,197,94,0.15)',
                  border: '1px solid var(--green)', padding: '1px 6px', borderRadius: 3,
                  fontSize: 9, letterSpacing: '0.06em',
                }}>current</span>}
                <span style={{ color: 'var(--muted)', fontWeight: 500 }}>· {visibleIds.length} item{visibleIds.length === 1 ? '' : 's'}</span>
              </div>

              <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {visibleIds.map(id => (
                    <SortableItemRow
                      key={id}
                      id={id}
                      item={items[id]}
                      isExpanded={expanded.has(id)}
                      onToggle={toggle}
                      onOpenPRD={onOpenPRD}
                      onStatusChange={setItemStatus}
                      dragDisabled={dragDisabled}
                    />
                  ))}
                </div>
              </SortableContext>
            </section>
          )
        })}
        <DragOverlay>
          {activeId && items[activeId] && (
            <div style={{
              background: 'var(--surface2)', border: '1px solid var(--accent)',
              borderRadius: 'var(--radius)', padding: '10px 12px',
              display: 'grid', gridTemplateColumns: '24px 28px 78px 1fr auto',
              gap: 12, alignItems: 'center',
              fontFamily: 'var(--mono)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              cursor: 'grabbing',
            }}>
              <span style={{ color: 'var(--accent)', fontSize: 14, textAlign: 'center', letterSpacing: -1 }}>⋮⋮</span>
              <span style={{ color: 'var(--muted)', fontSize: 10 }}>▶</span>
              <TypeBadge type={items[activeId].type} />
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.04em' }}>{activeId} </span>
                <span style={{ color: 'var(--text)', fontSize: 12 }}>{items[activeId].title || '(no title)'}</span>
              </div>
              <StatusPill status={items[activeId].status} />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  )

  // ─── Internal: sortable row component ─────────────────────────────────
  function SortableItemRow({ id, item, isExpanded, onToggle, onOpenPRD, onStatusChange, dragDisabled }: {
    id: string
    item?: Item
    isExpanded: boolean
    onToggle: (id: string) => void
    onOpenPRD?: (path: string) => void
    onStatusChange?: (id: string, status: string) => void
    dragDisabled: boolean
  }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: dragDisabled })
    const isDone = item?.status === 'Done'
    const rowStyle: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.3 : 1,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
    }
    return (
      <div ref={setNodeRef} style={rowStyle} {...attributes}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '24px 1fr',
          alignItems: 'stretch',
          background: isExpanded ? 'var(--surface2)' : 'transparent',
          borderBottom: isExpanded ? '1px solid var(--border-subtle)' : 'none',
        }}>
          <span
            {...listeners}
            style={{
              color: 'var(--muted)', fontSize: 14, letterSpacing: -1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: dragDisabled ? 'default' : (isDragging ? 'grabbing' : 'grab'),
              userSelect: 'none', touchAction: 'none',
            }}
            aria-label={dragDisabled ? 'drag disabled while filter active' : 'drag to reorder'}
          >⋮⋮</span>
          <button
            onClick={() => onToggle(id)}
            style={{
              display: 'grid',
              gridTemplateColumns: '28px 78px 1fr auto',
              gap: 12, alignItems: 'center',
              padding: '10px 12px 10px 0',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              color: 'var(--text)',
              width: '100%',
            }}
          >
            <span style={{
              color: isExpanded ? 'var(--text-dim)' : 'var(--muted)',
              fontSize: 10,
              display: 'inline-block',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)',
              transition: 'transform 0.1s',
            }}>▶</span>
            <TypeBadge type={item?.type} />
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.04em' }}>{id} </span>
              <span style={{
                color: isDone ? 'var(--text-dim)' : 'var(--text)',
                fontSize: 12,
                textDecoration: isDone ? 'line-through' : 'none',
                textDecorationColor: 'var(--muted)',
              }}>{item?.title || '(no title)'}</span>
            </div>
            <StatusPill status={item?.status} onChange={onStatusChange ? (next) => onStatusChange(id, next) : undefined} />
          </button>
        </div>

        {isExpanded && item && (
                      <div style={{
                        padding: '16px 20px 16px 64px',
                        fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
                        color: 'var(--text)',
                      }}>
                        <ItemBody body={item.body || ''} />
                        <div style={{
                          display: 'flex', gap: 24, flexWrap: 'wrap',
                          padding: '8px 0', marginTop: 8,
                          borderTop: '1px solid var(--border-subtle)',
                          fontSize: 11, color: 'var(--text-dim)',
                        }}>
                          <Meta label="Type" value={item.type || '—'} />
                          <Meta label="Release" value={item.release || 'Unscheduled'} />
                          <Meta label="Depends on" value={item.depends_on?.length ? item.depends_on.join(', ') : '—'} />
                          {item.created && <Meta label="Created" value={item.created} />}
                          {item.cost_actual_usd != null && <Meta label="Cost" value={`$${item.cost_actual_usd.toFixed(2)}`} />}
                        </div>
                        {(item.prd || (item.companion_specs && item.companion_specs.length > 0)) && (
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {item.prd && (
                              <div>
                                <SpecButton
                                  label="Open PRD"
                                  emoji="📄"
                                  path={item.prd}
                                  onOpen={onOpenPRD}
                                />
                              </div>
                            )}
                            {item.companion_specs && item.companion_specs.length > 0 && (
                              <div>
                                <div style={{
                                  fontSize: 9, fontWeight: 700, color: 'var(--text-dim)',
                                  textTransform: 'uppercase', letterSpacing: '0.1em',
                                  marginTop: 4, marginBottom: 4,
                                }}>Companion specs</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                  {item.companion_specs.map(spec => (
                                    <SpecButton
                                      key={spec.path}
                                      label={specShortLabel(spec.path)}
                                      emoji={specEmoji(spec.path)}
                                      path={spec.path}
                                      pending={!spec.exists}
                                      onOpen={spec.exists ? onOpenPRD : undefined}
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--muted)' }}>
              Edits → existing project terminal: <Code>Edit issue {id}</Code>
            </div>
          </div>
        )}
      </div>
    )
  }
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11, color: active ? 'var(--accent)' : 'var(--text-dim)',
        padding: '4px 10px', borderRadius: 4,
        background: active ? 'var(--accent-dim)' : 'var(--surface2)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        cursor: 'pointer', fontFamily: 'var(--mono)',
      }}>
      {children}
    </button>
  )
}

function TypeBadge({ type }: { type?: string }) {
  const map: Record<string, { color: string; bg: string; letter: string }> = {
    Feature: { color: 'var(--accent2)', bg: 'rgba(139,92,246,0.15)', letter: 'F' },
    Bug:     { color: 'var(--red)',     bg: 'rgba(239,68,68,0.15)',  letter: 'B' },
    Task:    { color: 'var(--accent)',  bg: 'rgba(245,158,11,0.15)', letter: 'T' },
  }
  const m = type ? map[type] : null
  if (!m) return <span style={{ width: 24 }} />
  return (
    <span style={{
      width: 24, height: 24, borderRadius: 4,
      display: 'grid', placeItems: 'center',
      fontSize: 11, fontWeight: 700,
      color: m.color, background: m.bg, border: `1px solid ${m.color}`,
    }}>{m.letter}</span>
  )
}

// Status options offered in the change-status popover. Excludes legacy values
// (Ready / In Progress / In Review) — those still render correctly on existing
// items but new picks should use the current lifecycle. Also excludes 'Fixing':
// the bugfix workflow owns that transition (Backlog → Fixing → Done); picking it
// by hand would strand the bug with no run attached.
const STATUS_OPTIONS = ['Backlog', 'Drafted', 'Reviewed', 'Implemented', 'Done', 'Blocked']
const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  // Feature lifecycle (PRD-004 follow-up)
  'Backlog':     { color: 'var(--muted)',   bg: 'var(--surface2)' },
  'Drafted':     { color: 'var(--yellow)',  bg: 'rgba(234,179,8,0.15)' },
  'Reviewed':    { color: 'var(--accent2)', bg: 'rgba(139,92,246,0.15)' },
  'Implemented': { color: 'var(--accent)',  bg: 'rgba(245,158,11,0.15)' },
  'Done':        { color: 'var(--green)',   bg: 'rgba(34,197,94,0.15)' },
  'Blocked':     { color: 'var(--red)',     bg: 'rgba(239,68,68,0.15)' },
  // Bug lifecycle — set by the bugfix workflow, not the picker
  'Fixing':      { color: 'var(--accent)',  bg: 'rgba(245,158,11,0.15)' },
  // Legacy — still accepted on existing items until they're touched
  'Ready':       { color: 'var(--yellow)',  bg: 'rgba(234,179,8,0.15)' },
  'In Progress': { color: 'var(--accent)',  bg: 'rgba(245,158,11,0.15)' },
  'In Review':   { color: 'var(--accent2)', bg: 'rgba(139,92,246,0.15)' },
}

function StatusPill({ status, onChange }: {
  status?: string
  /** When provided, the pill becomes a button that opens a status-picker
   * popover. Clicking a status in the popover calls onChange(next) and
   * closes the popover. When omitted (e.g. DragOverlay preview), the pill
   * stays read-only. */
  onChange?: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close popover on outside-click + on Esc.
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const s = status && STATUS_COLORS[status] ? STATUS_COLORS[status] : { color: 'var(--muted)', bg: 'var(--surface2)' }
  const interactive = !!onChange

  const pillStyle: React.CSSProperties = {
    fontSize: 9, padding: '3px 8px', borderRadius: 999,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    fontWeight: 700, whiteSpace: 'nowrap',
    color: s.color, background: s.bg, border: `1px solid ${s.color}`,
    cursor: interactive ? 'pointer' : 'default',
    fontFamily: 'var(--mono)',
  }

  if (!interactive) {
    return <span style={pillStyle}>{status || '—'}</span>
  }

  return (
    // Wrapper div uses role/span instead of nested <button>s — the parent row
    // is already a <button onClick=toggle>, and nested buttons are invalid
    // HTML. stopPropagation prevents pill clicks from also toggling the row's
    // expanded state.
    <div
      ref={wrapRef}
      style={{ position: 'relative', display: 'inline-block' }}
      onClick={e => { e.stopPropagation() }}
    >
      <span
        role="button"
        tabIndex={0}
        title="Change status"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o) } }}
        style={pillStyle}
      >{status || '—'}</span>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0,
          zIndex: 10,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 6, padding: 4,
          boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
          display: 'flex', flexDirection: 'column', gap: 1,
          minWidth: 150, fontFamily: 'var(--mono)',
        }}>
          {STATUS_OPTIONS.map(opt => {
            const isCurrent = opt === status
            const m = STATUS_COLORS[opt]
            return (
              <span
                key={opt}
                role="button"
                tabIndex={isCurrent ? -1 : 0}
                aria-disabled={isCurrent}
                onClick={() => {
                  if (!isCurrent && onChange) onChange(opt)
                  setOpen(false)
                }}
                onKeyDown={e => {
                  if (isCurrent) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    if (onChange) onChange(opt)
                    setOpen(false)
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px', borderRadius: 4,
                  background: 'transparent',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  cursor: isCurrent ? 'default' : 'pointer',
                  textAlign: 'left',
                  opacity: isCurrent ? 0.55 : 1,
                  color: 'var(--text)',
                  userSelect: 'none',
                }}
                onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'var(--surface3)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: 999,
                  background: m.color, flexShrink: 0,
                }} />
                <span>{opt}</span>
                {isCurrent && <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>✓</span>}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span><b style={{ color: 'var(--text)', fontWeight: 500 }}>{label}</b> {value}</span>
  )
}

// Spec-type emoji + short label derived from filename prefix (QA, UX, SEC, etc.).
// Falls back to the full filename when the prefix isn't recognised.
const SPEC_PREFIX_META: Record<string, { emoji: string; label: string }> = {
  QA:  { emoji: '🧪', label: 'QA' },
  UX:  { emoji: '🎨', label: 'UX' },
  SEC: { emoji: '🔒', label: 'Security' },
  BR:  { emoji: '🏷', label: 'Brand' },
  MK:  { emoji: '📢', label: 'Marketing' },
  ADR: { emoji: '📐', label: 'ADR' },
}
function specPrefix(p: string): string | null {
  const file = p.split('/').pop() || ''
  const m = file.match(/^([A-Z]{2,5})-\d/)
  return m ? m[1] : null
}
function specShortLabel(p: string): string {
  const pref = specPrefix(p)
  const meta = pref && SPEC_PREFIX_META[pref]
  if (meta) return meta.label
  return (p.split('/').pop() || p).replace(/\.md$/, '')
}
function specEmoji(p: string): string {
  const pref = specPrefix(p)
  return (pref && SPEC_PREFIX_META[pref]?.emoji) || '📄'
}

function SpecButton({ label, emoji, path, onOpen, pending }: {
  label: string
  emoji: string
  path: string
  onOpen?: (p: string) => void
  /** When true, the spec is declared in the PRD's table but doesn't exist on
   * disk yet — show a "pending" pill and disable the click. Companion specs
   * are normally drafted during the review workflow, after the PRD itself. */
  pending?: boolean
}) {
  return (
    <button
      onClick={() => onOpen?.(path)}
      disabled={!onOpen || pending}
      title={pending ? `${path} — not on disk yet` : path}
      style={{
        padding: '4px 10px', borderRadius: 4,
        background: pending ? 'transparent' : 'var(--surface3)',
        color: pending ? 'var(--muted)' : 'var(--text)',
        border: `1px dashed ${pending ? 'var(--border)' : 'transparent'}`,
        borderColor: pending ? 'var(--border)' : 'var(--border)',
        borderStyle: pending ? 'dashed' : 'solid',
        fontFamily: 'var(--mono)', fontSize: 11,
        cursor: pending || !onOpen ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        maxWidth: '100%',
        opacity: pending ? 0.7 : 1,
      }}>
      <span>{emoji}</span> {label}
      <span style={{
        color: 'var(--muted)', fontSize: 10,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: 320,
      }}>{path}</span>
      {pending && (
        <span style={{
          fontSize: 8, fontWeight: 700,
          color: 'var(--yellow)', background: 'rgba(234,179,8,0.15)',
          border: '1px solid var(--yellow)',
          padding: '1px 5px', borderRadius: 3,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>pending</span>
      )}
    </button>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code style={{
      background: 'var(--surface3)', color: 'var(--accent)',
      padding: '1px 6px', borderRadius: 3, fontSize: 11, fontFamily: 'var(--mono)',
    }}>{children}</code>
  )
}

/**
 * Render the item body as JSX. Keeps formatting deliberately minimal —
 * H2 headings, bullet lists, inline `code`. No external markdown library
 * (avoids a dependency for what's mostly short structured content) and
 * no dangerouslySetInnerHTML (every node is rendered as a React element,
 * so user-controlled body text can't inject script).
 */
function ItemBody({ body }: { body: string }) {
  if (!body.trim()) return <div style={{ color: 'var(--muted)' }}>(no description)</div>
  const lines = body.split('\n')
  const out: React.ReactNode[] = []
  let listBuffer: string[] = []
  const flushList = () => {
    if (listBuffer.length === 0) return
    out.push(
      <ul key={`l${out.length}`} style={{ margin: '4px 0', paddingLeft: 18 }}>
        {listBuffer.map((l, i) => <li key={i} style={{ margin: '2px 0' }}><InlineMd text={l} /></li>)}
      </ul>
    )
    listBuffer = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^##\s+/.test(line)) {
      flushList()
      out.push(
        <div key={`h${out.length}`} style={{
          fontSize: 9, fontWeight: 700, color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.1em',
          marginTop: 12, marginBottom: 4,
        }}>{line.replace(/^##\s+/, '')}</div>
      )
    } else if (/^-\s+/.test(line)) {
      listBuffer.push(line.replace(/^-\s+/, ''))
    } else if (line === '') {
      flushList()
    } else {
      flushList()
      out.push(<p key={`p${out.length}`} style={{ margin: '4px 0' }}><InlineMd text={line} /></p>)
    }
  }
  flushList()
  return <>{out}</>
}

// Inline markdown: splits on backticks and emits <code> for the odd-index
// segments. JSX-only — no HTML strings, no innerHTML.
function InlineMd({ text }: { text: string }) {
  const parts = text.split('`')
  return (
    <>
      {parts.map((p, i) => i % 2 === 1 ? <Code key={i}>{p}</Code> : <span key={i}>{p}</span>)}
    </>
  )
}
