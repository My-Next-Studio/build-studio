import { NextResponse } from 'next/server'

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const { name } = await params

  if (!registry.get(name)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Stop a running project server first so removal doesn't orphan it.
  try {
    await processManager.stopProject(name)
  } catch {
    // Best-effort: a server that was never started (or already dead) is fine.
  }

  // Drafting and the owner interview run in tmux sessions of their own, which
  // stopping the server leaves running. Close them too. Best effort.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { closeProjectSessions } = require(/* turbopackIgnore: true */ '@build-studio/project-server/lib/project-sessions')
    closeProjectSessions(name)
  } catch {
    // A missing tmux or an older bundle must not block removal.
  }

  const removed = registry.remove(name)
  if (!removed) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
