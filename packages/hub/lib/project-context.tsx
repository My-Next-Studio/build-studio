'use client'

import { createContext, useContext, useMemo } from 'react'

interface ProjectContextValue {
  name: string
  port: number
  baseUrl: string
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function ProjectProvider({
  name,
  port,
  children,
}: {
  name: string
  port: number
  children: React.ReactNode
}) {
  const value = useMemo(
    () => ({ name, port, baseUrl: `http://localhost:${port}` }),
    [name, port]
  )
  return <ProjectContext value={value}>{children}</ProjectContext>
}

export function useProject() {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject must be used within ProjectProvider')
  return ctx
}
