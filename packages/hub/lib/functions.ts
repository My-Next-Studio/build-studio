export interface FunctionDefinition {
  id: string
  label: string
  /** Which views this function provides */
  views: ('overview' | 'workflow')[]
  /** Which workflow types are available in this function */
  workflowTypes: ('kickoff' | 'onboarding' | 'review' | 'execution' | 'bugfix')[]
  /** Tabs available in overview view (default: ['spec', 'status', 'agents']) */
  tabs?: string[]
  enabledByDefault: boolean
}

export interface PortalConfig {
  name: string
  url: string
}

export const BUILTIN_FUNCTIONS: FunctionDefinition[] = [
  {
    id: 'project',
    label: 'Project',
    views: ['overview', 'workflow'],
    workflowTypes: ['kickoff', 'onboarding'],
    tabs: ['spec', 'status', 'backlog', 'agents'],
    enabledByDefault: true,
  },
  {
    id: 'development',
    label: 'Development',
    views: ['workflow'],
    workflowTypes: ['review', 'execution', 'bugfix'],
    enabledByDefault: true,
  },
  {
    id: 'operations',
    label: 'Operations',
    views: ['overview'],
    workflowTypes: [],
    tabs: ['services', 'cicd', 'runbooks'],
    enabledByDefault: true,
  },
]

/** Maps workflow type → function id (used for notification attribution) */
export const WORKFLOW_TYPE_TO_FUNCTION: Record<string, string> = {
  kickoff: 'project',
  review: 'development',
  execution: 'development',
  bugfix: 'development',
}

/** Short labels for notification badges */
export const FUNCTION_SHORT_LABELS: Record<string, string> = {
  project: 'proj',
  development: 'dev',
  operations: 'ops',
}

/**
 * Resolve enabled functions from config overrides.
 * Config shape: { project: { enabled: true }, development: { enabled: true }, ... }
 * Portals add dynamic tabs to the operations function.
 */
export function resolveFunctions(
  configFunctions?: Record<string, { enabled?: boolean }>,
  portals?: PortalConfig[],
  operationsTabs?: Record<string, boolean>,
): FunctionDefinition[] {
  return BUILTIN_FUNCTIONS
    .filter(fn => {
      const override = configFunctions?.[fn.id]
      if (override && typeof override.enabled === 'boolean') return override.enabled
      return fn.enabledByDefault
    })
    .map(fn => {
      if (fn.id === 'operations') {
        const extras: string[] = []
        if (operationsTabs?.uitests) extras.push('uitests')
        if (portals && portals.length > 0) extras.push(...portals.map((_, i) => `portal-${i}`))
        if (extras.length > 0) return { ...fn, tabs: [...(fn.tabs || []), ...extras] }
      }
      return fn
    })
}
