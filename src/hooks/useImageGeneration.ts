import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectComfySocket,
  extractHistoryErrorMessage,
  getHistory,
  queuePrompt,
  viewUrl,
  type ComfyWorkflow,
  type ComfyWsMessage,
  type HistoryEntry,
  type HistoryOutputFile,
} from '../api/comfyClient'
import { notify } from '../native/notifications'

// Deliberately much lighter than useComfyGeneration.ts (video): image
// generations here finish in seconds, not minutes, so the phone is
// realistically still in the user's hand/foregrounded for the whole thing —
// none of the video hook's background-survival machinery (WS reconnect,
// reload recovery via localStorage, the native KeepAlive foreground service,
// queueing) is pulled in for this first version. Completion is still decided
// purely by /history polling, same as before — the WebSocket subscription
// added below is read-only decoration for live step progress/preview, never
// the source of truth for "done", so a missed or delayed WS message can
// never leave this hook stuck.
//
// It subscribes to the same *shared* ComfyUI socket useComfyGeneration uses
// (see connectComfySocket's module-level manager in comfyClient.ts) rather
// than opening a second one — ComfyUI keys its socket registry by the
// clientId query param, so two independent `new WebSocket(...)` calls under
// the same id would just steal delivery from one another.
//
// Generic over the settings type and parameterized by buildWorkflow/
// outputNodeId rather than importing a single fixed workflow module —
// this is shared by every Text2Img-shaped screen (the SDXL one and the
// Krea2/FLUX one so far), which differ in their settings shape and which
// node actually saves the output, but not in how "submit → poll → done or
// error" works.
export type ImageGenStatus = 'idle' | 'running' | 'done' | 'error'

export interface ImageGenerationResult {
  promptId: string
  // Every file this job's output node saved — batchSize > 1 means several.
  urls: string[]
  createdAt: number
}

export interface ImageSamplingProgress {
  value: number
  max: number
}

interface ImageGenState {
  status: ImageGenStatus
  // Which node is currently executing for *this* job's prompt — the only
  // purpose this serves is gating incoming 'preview' WS frames (which carry
  // no prompt_id of their own) so a preview belonging to some other prompt
  // ComfyUI happens to be running right now never gets shown here.
  currentNodeId: string | null
  samplingProgress: ImageSamplingProgress | null
  previewUrl: string | null
  elapsedSeconds: number
  totalElapsedSeconds: number | null
  error: string | null
  result: ImageGenerationResult | null
}

const initialState: ImageGenState = {
  status: 'idle',
  currentNodeId: null,
  samplingProgress: null,
  previewUrl: null,
  elapsedSeconds: 0,
  totalElapsedSeconds: null,
  error: null,
  result: null,
}

const POLL_MS = 1500

function extractImageFiles(outputs: Record<string, unknown>, outputNodeId: string): HistoryOutputFile[] {
  const nodeOutput = outputs[outputNodeId] as Record<string, HistoryOutputFile[]> | undefined
  if (!nodeOutput) return []
  return nodeOutput.images ?? nodeOutput.gifs ?? nodeOutput.videos ?? []
}

export function useImageGeneration<T>(buildWorkflow: (settings: T) => ComfyWorkflow, outputNodeId: string) {
  const [state, setState] = useState<ImageGenState>(initialState)
  // Bumped on every terminal transition, same reason as
  // useComfyGeneration.ts's identical field: a caller draining a queue by
  // watching `status` alone would miss two back-to-back failures that both
  // land on 'error' (not a value *change*), silently stalling the rest of
  // the queue.
  const [settledCount, setSettledCount] = useState(0)
  const settle = useCallback((patch: Partial<ImageGenState>) => {
    setState({ ...initialState, ...patch })
    setSettledCount((c) => c + 1)
  }, [])

  const activePromptId = useRef<string | null>(null)
  const startTime = useRef<number | null>(null)
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTimers = useCallback(() => {
    if (tickInterval.current !== null) {
      clearInterval(tickInterval.current)
      tickInterval.current = null
    }
    if (pollInterval.current !== null) {
      clearInterval(pollInterval.current)
      pollInterval.current = null
    }
  }, [])

  // Live step progress + preview only — purely decorative (see the header
  // comment above), completion is still decided by the /history poll below
  // regardless of whether any of these messages ever arrive.
  useEffect(() => {
    const disconnect = connectComfySocket((msg: ComfyWsMessage) => {
      const promptId = activePromptId.current
      if (!promptId) return

      if (msg.type === 'executing' && msg.data.prompt_id === promptId) {
        setState((s) => (s.status === 'running' ? { ...s, currentNodeId: msg.data.node, samplingProgress: null } : s))
      } else if (msg.type === 'progress' && msg.data.prompt_id === promptId) {
        setState((s) => (s.status === 'running' ? { ...s, samplingProgress: { value: msg.data.value, max: msg.data.max } } : s))
      } else if (msg.type === 'preview') {
        // No prompt_id on these frames — currentNodeId being non-null (i.e.
        // one of this job's own nodes is the one actually executing right
        // now) is the closest available proxy for "this preview is mine".
        setState((s) => (s.currentNodeId !== null ? { ...s, previewUrl: msg.data.url } : s))
      }
    })
    return disconnect
  }, [])

  const finishFromHistory = useCallback(
    (promptId: string, entry: HistoryEntry) => {
      if (activePromptId.current !== promptId) return
      activePromptId.current = null
      stopTimers()
      const elapsedSeconds = startTime.current !== null ? Math.round((Date.now() - startTime.current) / 1000) : 0
      const files = extractImageFiles(entry.outputs, outputNodeId)
      if (files.length > 0) {
        settle({
          status: 'done',
          totalElapsedSeconds: elapsedSeconds,
          result: { promptId, urls: files.map((f) => viewUrl(f.filename, f.subfolder, f.type)), createdAt: Date.now() },
        })
        notify('✓ Görsel hazır', `Üretim tamamlandı (${elapsedSeconds} sn).`)
      } else {
        const error = 'Çıktı bulunamadı (workflow beklenmedik şekilde sonuçlandı).'
        settle({ status: 'error', error })
        notify('✗ Üretim hatası', error)
      }
    },
    [stopTimers, settle, outputNodeId],
  )

  // A node throwing mid-execution never makes ComfyUI set completed: true —
  // it stays false forever with status_str: 'error' instead. A poll that
  // only checked `completed` would retry this exact history entry forever,
  // leaving the UI stuck on "Oluşturuluyor…" with no error ever shown (this
  // is exactly what happened: a bad checkpoint file crashed CLIPSetLastLayer,
  // and nothing here noticed).
  const failFromHistory = useCallback(
    (promptId: string, entry: HistoryEntry) => {
      if (activePromptId.current !== promptId) return
      activePromptId.current = null
      stopTimers()
      const error = extractHistoryErrorMessage(entry)
      settle({ status: 'error', error })
      notify('✗ Üretim hatası', error)
    },
    [stopTimers, settle],
  )

  const pollOnce = useCallback(
    async (promptId: string) => {
      try {
        const history = await getHistory(promptId)
        const entry = history[promptId]
        if (!entry) return
        if (entry.status?.completed) {
          finishFromHistory(promptId, entry)
        } else if (entry.status?.status_str === 'error') {
          failFromHistory(promptId, entry)
        }
      } catch {
        // transient network error — the next tick retries
      }
    },
    [finishFromHistory, failFromHistory],
  )

  const generate = useCallback(
    async (settings: T) => {
      let workflow: ComfyWorkflow
      try {
        workflow = buildWorkflow(settings)
      } catch (err) {
        settle({ status: 'error', error: (err as Error).message })
        return
      }

      startTime.current = Date.now()
      setState({ ...initialState, status: 'running' })

      stopTimers()
      tickInterval.current = setInterval(() => {
        setState((s) =>
          s.status === 'running'
            ? { ...s, elapsedSeconds: startTime.current !== null ? Math.round((Date.now() - startTime.current) / 1000) : s.elapsedSeconds }
            : s,
        )
      }, 1000)

      try {
        const res = await queuePrompt(workflow)
        if (res.node_errors && Object.keys(res.node_errors).length > 0) {
          throw new Error('Workflow doğrulama hatası: ' + JSON.stringify(res.node_errors))
        }
        activePromptId.current = res.prompt_id
        pollInterval.current = setInterval(() => {
          if (activePromptId.current) pollOnce(activePromptId.current)
        }, POLL_MS)
      } catch (err) {
        stopTimers()
        settle({ status: 'error', error: (err as Error).message })
      }
    },
    [stopTimers, pollOnce, settle, buildWorkflow],
  )

  const reset = useCallback(() => {
    stopTimers()
    activePromptId.current = null
    settle({})
  }, [stopTimers, settle])

  return { ...state, settledCount, generate, reset }
}
