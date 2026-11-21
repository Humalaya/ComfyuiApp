import { useCallback, useEffect, useRef, useState } from 'react'
import { listDownloads, type ModelDownload } from '../api/modelsClient'

// The PC's download list, polled while `active`: every second while
// something is downloading, every 5 s otherwise (a download started from
// the other screen shows up). `onFinished` fires when one completes —
// for refreshing the model list / disk space.
export function useModelDownloads(active: boolean, onFinished?: () => void) {
  const [downloads, setDownloads] = useState<ModelDownload[]>([])
  const finished = useRef(onFinished)
  finished.current = onFinished
  const seenDone = useRef<Set<string> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await listDownloads()
      setDownloads(list)
      const done = new Set(list.filter((d) => d.status === 'done').map((d) => d.id))
      if (seenDone.current && [...done].some((id) => !seenDone.current!.has(id))) finished.current?.()
      seenDone.current = done
      return list
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let timer = 0
    let stopped = false
    const tick = async () => {
      const list = await refresh()
      if (stopped) return
      const busy = list?.some((d) => d.status === 'downloading')
      timer = window.setTimeout(tick, busy ? 1000 : 5000)
    }
    tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [active, refresh])

  return { downloads, refresh }
}
