const ROLE_CONFIG: Record<string, { avatar: string; avatarImg: string; color: string }> = {
  'CEO':          { avatar: '🎯', avatarImg: 'ceo',          color: '#f5c518' },
  'PM':           { avatar: '📋', avatarImg: 'pm',           color: '#4a9eff' },
  'Brand':        { avatar: '🎨', avatarImg: 'brand',        color: '#ff7eb6' },
  'Marketing':    { avatar: '📣', avatarImg: 'marketing',    color: '#ff9f43' },
  'UX/UI':        { avatar: '✏️',  avatarImg: 'ux-ui',       color: '#a29bfe' },
  'UX':           { avatar: '✏️',  avatarImg: 'ux-ui',       color: '#a29bfe' },
  'Architect':    { avatar: '🏗️', avatarImg: 'architect',    color: '#74b9ff' },
  'DevOps':       { avatar: '⚙️', avatarImg: 'devops',       color: '#55efc4' },
  'QA/Security':  { avatar: '🛡️', avatarImg: 'qa-security',  color: '#fd79a8' },
  'QA':           { avatar: '🛡️', avatarImg: 'qa-security',  color: '#fd79a8' },
  'Security':     { avatar: '🔒', avatarImg: 'security',     color: '#e17055' },
  'Frontend Dev': { avatar: '💻', avatarImg: 'frontend-dev', color: '#6c5ce7' },
  'Backend Dev':  { avatar: '🖥️', avatarImg: 'backend-dev',  color: '#00b894' },
  'iOS Dev':      { avatar: '📱', avatarImg: 'mobile-dev',   color: '#5856d6' },
  'Android Dev':  { avatar: '📱', avatarImg: 'mobile-dev',   color: '#a4c639' },
  'Mobile Dev':   { avatar: '📱', avatarImg: 'mobile-dev',   color: '#5856d6' },
  'Code Review':  { avatar: '🔍', avatarImg: 'code-review',  color: '#e17055' },
  'Code Reviewer': { avatar: '🔍', avatarImg: 'code-review', color: '#e17055' },
  'Designer':     { avatar: '🖌️', avatarImg: 'designer',     color: '#e84393' },
}

// `default` resolves to the Build Studio app icon — used for any role without
// a dedicated avatar (e.g. Planner, Fix Planner, future roles).
const DEFAULT_CONFIG = { avatar: '🤖', avatarImg: 'default', color: '#4a5568' }

export function roleConfig(role: string) {
  return ROLE_CONFIG[role] || DEFAULT_CONFIG
}

export function avatarSrc(role: string, size: 44 | 88 = 44): string {
  const cfg = ROLE_CONFIG[role] || DEFAULT_CONFIG
  return `/avatars/${size}/${cfg.avatarImg}.png`
}
