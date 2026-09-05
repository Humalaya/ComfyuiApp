import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMFY_BASE_URL,
  connectComfySocket,
  getHistory,
  interrupt,
  queuePrompt,
  viewUrl,
  type ComfyWorkflow,
  type ComfyWsMessage,
  type HistoryEntry,
  type HistoryOutputFile,
} from '../api/comfyClient'
import { buildWorkflow, VIDEO_OUTPUT_NODE_ID, type GenerationSettings } from '../workflow/fieldMap'
import { startKeepAlive, stopKeepAlive } from '../native/keepAlive'
import { notify } from '../native/notifications'

export type GenerationStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'

export interface GenerationResult {
  promptId: string
  url: string
  createdAt: number
}

export interface SamplingProgress {
  value: number
  max: number
}

// ETA is only meaningful once we have a couple of sampling steps to measure a
// rate from — 'calculating' before that, so we never show a number invented
// from a single noisy data point.
export type Eta = number | 'calculating' | null

interface GenerationState {
  status: GenerationStatus
  currentNodeId: string | null
  currentNodeTitle: string | null
  totalNodeCount: number
  executedNodeCount: number
  samplingProgress: SamplingProgress | null
  elapsedSeconds: number
  totalElapsedSeconds: number | null
  eta: Eta
  error: string | null
  result: GenerationResult | null
  // True once a few consecutive /history polls have failed in a row — a
  // strong signal ComfyUI itself is down/unreachable, not just a single
  // dropped request. Purely informational (the poll keeps retrying either
  // way); this only drives the in-app warning shown while the screen is on.
  connectionLost: boolean
}

const initialState: GenerationState = {
  status: 'idle',
  currentNodeId: null,
  currentNodeTitle: null,
  totalNodeCount: 0,
  executedNodeCount: 0,
  samplingProgress: null,
  elapsedSeconds: 0,
  totalElapsedSeconds: null,
  eta: null,
  error: null,
  result: null,
  connectionLost: false,
}

// How many consecutive failed /history polls (5s apart, see HISTORY_POLL_MS)
// before treating it as "ComfyUI is unreachable" rather than one transient
// blip.
const CONNECTION_LOST_THRESHOLD = 3

// A real generation on this workflow can take several minutes (a lot of
// nodes are "execution_cached" and skipped, but the actual sampling isn't).
// Over that long a stretch, mobile browsers routinely suspend WebSocket
// connections and JS timers once the screen locks or the tab is backgrounded
// — so the WS-delivered "finished" event can simply never arrive. This
// interval polls ComfyUI's own /history as a safety net so completion is
// always eventually detected even if every WS message was missed.
const HISTORY_POLL_MS = 5000

function extractVideoFile(outputs: Record<string, unknown>): HistoryOutputFile | null {
  const nodeOutput = outputs[VIDEO_OUTPUT_NODE_ID] as Record<string, HistoryOutputFile[]> | undefined
  if (!nodeOutput) return null
  const files = nodeOutput.gifs ?? nodeOutput.videos ?? nodeOutput.images
  return files && files.length > 0 ? files[0] : null
}

function computeEta(progress: SamplingProgress | null, phaseStart: number | null): Eta {
  if (!progress || phaseStart === null) return null
  if (progress.value < 2) return 'calculating'
  const elapsedPhase = (Date.now() - phaseStart) / 1000
  const rate = elapsedPhase / progress.value // seconds per step
  const remainingSteps = Math.max(progress.max - progress.value, 0)
  return Math.max(0, Math.round(rate * remainingSteps))
}

export function useComfyGeneration() {
  const [state, setState] = useState<GenerationState>(initialState)

  const activePromptId = useRef<string | null>(null)
  const nodeTitles = useRef<Record<string, string>>({})
  const executedNodeIds = useRef<Set<string>>(new Set())
  const startTime = useRef<number | null>(null)
  const samplingPhaseStart = useRef<number | null>(null)
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const consecutivePollFailures = useRef(0)

  const stopTicking = useCallback(() => {
    if (tickInterval.current !== null) {
      clearInterval(tickInterval.current)
      tickInterval.current = null
    }
    if (pollInterval.current !== null) {
      clearInterval(pollInterval.current)
      pollInterval.current = null
    }
  }, [])

  useEffect(() => stopTicking, [stopTicking])

  // Shared by the WS "finished" event and the /history poll fallback below —
  // whichever notices completion first wins; the guard on activePromptId
  // stops the other from double-processing the same result.
  const finishFromHistory = useCallback(
    (promptId: string, entry: HistoryEntry) => {
      if (activePromptId.current !== promptId) return
      activePromptId.current = null
      stopTicking()
      stopKeepAlive()
      const elapsedSeconds = startTime.current !== null ? Math.round((Date.now() - startTime.current) / 1000) : 0
      const file = extractVideoFile(entry.outputs)
      if (file) {
        setState({
          ...initialState,
          status: 'done',
          totalElapsedSeconds: elapsedSeconds,
          result: { promptId, url: viewUrl(file.filename, file.subfolder, file.type), createdAt: Date.now() },
        })
        notify('✓ Üretim tamamlandı', `Video hazır (${elapsedSeconds} sn).`)
      } else {
        const error = 'Çıktı bulunamadı (workflow beklenmedik şekilde sonuçlandı).'
        setState({ ...initialState, status: 'error', error })
        notify('✗ Üretim hatası', error)
      }
    },
    [stopTicking],
  )

  const pollHistoryOnce = useCallback(
    async (promptId: string) => {
      try {
        const history = await getHistory(promptId)
        consecutivePollFailures.current = 0
        setState((s) => (s.connectionLost ? { ...s, connectionLost: false } : s))
        const entry = history[promptId]
        if (entry && entry.status?.completed) {
          finishFromHistory(promptId, entry)
        }
      } catch {
        // transient network error — the next tick (or the WS path) will retry,
        // but a few in a row means ComfyUI is probably actually down.
        consecutivePollFailures.current += 1
        if (consecutivePollFailures.current >= CONNECTION_LOST_THRESHOLD) {
          setState((s) => (s.connectionLost ? s : { ...s, connectionLost: true }))
        }
      }
    },
    [finishFromHistory],
  )

  // If the user comes back to the tab mid-generation, check immediately
  // instead of waiting up to HISTORY_POLL_MS for the next scheduled poll.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && activePromptId.current) {
        pollHistoryOnce(activePromptId.current)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [pollHistoryOnce])

  useEffect(() => {
    const disconnect = connectComfySocket((msg: ComfyWsMessage) => {
      const promptId = activePromptId.current
      if (!promptId) return

      if (msg.type === 'progress' && msg.data.prompt_id === promptId) {
        if (samplingPhaseStart.current === null) samplingPhaseStart.current = Date.now()
        const progress = { value: msg.data.value, max: msg.data.max }
        setState((s) => ({ ...s, status: 'running', samplingProgress: progress, eta: computeEta(progress, samplingPhaseStart.current) }))
      } else if (msg.type === 'execution_cached' && msg.data.prompt_id === promptId) {
        // These nodes are skipped (inputs unchanged from a previous run) but
        // are still "done" for progress-counting purposes — without this the
        // overall progress bar looked stuck near 0% on a mostly-cached run.
        for (const nodeId of msg.data.nodes) executedNodeIds.current.add(nodeId)
        setState((s) => ({ ...s, status: 'running', executedNodeCount: executedNodeIds.current.size }))
      } else if (msg.type === 'executing' && msg.data.prompt_id === promptId) {
        if (msg.data.node === null) {
          getHistory(promptId)
            .then((history) => {
              const entry = history[promptId]
              if (entry) {
                finishFromHistory(promptId, entry)
              } else {
                const error = 'Çıktı bulunamadı (workflow beklenmedik şekilde sonuçlandı).'
                activePromptId.current = null
                stopTicking()
                stopKeepAlive()
                setState({ ...initialState, status: 'error', error })
                notify('✗ Üretim hatası', error)
              }
            })
            .catch((err) => {
              const error = (err as Error).message
              activePromptId.current = null
              stopTicking()
              stopKeepAlive()
              setState({ ...initialState, status: 'error', error })
              notify('✗ Üretim hatası', error)
            })
        } else {
          const nodeId = msg.data.node
          executedNodeIds.current.add(nodeId)
          samplingPhaseStart.current = null // new node — any previous sampling progress no longer applies
          setState((s) => ({
            ...s,
            status: 'running',
            currentNodeId: nodeId,
            currentNodeTitle: nodeTitles.current[nodeId] ?? nodeId,
            executedNodeCount: executedNodeIds.current.size,
            samplingProgress: null,
            eta: null,
          }))
        }
      } else if (msg.type === 'execution_error' && msg.data.prompt_id === promptId) {
        const error = msg.data.exception_message ?? 'ComfyUI çalıştırma hatası'
        activePromptId.current = null
        stopTicking()
        stopKeepAlive()
        setState({ ...initialState, status: 'error', error })
        notify('✗ Üretim hatası', error)
      }
    })
    return disconnect
  }, [stopTicking, finishFromHistory])

  const generate = useCallback(
    async (settings: GenerationSettings) => {
      let workflow: ComfyWorkflow
      try {
        workflow = buildWorkflow(settings)
      } catch (err) {
        setState({ ...initialState, status: 'error', error: (err as Error).message })
        return
      }

      nodeTitles.current = Object.fromEntries(Object.entries(workflow).map(([id, node]) => [id, node._meta?.title || node.class_type]))
      executedNodeIds.current = new Set()
      samplingPhaseStart.current = null
      startTime.current = Date.now()
      consecutivePollFailures.current = 0

      setState({ ...initialState, status: 'queued', totalNodeCount: Object.keys(workflow).length })
      startKeepAlive()

      stopTicking()
      tickInterval.current = setInterval(() => {
        setState((s) => {
          if (s.status !== 'queued' && s.status !== 'running') return s
          return {
            ...s,
            elapsedSeconds: startTime.current !== null ? Math.round((Date.now() - startTime.current) / 1000) : s.elapsedSeconds,
            eta: computeEta(s.samplingProgress, samplingPhaseStart.current),
          }
        })
      }, 1000)

      try {
        const res = await queuePrompt(workflow)
        if (res.node_errors && Object.keys(res.node_errors).length > 0) {
          throw new Error('Workflow doğrulama hatası: ' + JSON.stringify(res.node_errors))
        }
        activePromptId.current = res.prompt_id
        // Re-arm the keep-alive service now that the prompt id is known, so
        // its native poll loop can track this specific generation and still
        // notify even if the WebView gets frozen while backgrounded.
        startKeepAlive({ comfyBaseUrl: COMFY_BASE_URL, promptId: res.prompt_id, videoNodeId: VIDEO_OUTPUT_NODE_ID })
        pollInterval.current = setInterval(() => {
          if (activePromptId.current) pollHistoryOnce(activePromptId.current)
        }, HISTORY_POLL_MS)
      } catch (err) {
        stopTicking()
        stopKeepAlive()
        setState({ ...initialState, status: 'error', error: (err as Error).message })
      }
    },
    [stopTicking, pollHistoryOnce],
  )

  const reset = useCallback(() => {
    stopTicking()
    stopKeepAlive()
    activePromptId.current = null
    setState(initialState)
  }, [stopTicking])

  const cancel = useCallback(async () => {
    try {
      await interrupt()
    } finally {
      stopTicking()
      stopKeepAlive()
      activePromptId.current = null
      setState(initialState)
    }
  }, [stopTicking])

  return { ...state, generate, reset, cancel }
}
