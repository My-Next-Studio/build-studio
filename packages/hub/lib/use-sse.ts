'use client'

import { useEffect, useRef } from 'react'
import { useProject } from './project-context'

type SSEHandler = (event: string, data: Record<string, unknown>) => void

export function useSSE(onMessage: SSEHandler) {
  const { baseUrl } = useProject()
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage

  useEffect(() => {
    const source = new EventSource(`${baseUrl}/api/sse`)

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handlerRef.current(data.event, data)
      } catch {
        // ignore parse errors
      }
    }

    source.onerror = () => {
      // EventSource auto-reconnects
    }

    return () => source.close()
  }, [baseUrl])
}
