import { NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'

/**
 * Initialize a folder as a Build Studio project.
 *
 * A folder that already holds files (commonly a repository with the brief in
 * docs/inputs/) is checked first: a dirty working tree is refused, so is a
 * symbolic link on the way to any file init writes, and if init
 * would replace, merge or move any existing file, the caller gets the list
 * (409, needsConfirm) and must send `confirm: true` to go ahead.
 */
export async function POST(req: Request) {
  const { name, dirPath, port, confirm } = await req.json()

  if (!name || !dirPath) {
    return NextResponse.json({ error: 'name and dirPath required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { paths: sharedPaths } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const targetPath: string = sharedPaths.resolveUserPath(dirPath)
  const configPath = path.join(targetPath, '.build-studio', 'config.yaml')

  if (fs.existsSync(configPath)) {
    return NextResponse.json({ error: 'Project already initialized at this path' }, { status: 409 })
  }

  // Dynamic requires to prevent Turbopack from tracing filesystem operations in these modules
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { scaffoldProject, planScaffold } = require(/* turbopackIgnore: true */ '@build-studio/project-server/lib/scaffold')

  if (fs.existsSync(targetPath)) {
    let plan: { existingRepo: boolean; branch: string | null; dirty: string[]; symlinks: string[]; changes:{ path: string; action: string; note: string }[] }
    try {
      plan = planScaffold(targetPath)
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
    if (plan.dirty.length) {
      return NextResponse.json({
        error: `${targetPath} is a git repository with uncommitted changes. Commit or stash them first, so init commits only its own files.`,
        dirty: plan.dirty.slice(0, 20),
      }, { status: 409 })
    }
    if (plan.symlinks.length) {
      return NextResponse.json({
        error: 'Init would write through a symbolic link, possibly outside the folder. Replace each link with a real file or folder, or remove it, then try again.',
        symlinks: plan.symlinks,
      }, { status: 409 })
    }
    if (plan.changes.length && !confirm) {
      return NextResponse.json({
        needsConfirm: true,
        error: 'Init would change existing files in this folder.',
        changes: plan.changes,
        existingRepo: plan.existingRepo,
        branch: plan.branch,
      }, { status: 409 })
    }
  }

  const assignedPort = port || registry.nextAvailablePort()

  try {
    const result = scaffoldProject(targetPath, { name, port: assignedPort })
    registry.add(name, targetPath, assignedPort)
    return NextResponse.json({ ok: true, name, path: targetPath, port: assignedPort, warnings: result?.warnings || [] })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const code = (e as { code?: string })?.code
    return NextResponse.json({ error: message }, { status: code === 'DIRTY_TREE' || code === 'SYMLINK' ? 409 : 500 })
  }
}
