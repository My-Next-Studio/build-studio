'use client'

import { useProject } from './project-context'
import { useCallback, useMemo } from 'react'

async function safeJson(res: Response) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return {} }
}

export function useProjectApi() {
  const { baseUrl } = useProject()

  const get = useCallback(
    async (path: string) => {
      const res = await fetch(`${baseUrl}/api${path}`)
      return safeJson(res)
    },
    [baseUrl]
  )

  const post = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return safeJson(res)
    },
    [baseUrl]
  )

  const put = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}/api${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return safeJson(res)
    },
    [baseUrl]
  )

  const patch = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}/api${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return safeJson(res)
    },
    [baseUrl]
  )

  const del = useCallback(
    async (path: string) => {
      const res = await fetch(`${baseUrl}/api${path}`, { method: 'DELETE' })
      return safeJson(res)
    },
    [baseUrl]
  )

  // Stable reference — only changes when baseUrl changes
  return useMemo(() => ({ get, post, put, patch, del }), [get, post, put, patch, del])
}
