import { useCallback, useEffect, useState } from 'react'
import type { ComfyWorkflow } from '../api/comfyClient'

// The "waiting to run" queue for one generation kind ('video' | 'sdxl' |
// 'krea2') lives on the PC's output-server (server/index.js,
// /api/state/:kind/queue), and the server is also what *runs* it: when
// ComfyUI goes idle it submits the next item itself. This used to be the
// app's job, so a locked phone or a backgrounded app (Android freezes its
// JS) left the queue stalled until the app was opened again.
//
// The app therefore never overwrites the list wholesale — it only appends
// and removes by id, and polls for the current state. (Saving its own copy
// back would resurrect items the server already started.)

export interface QueueEntry<T> {
  id: string
  settings: T
}

export interface QueueState<T> {
  items: QueueEntry<T>[]
  // Whether the server could reach ComfyUI on its last try — while false,
  // waiting items just wait (the server keeps retrying).
  comfyUp: boolean
  // A queued item ComfyUI refused; it was dropped.
  error: { message: string; at: number } | null
}

const POLL_MS = 3000

function parse<T>(data: unknown, normalize: (raw: unknown) => T): QueueState<T> {
  const d = (data ?? {}) as { items?: unknown; comfyUp?: unknown; error?: QueueState<T>['error'] }
  const items: QueueEntry<T>[] = []
  for (const raw of Array.isArray(d.items) ? d.items : []) {
    const entry = raw as { id?: unknown; settings?: unknown }
    if (typeof entry?.id !== 'string') continue
    try {
      // One argument on purpose — every normalizer takes an optional second
      // `defaults` parameter, which an index from Array.map would land in.
      items.push({ id: entry.id, settings: normalize(entry.settings) })
    } catch {
      // An outdated/corrupt entry still runs on the server; it just can't be
      // shown with its prompt here — skip it in the list.
    }
  }
  return { items, comfyUp: d.comfyUp !== false, error: d.error ?? null }
}

async function request<T>(url: string, init: RequestInit | undefined, normalize: (raw: unknown) => T): Promise<QueueState<T>> {
  const res = await fetch(url, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `İstek başarısız (${res.status})`)
  return parse(data, normalize)
}

export function useRemoteQueue<T>(kind: string, normalize: (raw: unknown) => T) {
  const [state, setState] = useState<QueueState<T>>({ items: [], comfyUp: true, error: null })

  const refresh = useCallback(async () => {
    try {
      setState(await request(`/api/state/${kind}/queue`, undefined, normalize))
    } catch {
      // server restarting / network hiccup — the next poll retries
    }
    // normalize is a module-level function at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // Throws on failure, so the caller can tell the user nothing was queued.
  const append = useCallback(
    async (items: { settings: T; workflow: ComfyWorkflow }[]) => {
      setState(
        await request(
          `/api/state/${kind}/queue`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) },
          normalize,
        ),
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind],
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        setState(await request(`/api/state/${kind}/queue/${encodeURIComponent(id)}`, { method: 'DELETE' }, normalize))
      } catch {
        refresh()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, refresh],
  )

  const dismissError = useCallback(async () => {
    setState((s) => ({ ...s, error: null }))
    fetch(`/api/state/${kind}/queue-error`, { method: 'DELETE' }).catch(() => {})
  }, [kind])

  return { queue: state.items, comfyUp: state.comfyUp, queueError: state.error, append, remove, dismissError }
}
