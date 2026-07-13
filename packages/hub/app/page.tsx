import { HomeTabs } from '@/components/home-tabs'
import { ProjectWithStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ onboarding?: string }>
}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

  processManager.reconcile()

  const projects = registry.list()
  const projectsWithStatus: ProjectWithStatus[] = await Promise.all(
    projects.map(async (p: { name: string; path: string; port: number; addedAt: string }) => {
      const status = await processManager.getStatus(p.name)
      return { ...p, status }
    })
  )

  projectsWithStatus.sort((a: ProjectWithStatus, b: ProjectWithStatus) => {
    const aRunning = a.status?.running ? 0 : 1
    const bRunning = b.status?.running ? 0 : 1
    if (aRunning !== bRunning) return aRunning - bRunning
    return a.name.localeCompare(b.name)
  })

  const sp = await searchParams
  const showOnboarding = sp.onboarding === '1'

  return <HomeTabs projects={projectsWithStatus} showOnboarding={showOnboarding} />
}
