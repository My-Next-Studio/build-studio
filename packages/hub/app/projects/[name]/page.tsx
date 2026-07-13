import { notFound } from 'next/navigation'
import { ProjectView } from '@/components/project-view'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

  const { name } = await params
  const project = registry.get(name)
  if (!project) notFound()

  const status = await processManager.getStatus(name)

  // Fetch functions config from project-server for SSR
  let functionsConfig: Record<string, { enabled?: boolean }> | undefined
  let portalsConfig: Array<{ name: string; url: string }> | undefined
  if (status.running && status.health?.ok) {
    try {
      const res = await fetch(`http://localhost:${project.port}/api/status`, { cache: 'no-store' })
      const data = await res.json()
      functionsConfig = data.functions
      portalsConfig = data.portals
    } catch {}
  }

  return (
    <ProjectView
      key={project.name}
      name={project.name}
      path={project.path}
      port={project.port}
      running={status.running}
      health={status.health}
      functionsConfig={functionsConfig}
      portalsConfig={portalsConfig}
    />
  )
}
