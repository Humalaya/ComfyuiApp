import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMFY_BASE_URL,
  connectComfySocket,
  extractHistoryErrorMessage,
  getHistory,
  viewUrl,
  type ComfyWsMessage,
  type HistoryEntry,
  type HistoryOutputFile,
} from '../api/comfyClient'
import { notify } from '../native/notifications'
// Same shared native KeepAlive foreground service useComfyGeneration.ts
// (video) uses, routed through the coordinator since Video/SDXL/Krea2 can
// each have a job in flight at once — see keepAliveCoordinator.ts. This
// used to be entirely absent here (see the comment this replaces): a
// Text2Img job genuinely used to finish before the screen even had a chance
// to lock, but that stopped being true the moment a batch/queue made these
// runs long enough to background during too — and unlike a plain browser
// tab, this hook had *no* protection at all against the process being
// killed or the WiFi radio dropping to a power-save mode that resets the
// socket to ComfyUI, regardless of how long the job actually took.
import { holdKeepAlive, releaseKeepAlive } from '../native/keepAliveCoordinator'
import { clearRemoteJob, loadRemoteJob, type RemoteJob } from '../storage/remoteJobStorage'

// Lighter than useComfyGeneration.ts (video) in one real way: completion is
// decided purely by /history polling — the WebSocket subscription below is
// read-only decoration for live step progress/preview, never the source of
// truth for "done", so a missed or delayed WS message can never leave this
// hook stuck. It does now pull in the same KeepAlive protection video has
// (see the import above) and the same "recheck immediately when the app
// comes back to the foreground" handling, since a queued batch here can run
// just as long as a video one.
//
// It DOES now recover an in-flight job on mount (see the effect near the
// bottom) the same way useComfyGeneration.ts always has — a generation this
// hook started is just as real and just as easy to lose track of on a reload
// as a video one, it just used to not bother recovering it given how much
// shorter these usually run. The active-job pointer lives on the small
// output-server's shared PC-RAM store (remoteJobStorage.ts), not the phone's
// own storage, so recovery works even from a different device/browser.
//
// It subscribes to the same *shared* ComfyUI socket useComfyGeneration uses
// (see connectComfySocket's module-level manager in comfyClient.ts) rather
// than opening a second one — prompts are broadcast to every socket, so a
// second one would just deliver every message twice.
//
// Parameterized by outputNodeId rather than importing a single fixed
// workflow module — this is shared by every Text2Img-shaped screen (the SDXL
// one and the Krea2/FLUX one so far), which differ in which node saves the
// output, but not in how "follow → poll → done or error" works. Jobs are
// submitted by the output-server's queue dispatcher, never by this hook (see
// remoteQueueStorage.ts); `kind` is this instance's key in its
// /api/state/:kind/* store — 'sdxl' or 'krea2'.
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

// How often to ask the output-server whether it has started a job for this
// kind while nothing is being followed — see useComfyGeneration.ts.
const FOLLOW_MS = 2500

function extractImageFiles(outputs: Record<string, unknown>, outputNodeId: string): HistoryOutputFile[] {
  const nodeOutput = outputs[outputNodeId] as Record<string, HistoryOutputFile[]> | undefined
  if (!nodeOutput) return []
  return nodeOutput.images ?? nodeOutput.gifs ?? nodeOutput.videos ?? []
}

export function useImageGeneration(outputNodeId: string, kind: 'sdxl' | 'krea2') {
  const [state, setState] = useState<ImageGenState>(initialState)
  // Bumped on every terminal transition — lets a caller (each Create tab's
  // "recently finished" list) react to every settle, including two
  // back-to-back ones that land on the same status.
  const [settledCount, setSettledCount] = useState(0)
  const settle = useCallback((patch: Partial<ImageGenState>) => {
    setState({ ...initialState, ...patch })
    setSettledCount((c) => c + 1)
  }, [])

  const activePromptId = useRef<string | null>(null)
  const startTime = useRef<number | null>(null)
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  // This hook's own hold on the shared KeepAlive service — see
  // keepAliveCoordinator.ts. Non-null for exactly as long as a job of ours
  // is in flight (generate()/recovery through finish/fail/reset).
  const keepAliveToken = useRef<symbol | null>(null)
  // The last job this hook finished showing — see useComfyGeneration.ts.
  const lastSettledPromptId = useRef<string | null>(null)

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

  // Common teardown for every way a followed job ends.
  const endJob = useCallback(
    (promptId: string) => {
      activePromptId.current = null
      lastSettledPromptId.current = promptId
      stopTimers()
      releaseKeepAlive(keepAliveToken.current)
      keepAliveToken.current = null
      clearRemoteJob(kind, promptId)
    },
    [stopTimers, kind],
  )

  // If the user comes back to the tab mid-generation, check immediately
  // instead of waiting up to POLL_MS for the next scheduled poll — same
  // rationale as useComfyGeneration.ts's identical handler, and just as
  // relevant here now that a queued batch can run long enough to background
  // during.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && activePromptId.current) {
        pollOnce(activePromptId.current)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
    // pollOnce is defined further below as a stable useCallback; effect order
    // doesn't matter for a listener registered once and read via closure at
    // call time... except pollOnce itself isn't hoisted as a value the way a
    // function declaration would be. See the eslint-disable: this only ever
    // needs the *latest* pollOnce, not a re-subscribe every time it changes,
    // and pollOnce's own identity is stable across the hook's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // progress also says which node it's for. After the app is reopened
        // mid-generation, the 'executing' message for the node that's
        // already running went out before we were listening — so without
        // this, currentNodeId stayed null, every preview frame got dropped
        // by the gate below, and the "Adım X / Y" line (which lives inside
        // the preview) never appeared again until the next node started.
        const node = msg.data.node
        setState((s) =>
          s.status === 'running'
            ? { ...s, currentNodeId: node ?? s.currentNodeId, samplingProgress: { value: msg.data.value, max: msg.data.max } }
            : s,
        )
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
      endJob(promptId)
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
    [endJob, settle, outputNodeId],
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
      endJob(promptId)
      const error = extractHistoryErrorMessage(entry)
      settle({ status: 'error', error })
      notify('✗ Üretim hatası', error)
    },
    [endJob, settle],
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

  // Starts following a job the output-server submitted (or one already
  // running when the app was opened) — see useComfyGeneration.ts.
  const attach = useCallback(
    (job: RemoteJob) => {
      activePromptId.current = job.promptId
      startTime.current = job.startedAt
      setState({
        ...initialState,
        status: 'running',
        elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)),
      })
      releaseKeepAlive(keepAliveToken.current)
      keepAliveToken.current = holdKeepAlive({ comfyBaseUrl: COMFY_BASE_URL, promptId: job.promptId, videoNodeId: outputNodeId })

      stopTimers()
      tickInterval.current = setInterval(() => {
        setState((s) =>
          s.status === 'running'
            ? { ...s, elapsedSeconds: startTime.current !== null ? Math.round((Date.now() - startTime.current) / 1000) : s.elapsedSeconds }
            : s,
        )
      }, 1000)
      pollInterval.current = setInterval(() => {
        if (activePromptId.current) pollOnce(activePromptId.current)
      }, POLL_MS)
      // It may well have finished already (e.g. while the app was closed).
      pollOnce(job.promptId)
    },
    [stopTimers, pollOnce, outputNodeId],
  )

  const checking = useRef(false)
  const checkRemoteJob = useCallback(async () => {
    if (activePromptId.current || checking.current) return
    checking.current = true
    try {
      const job = await loadRemoteJob(kind)
      if (job && !activePromptId.current && job.promptId !== lastSettledPromptId.current) attach(job)
    } finally {
      checking.current = false
    }
  }, [attach, kind])

  useEffect(() => {
    checkRemoteJob()
    const timer = setInterval(checkRemoteJob, FOLLOW_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkRemoteJob()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      stopTimers()
    }
  }, [checkRemoteJob, stopTimers])

  const reset = useCallback(() => {
    if (activePromptId.current) endJob(activePromptId.current)
    settle({})
  }, [endJob, settle])

  return { ...state, settledCount, checkRemoteJob, reset }
}
