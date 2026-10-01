import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMFY_BASE_URL,
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
import { holdKeepAlive, releaseKeepAlive, updateKeepAlive } from '../native/keepAliveCoordinator'
import { clearRemoteJob, loadRemoteJob, saveRemoteJob } from '../storage/remoteJobStorage'

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
// Generic over the settings type and parameterized by buildWorkflow/
// outputNodeId rather than importing a single fixed workflow module —
// this is shared by every Text2Img-shaped screen (the SDXL one and the
// Krea2/FLUX one so far), which differ in their settings shape and which
// node actually saves the output, but not in how "submit → poll → done or
// error" works. `kind` is just this instance's key in the output-server's
// /api/state/:kind/job store — 'sdxl' or 'krea2'.
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

export function useImageGeneration<T>(buildWorkflow: (settings: T) => ComfyWorkflow, outputNodeId: string, kind: 'sdxl' | 'krea2') {
  const [state, setState] = useState<ImageGenState>(initialState)
  // Bumped on every terminal transition, same reason as
  // useComfyGeneration.ts's identical field: a caller draining a queue by
  // watching `status` alone would miss two back-to-back failures that both
  // land on 'error' (not a value *change*), silently stalling the rest of
  // the queue.
  const [settledCount, setSettledCount] = useState(0)
  // False until the mount-time job-recovery check below has actually run
  // (whether or not it found anything) — see useComfyGeneration.ts's
  // identical field for the full rationale. Without this, a caller (each
  // Create tab's queue-drain effect) can't tell "genuinely idle, nothing was
  // ever running" apart from "idle because recovery hasn't reported back
  // yet" from `status` alone, and could start a queued job on a false idle
  // moments before this hook's own recovery settles a leftover job to
  // 'done' — two overlapping generate() calls stepping on the same shared
  // refs, with one of them silently losing track of its own submission
  // (this is exactly what let queued Krea2/SDXL jobs vanish without ever
  // reaching ComfyUI after a background process kill).
  const [recoveryChecked, setRecoveryChecked] = useState(false)
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
      activePromptId.current = null
      stopTimers()
      releaseKeepAlive(keepAliveToken.current)
      keepAliveToken.current = null
      clearRemoteJob(kind)
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
    [stopTimers, settle, outputNodeId, kind],
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
      releaseKeepAlive(keepAliveToken.current)
      keepAliveToken.current = null
      clearRemoteJob(kind)
      const error = extractHistoryErrorMessage(entry)
      settle({ status: 'error', error })
      notify('✗ Üretim hatası', error)
    },
    [stopTimers, settle, kind],
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
      keepAliveToken.current = holdKeepAlive()

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
        // So a page reload (screen lock, closing the phone entirely, a
        // different device) can recover this generation instead of losing
        // track of it — see the mount-time recovery effect below.
        saveRemoteJob(kind, res.prompt_id, startTime.current ?? Date.now())
        // Re-point the keep-alive service's poll/notify target now that the
        // prompt id is known — doesn't touch the hold acquired above.
        updateKeepAlive({ comfyBaseUrl: COMFY_BASE_URL, promptId: res.prompt_id, videoNodeId: outputNodeId })
        pollInterval.current = setInterval(() => {
          if (activePromptId.current) pollOnce(activePromptId.current)
        }, POLL_MS)
      } catch (err) {
        stopTimers()
        releaseKeepAlive(keepAliveToken.current)
        keepAliveToken.current = null
        // activePromptId.current was never set in this branch — ComfyUI
        // never got this prompt at all (most likely it's unreachable) — so
        // there's nothing to clear from the remote job store.
        settle({ status: 'error', error: (err as Error).message })
      }
    },
    [stopTimers, pollOnce, settle, buildWorkflow, kind, outputNodeId],
  )

  const reset = useCallback(() => {
    stopTimers()
    releaseKeepAlive(keepAliveToken.current)
    keepAliveToken.current = null
    clearRemoteJob(kind)
    activePromptId.current = null
    settle({})
  }, [stopTimers, settle, kind])

  // Recovers a generation that was still running when the page was torn
  // down — same rationale as useComfyGeneration.ts's identical recovery
  // effect (see remoteJobStorage.ts for why this now works across a phone
  // reboot or a different device, not just a same-device reload). No
  // separate "recovering" status here: unlike the video tab, this hook never
  // showed fine-grained per-node progress to begin with, so "running" with
  // elapsed time already ticking from the real start is exactly what a
  // recovered job looks like too.
  useEffect(() => {
    // Guards a job resolving into an already-cleaned-up effect instance —
    // see useComfyGeneration.ts's identical guard for the full StrictMode
    // double-invoke rationale.
    let cancelled = false

    loadRemoteJob(kind).then((job) => {
      if (cancelled) return
      setRecoveryChecked(true)
      if (!job) return

      activePromptId.current = job.promptId
      startTime.current = job.startedAt

      setState({
        ...initialState,
        status: 'running',
        elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)),
      })
      // Fresh hold — nothing was held yet in this brand-new hook instance.
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

      // Resolve immediately instead of waiting up to POLL_MS — the job may
      // well have already finished while the page was gone.
      pollOnce(job.promptId)
    })

    return () => {
      cancelled = true
      stopTimers()
    }
    // Mount-only by design (recovery happens once, right after the hook is
    // first used) — pollOnce/stopTimers are stable useCallbacks, kind is
    // fixed per instance (SDXL and Krea2 tabs each mount their own).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { ...state, settledCount, recoveryChecked, generate, reset }
}
