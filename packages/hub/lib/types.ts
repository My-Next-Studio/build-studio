export interface Project {
  name: string
  path: string
  port: number
  addedAt: string
}

export interface ProjectStatus {
  running: boolean
  pid?: number
  port?: number
  startedAt?: string
  health?: {
    ok: boolean
    name: string
    projectRoot: string
    uptime: number
    startedAt: string
  } | null
  reason?: string
}

export interface ProjectWithStatus extends Project {
  status: ProjectStatus | null
}
