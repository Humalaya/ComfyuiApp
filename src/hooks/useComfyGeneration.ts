import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMFY_BASE_URL,
  connectComfySocket,
  extractHistoryErrorMessage,
  getHistory,
  cancelPrompt,
  viewUrl,
  type ComfyConnectionStatus,
  type ComfyWsMessage,
  type HistoryEntry,
  type HistoryOutputFile,
} from '../api/comfyClient'
import { VIDEO_OUTPUT_NODE_ID } from '../workflow/fieldMap'
// Routed through the coordinator (not keepAlive.ts directly) — Video, SDXL
// and Krea2 can all have a job running at once, and the native service is a
// single shared resource; see keepAliveCoordinator.ts for why a plain
// start()/stop() per hook would let one tab's completion kill another's
// still-running background protection.
import { holdKeepAlive, releaseKeepAlive } from '../native/keepAliveCoordinator'
import { notify } from '../native/notifications'
import { clearRemoteJob, loadRemoteJob, type RemoteJob } from '../storage/remoteJobStorage'

// This kind's key in the output-server's shared /api/state/:kind/* store —
// see remoteJobStorage.ts for why that's PC RAM now, not phone localStorage.
const KIND = 'video'

export type GenerationStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'

export interface GenerationResult {
  promptId: string
  // Every file this job's output node saved — MiniMaxH3ImageToVideo has no
  // native batch support (checked via /object_info) so this is normally
  // just one, but kept as an array for the same reason the image workflows
  // need one: a single job can genuinely produce several files.
  urls: string[]
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
  // A live low-res snapshot of the currently-sampling (still noisy) latent —
  // only present while `currentNodeId` is a node of this job's own prompt
  // (see the WS handler's 'preview' branch), so a preview belonging to some
  // other prompt ComfyUI happens to be executing right now never leaks in.
  previewUrl: string | null
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
  // True right after a job was resumed from storage on page load — we know
  // *that* a generation is running (recovered from a persisted prompt_id,
  // see remoteJobStorage.ts) but not the fine-grained per-node progress,
  // since that only ever lived in memory and didn't survive the reload. Showing a
  // fake 0% bar here would be misleading, so the UI shows a neutral
  // "reconnecting" message instead until either a live WS update arrives or
  // the /history poll finds it already finished.
  recovering: boolean
}

const initialState: GenerationState = {
  status: 'idle',
  currentNodeId: null,
  currentNodeTitle: null,
  totalNodeCount: 0,
  executedNodeCount: 0,
  samplingProgress: null,
  previewUrl: null,
  elapsedSeconds: 0,
  totalElapsedSeconds: null,
  eta: null,
  error: null,
  result: null,
  connectionLost: false,
  recovering: false,
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

// How often to ask the output-server whether it has started a job for this
// kind while nothing is being followed here. Jobs are submitted by the
// server's own queue dispatcher (server/index.js), never by this hook — so
// the app picks up queued jobs even after having been backgrounded or
// closed while the server worked through the queue.
const FOLLOW_MS = 2500

// A job older than this when first picked up was already running before we
// were watching: its early progress messages were missed, so the UI shows a
// neutral "reconnecting" state rather than a misleading 0% bar.
const FRESH_JOB_MS = 15000

function extractVideoFiles(outputs: Record<string, unknown>): HistoryOutputFile[] {
  const nodeOutput = outputs[VIDEO_OUTPUT_NODE_ID] as Record<string, HistoryOutputFile[]> | undefined
  if (!nodeOutput) return []
  return nodeOutput.gifs ?? nodeOutput.videos ?? nodeOutput.images ?? []
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
  // Kept separate from GenerationState (rather than a field on it) because
  // every terminal transition (done/error/reset/cancel) replaces the whole
  // state with `{ ...initialState, ... }` — folding this in would mean that
  // every one of those spots would need to remember to carry it forward, and
  // "wsStatus resets to 'connecting' just because a generation finished" is
  // wrong (the socket itself didn't go anywhere).
  const [wsStatus, setWsStatus] = useState<ComfyConnectionStatus>('connecting')
  // Bumped on every terminal transition (done/error/idle), in addition to
  // `status` itself changing. A caller (App.tsx's queue-drain effect) that
  // only watches `status` misses back-to-back settles that land on the same
  // value — e.g. two queued jobs failing in a row both end at 'error', which
  // is not a *change* React would re-fire an effect for, so the second queued
  // item would never get picked up and the rest of the queue would silently
  // stop advancing. This counter changes every single time, so watching it
  // alongside `status` can't miss one.
  const [settledCount, setSettledCount] = useState(0)

  const settle = useCallback((patch: Partial<GenerationState>) => {
    setState({ ...initialState, ...patch })
    setSettledCount((c) => c + 1)
  }, [])

  const activePromptId = useRef<string | null>(null)
  const nodeTitles = useRef<Record<string, string>>({})
  const executedNodeIds = useRef<Set<string>>(new Set())
  const startTime = useRef<number | null>(null)
  const samplingPhaseStart = useRef<number | null>(null)
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const consecutivePollFailures = useRef(0)
  // This hook's own hold on the shared KeepAlive service — see
  // keepAliveCoordinator.ts. Non-null for exactly as long as a job of ours
  // is in flight (generate()/recovery through finish/fail/reset/cancel).
  const keepAliveToken = useRef<symbol | null>(null)
  // The last job this hook finished showing — the server keeps reporting it
  // until our clear reaches it, and it must not be picked up a second time.
  const lastSettledPromptId = useRef<string | null>(null)

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

  // Common teardown for every way a followed job ends.
  const endJob = useCallback(
    (promptId: string) => {
      activePromptId.current = null
      lastSettledPromptId.current = promptId
      stopTicking()
      releaseKeepAlive(keepAliveToken.current)
      keepAliveToken.current = null
      clearRemoteJob(KIND, promptId)
    },
    [stopTicking],
  )

  // Shared by the WS "finished" event and the /history poll fallback below —
  // whichever notices completion first wins; the guard on activePromptId
  // stops the other from double-processing the same result.
  const finishFromHistory = useCallback(
    (promptId: string, entry: HistoryEntry) => {
      if (activePromptId.current !== promptId) return
      endJob(promptId)
      const elapsedSeconds = startTime.current !== null ? Math.round((Date.now() - startTime.current) / 1000) : 0
      const files = extractVideoFiles(entry.outputs)
      if (files.length > 0) {
        settle({
          status: 'done',
          totalElapsedSeconds: elapsedSeconds,
          result: { promptId, urls: files.map((f) => viewUrl(f.filename, f.subfolder, f.type)), createdAt: Date.now() },
        })
        notify('✓ Üretim tamamlandı', `Video hazır (${elapsedSeconds} sn).`)
      } else {
        const error = 'Çıktı bulunamadı (workflow beklenmedik şekilde sonuçlandı).'
        settle({ status: 'error', error })
        notify('✗ Üretim hatası', error)
      }
    },
    [settle, endJob],
  )

  // A node throwing mid-execution never makes ComfyUI set completed: true —
  // it stays false forever with status_str: 'error' instead. Normally the
  // WS 'execution_error' listener below catches this immediately, but if
  // the socket happens to be down/reconnecting right at that moment (the
  // exact scenario all of this hook's reconnect logic exists for), this
  // /history-only path was the only thing left checking — and it only ever
  // looked at `completed`, so it would've kept polling this same failed
  // entry forever with nothing ever shown to the user. Mirrors the identical
  // fix in useImageGeneration.ts.
  const failFromHistory = useCallback(
    (promptId: string, entry: HistoryEntry) => {
      if (activePromptId.current !== promptId) return
      endJob(promptId)
      const error = extractHistoryErrorMessage(entry)
      settle({ status: 'error', error })
      notify('✗ Üretim hatası', error)
    },
    [settle, endJob],
  )

  const pollHistoryOnce = useCallback(
    async (promptId: string) => {
      try {
        const history = await getHistory(promptId)
        consecutivePollFailures.current = 0
        setState((s) => (s.connectionLost ? { ...s, connectionLost: false } : s))
        const entry = history[promptId]
        if (entry?.status?.completed) {
          finishFromHistory(promptId, entry)
        } else if (entry?.status?.status_str === 'error') {
          failFromHistory(promptId, entry)
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
    [finishFromHistory, failFromHistory],
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
    const disconnect = connectComfySocket(
      (msg: ComfyWsMessage) => {
        const promptId = activePromptId.current
        if (!promptId) return

        if (msg.type === 'progress' && msg.data.prompt_id === promptId) {
          if (samplingPhaseStart.current === null) samplingPhaseStart.current = Date.now()
          const progress = { value: msg.data.value, max: msg.data.max }
          // progress also names its node — after a reopen mid-generation it's
          // the first message that tells us which node is running (the
          // 'executing' for it went out before we were listening), and
          // currentNodeId is what lets this job's preview frames through.
          const node = msg.data.node
          setState((s) => ({
            ...s,
            status: 'running',
            recovering: false,
            currentNodeId: node ?? s.currentNodeId,
            currentNodeTitle: node ? (nodeTitles.current[node] ?? s.currentNodeTitle ?? node) : s.currentNodeTitle,
            samplingProgress: progress,
            eta: computeEta(progress, samplingPhaseStart.current),
          }))
        } else if (msg.type === 'execution_cached' && msg.data.prompt_id === promptId) {
          // These nodes are skipped (inputs unchanged from a previous run) but
          // are still "done" for progress-counting purposes — without this the
          // overall progress bar looked stuck near 0% on a mostly-cached run.
          for (const nodeId of msg.data.nodes) executedNodeIds.current.add(nodeId)
          setState((s) => ({ ...s, status: 'running', recovering: false, executedNodeCount: executedNodeIds.current.size }))
        } else if (msg.type === 'executing' && msg.data.prompt_id === promptId) {
          if (msg.data.node === null) {
            getHistory(promptId)
              .then((history) => {
                const entry = history[promptId]
                if (entry) {
                  finishFromHistory(promptId, entry)
                } else {
                  const error = 'Çıktı bulunamadı (workflow beklenmedik şekilde sonuçlandı).'
                  endJob(promptId)
                  settle({ status: 'error', error })
                  notify('✗ Üretim hatası', error)
                }
              })
              .catch((err) => {
                const error = (err as Error).message
                endJob(promptId)
                settle({ status: 'error', error })
                notify('✗ Üretim hatası', error)
              })
          } else {
            const nodeId = msg.data.node
            executedNodeIds.current.add(nodeId)
            samplingPhaseStart.current = null // new node — any previous sampling progress no longer applies
            setState((s) => ({
              ...s,
              status: 'running',
              recovering: false,
              currentNodeId: nodeId,
              currentNodeTitle: nodeTitles.current[nodeId] ?? nodeId,
              executedNodeCount: executedNodeIds.current.size,
              samplingProgress: null,
              eta: null,
            }))
          }
        } else if (msg.type === 'preview') {
          // No prompt_id on these frames (see ComfyWsMessage's 'preview'
          // case) — currentNodeId is only non-null while a node of *this*
          // prompt is the one actually executing right now, which is the
          // closest available proxy for "this preview is mine".
          setState((s) => (s.currentNodeId !== null ? { ...s, previewUrl: msg.data.url } : s))
        } else if (msg.type === 'execution_error' && msg.data.prompt_id === promptId) {
          const error = msg.data.exception_message ?? 'ComfyUI çalıştırma hatası'
          endJob(promptId)
          settle({ status: 'error', error })
          notify('✗ Üretim hatası', error)
        }
      },
      (status) => setWsStatus(status),
    )
    return disconnect
  }, [endJob, finishFromHistory, settle])

  // Starts following a job the output-server submitted (or one already
  // running when the app was opened): progress via the shared WebSocket,
  // completion via /history polling, background notification via KeepAlive.
  const attach = useCallback(
    (job: RemoteJob) => {
      const fresh = Date.now() - job.startedAt < FRESH_JOB_MS
      activePromptId.current = job.promptId
      startTime.current = job.startedAt
      nodeTitles.current = job.titles ?? {}
      executedNodeIds.current = new Set()
      samplingPhaseStart.current = null
      consecutivePollFailures.current = 0

      setState({
        ...initialState,
        status: fresh ? 'queued' : 'running',
        recovering: !fresh,
        totalNodeCount: job.nodeCount,
        elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)),
      })
      releaseKeepAlive(keepAliveToken.current)
      keepAliveToken.current = holdKeepAlive({ comfyBaseUrl: COMFY_BASE_URL, promptId: job.promptId, videoNodeId: VIDEO_OUTPUT_NODE_ID })

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
      pollInterval.current = setInterval(() => {
        if (activePromptId.current) pollHistoryOnce(activePromptId.current)
      }, HISTORY_POLL_MS)
      // It may well have finished already (e.g. while the app was closed).
      pollHistoryOnce(job.promptId)
    },
    [stopTicking, pollHistoryOnce],
  )

  // Asks the server whether it is on a job we aren't following yet. Called
  // on a timer, on returning to the app, and right after queuing something.
  const checking = useRef(false)
  const checkRemoteJob = useCallback(async () => {
    if (activePromptId.current || checking.current) return
    checking.current = true
    try {
      const job = await loadRemoteJob(KIND)
      if (job && !activePromptId.current && job.promptId !== lastSettledPromptId.current) attach(job)
    } finally {
      checking.current = false
    }
  }, [attach])

  useEffect(() => {
    checkRemoteJob()
    const timer = setInterval(checkRemoteJob, FOLLOW_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkRemoteJob()
    }
    document.addEventListener('visibilitychange', onVisible)
    // The cleanup matters under StrictMode (which this app runs in, see
    // main.tsx): its mount → cleanup → mount must not leave a second timer.
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      stopTicking()
    }
  }, [checkRemoteJob, stopTicking])

  const reset = useCallback(() => {
    if (activePromptId.current) endJob(activePromptId.current)
    settle({})
  }, [endJob, settle])

  // Stops the running job; the server's dispatcher then moves on to the
  // next queued one by itself.
  const cancel = useCallback(async () => {
    const promptId = activePromptId.current
    try {
      if (promptId) await cancelPrompt(promptId)
    } finally {
      if (promptId) endJob(promptId)
      settle({})
    }
  }, [endJob, settle])

  return { ...state, wsStatus, settledCount, checkRemoteJob, reset, cancel }
}
