// Thin wrapper around the ComfyUI REST + WebSocket API.
// All HTTP calls go through the Vite dev-server proxy (/comfy-api -> ComfyUI),
// so the browser never talks to the ComfyUI host directly (avoids CORS).

const API_BASE = '/comfy-api'
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comfy-ws`

// Direct (non-proxied) ComfyUI address — the browser normally never needs
// this (everything goes through the /comfy-api proxy above to dodge CORS),
// but the native Android KeepAlive service polls ComfyUI directly from Java
// while the WebView is backgrounded, so it needs the real address.
export const COMFY_BASE_URL: string = import.meta.env.VITE_COMFYUI_URL || 'http://192.168.1.62:8188'

export interface QueuePromptResponse {
  prompt_id: string
  number: number
  node_errors: Record<string, unknown>
}

export interface UploadImageResponse {
  name: string
  subfolder: string
  type: string
}

export type ComfyWorkflow = Record<string, { inputs: Record<string, unknown>; class_type: string; _meta?: { title?: string } }>

// crypto.randomUUID() requires a secure context (https or localhost) in some
// browsers, but this app is served over plain http on a LAN IP for phones —
// so fall back to building a v4 UUID from crypto.getRandomValues(), which is
// available in insecure contexts too.
function generateUUID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function getClientId(): string {
  const key = 'comfy-mobile-client-id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = generateUUID()
    localStorage.setItem(key, id)
  }
  return id
}

export const clientId = getClientId()

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ComfyUI isteği başarısız (${res.status}): ${text || res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function queuePrompt(workflow: ComfyWorkflow): Promise<QueuePromptResponse> {
  const res = await fetch(`${API_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  })
  return asJson(res)
}

export async function uploadImage(file: File | Blob, filename: string): Promise<UploadImageResponse> {
  const form = new FormData()
  form.append('image', file, filename)
  form.append('overwrite', 'true')
  const res = await fetch(`${API_BASE}/upload/image`, { method: 'POST', body: form })
  return asJson(res)
}

export function viewUrl(filename: string, subfolder: string, type: string): string {
  const params = new URLSearchParams({ filename, subfolder, type })
  return `${API_BASE}/view?${params.toString()}`
}

// rgthree-comfy's own endpoint (not core ComfyUI): serves a lora's preview
// image if one exists alongside the .safetensors file (same basename, .png/
// .jpg/.jpeg) — this is how rgthree's own Power Lora Loader widget shows
// thumbnails. When there's no preview file it responds 200 with a small JSON
// body instead of image bytes (not a real 404), so this can't be checked via
// fetch status — callers just render it as an <img src> and handle the
// resulting decode failure via onError instead.
export function loraThumbnailUrl(loraName: string): string {
  return `${API_BASE}/rgthree/api/loras/img?file=${encodeURIComponent(loraName)}`
}

export async function getHistory(promptId: string): Promise<Record<string, HistoryEntry>> {
  const res = await fetch(`${API_BASE}/history/${promptId}`)
  return asJson(res)
}

export async function getRecentHistory(maxItems = 30): Promise<Record<string, HistoryEntry>> {
  const res = await fetch(`${API_BASE}/history?max_items=${maxItems}`)
  return asJson(res)
}

export async function getObjectInfo(classType?: string): Promise<Record<string, ObjectInfoEntry>> {
  const res = await fetch(classType ? `${API_BASE}/object_info/${encodeURIComponent(classType)}` : `${API_BASE}/object_info`)
  return asJson(res)
}

export async function interrupt(): Promise<void> {
  await fetch(`${API_BASE}/interrupt`, { method: 'POST' })
}

export interface HistoryOutputFile {
  filename: string
  subfolder: string
  type: string
  format?: string
}

export interface HistoryEntry {
  prompt: unknown[]
  outputs: Record<string, Record<string, HistoryOutputFile[] | unknown>>
  status?: {
    completed?: boolean
    // 'success' | 'error' — a node throwing mid-execution shows up here as
    // status_str: 'error' with completed staying false forever (ComfyUI
    // never flips it to true for a failed run) — see
    // extractHistoryErrorMessage below. A poll loop that only checks
    // `completed` misses this entirely and polls forever with nothing to
    // show for it.
    status_str?: string
    messages?: Array<[string, Record<string, unknown>]>
  }
}

// Pulls a human-readable message out of a /history entry that failed
// mid-execution (status_str === 'error') — the messages array carries an
// ['execution_error', {...}] tuple with the same shape as the WebSocket's
// own execution_error event (node_type, exception_message, ...).
export function extractHistoryErrorMessage(entry: HistoryEntry): string {
  const messages = entry.status?.messages ?? []
  const errorEntry = messages.find(([type]) => type === 'execution_error')
  const detail = errorEntry?.[1] as { node_type?: string; exception_message?: string } | undefined
  if (detail?.exception_message) {
    return detail.node_type ? `${detail.node_type}: ${detail.exception_message}` : detail.exception_message
  }
  return 'ComfyUI çalıştırma hatası'
}

export interface ObjectInfoEntry {
  input: {
    required?: Record<string, unknown[]>
    optional?: Record<string, unknown[]>
  }
}

// Best-effort extraction of a COMBO (dropdown) option list from an /object_info entry.
// Two shapes exist in the wild depending on which node schema the node author used:
//   legacy:  "field": [ ["opt1", "opt2"], { ...config } ]
//   V3/new:  "field": [ "COMBO", { options: ["opt1", "opt2"], ...config } ]
export function extractComboOptions(entry: ObjectInfoEntry | undefined, fieldName: string): string[] {
  if (!entry) return []
  const all = { ...(entry.input.required ?? {}), ...(entry.input.optional ?? {}) }
  const spec = all[fieldName]
  if (!Array.isArray(spec)) return []
  const [first, second] = spec
  if (Array.isArray(first)) return first as string[]
  if (first === 'COMBO' && second && typeof second === 'object' && Array.isArray((second as { options?: unknown }).options)) {
    return (second as { options: string[] }).options
  }
  return []
}

// ---- WebSocket progress tracking ----

export type ComfyWsMessage =
  | { type: 'status'; data: { status: { exec_info: { queue_remaining: number } } } }
  | { type: 'progress'; data: { value: number; max: number; prompt_id?: string; node?: string } }
  | { type: 'executing'; data: { node: string | null; prompt_id?: string } }
  | { type: 'executed'; data: { node: string; prompt_id: string; output: unknown } }
  | { type: 'execution_error'; data: { prompt_id: string; exception_message?: string } }
  | { type: 'execution_cached'; data: { nodes: string[]; prompt_id: string } }
  // A live, low-res snapshot of the currently-sampling (still noisy) latent,
  // decoded server-side (ComfyUI launched with --preview-method) and pushed
  // as a JPEG/PNG binary frame — see handleBinary below. ComfyUI's own
  // protocol doesn't attach a prompt_id to these, so a subscriber has to
  // gate on its own "is one of my nodes the one currently executing right
  // now" state instead (both useComfyGeneration and useImageGeneration do
  // this via their currentNodeId/isExecutingMine tracking). The blob URL is
  // revoked the moment a newer frame replaces it, so don't hold onto it past
  // the next message.
  | { type: 'preview'; data: { url: string } }

const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 30000

// 'reconnecting' covers both "actively waiting on a backoff timer" and
// "offline, waiting for the browser to tell us we're back" — the UI treats
// both the same way (don't panic, don't show fake progress, just wait).
export type ComfyConnectionStatus = 'connecting' | 'open' | 'reconnecting'

interface ComfySocketSubscriber {
  onMessage: (msg: ComfyWsMessage) => void
  onStatusChange?: (status: ComfyConnectionStatus) => void
}

interface ComfySocketManager {
  ws: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
  stopped: boolean
  offline: boolean
  subscribers: Set<ComfySocketSubscriber>
  lastPreviewUrl: string | null
}

// A single real WebSocket, shared by every subscriber — video's generation
// hook and every image-generation hook instance (SDXL, Krea2, ...) all want
// live progress/preview at once now, but ComfyUI keys its server-side socket
// registry by the `clientId` query param itself, not a fresh id per TCP
// connection: a second `new WebSocket(...)` opened with the same clientId
// silently steals delivery out from under the first (the server just
// overwrites its sockets[clientId] entry), so independent hooks each running
// their own connect-on-mount effect would race to "own" the one real
// connection instead of all seeing the same messages. This module-level
// singleton keeps exactly one socket alive and fans every message out to
// however many subscribers currently want it.
let manager: ComfySocketManager | null = null

function getManager(): ComfySocketManager {
  if (manager) return manager

  const m: ComfySocketManager = {
    ws: null,
    reconnectTimer: null,
    reconnectDelay: WS_RECONNECT_BASE_MS,
    stopped: false,
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    subscribers: new Set(),
    lastPreviewUrl: null,
  }
  manager = m

  function setStatus(status: ComfyConnectionStatus) {
    for (const sub of m.subscribers) sub.onStatusChange?.(status)
  }

  function broadcast(msg: ComfyWsMessage) {
    for (const sub of m.subscribers) sub.onMessage(msg)
  }

  // ComfyUI's binary preview frame: a 4-byte big-endian event type (1 =
  // PREVIEW_IMAGE — the only one that matters here), a 4-byte big-endian
  // image format tag (1 = JPEG, 2 = PNG), then the raw encoded image bytes.
  function handleBinary(buf: ArrayBuffer) {
    if (buf.byteLength < 8) return
    const view = new DataView(buf)
    const eventType = view.getUint32(0, false)
    if (eventType !== 1) return
    const imgType = view.getUint32(4, false)
    const mime = imgType === 2 ? 'image/png' : 'image/jpeg'
    const blob = new Blob([buf.slice(8)], { type: mime })
    // Only ever one live frame worth keeping around at a time — revoke the
    // previous one immediately so these don't pile up in memory over a long
    // generation with hundreds of steps.
    if (m.lastPreviewUrl) URL.revokeObjectURL(m.lastPreviewUrl)
    m.lastPreviewUrl = URL.createObjectURL(blob)
    broadcast({ type: 'preview', data: { url: m.lastPreviewUrl } })
  }

  function scheduleReconnect() {
    if (m.stopped || m.reconnectTimer !== null || m.offline) return
    setStatus('reconnecting')
    m.reconnectTimer = setTimeout(() => {
      m.reconnectTimer = null
      connect()
    }, m.reconnectDelay)
    m.reconnectDelay = Math.min(m.reconnectDelay * 2, WS_RECONNECT_MAX_MS)
  }

  // Mobile browsers routinely drop the underlying TCP connection when the
  // screen locks or the tab is backgrounded (and plain WiFi/NAT hiccups can
  // do the same even in the foreground) — a dropped connection (ECONNRESET
  // on the Vite proxy's side, visible in its terminal) is a normal, expected
  // event here, not a bug: this reconnects with exponential backoff (capped,
  // so a dead network doesn't cause a tight retry loop) and additionally
  // forces an immediate reconnect attempt on 'visibilitychange' (tab/app
  // foregrounded) and the 'online' event, since waiting out a stale backoff
  // timer after coming back is a worse experience than just trying right
  // away. connect() and forceReconnectNow() both check the current socket
  // state first, so a foreground event never opens a second socket on top of
  // one that's already open or mid-handshake.
  //
  // This is not the only safety net — useComfyGeneration/useImageGeneration
  // also independently poll /history and treat that (not the WS) as the
  // source of truth for whether a generation actually finished. This is only
  // responsible for live progress/preview and for not doing anything
  // alarming when the network hiccups.
  function connect() {
    if (m.stopped || m.offline) return
    if (m.ws && (m.ws.readyState === WebSocket.OPEN || m.ws.readyState === WebSocket.CONNECTING)) return

    setStatus('connecting')
    const ws = new WebSocket(`${WS_BASE}?clientId=${clientId}`)
    ws.binaryType = 'arraybuffer'
    m.ws = ws
    ws.onopen = () => {
      m.reconnectDelay = WS_RECONNECT_BASE_MS
      setStatus('open')
    }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleBinary(ev.data)
        return
      }
      if (typeof ev.data !== 'string') return
      try {
        broadcast(JSON.parse(ev.data) as ComfyWsMessage)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (m.stopped) return
      scheduleReconnect()
    }
    ws.onerror = () => {
      ws.close() // ensures onclose (and therefore the reconnect scheduling) always runs
    }
  }

  // Cuts a pending backoff wait short — used when we have a real signal
  // (tab foregrounded, browser says we're back online) that now is a good
  // time to try again, rather than whatever arbitrary delay was left.
  function forceReconnectNow() {
    if (m.stopped || m.offline) return
    if (m.ws && (m.ws.readyState === WebSocket.OPEN || m.ws.readyState === WebSocket.CONNECTING)) return
    if (m.reconnectTimer !== null) {
      clearTimeout(m.reconnectTimer)
      m.reconnectTimer = null
    }
    m.reconnectDelay = WS_RECONNECT_BASE_MS
    connect()
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') forceReconnectNow()
  }
  function onOnline() {
    m.offline = false
    forceReconnectNow()
  }
  function onOffline() {
    // No point burning battery retrying a socket while the browser itself
    // reports no network — wait for the 'online' event instead.
    m.offline = true
    if (m.reconnectTimer !== null) {
      clearTimeout(m.reconnectTimer)
      m.reconnectTimer = null
    }
    setStatus('reconnecting')
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  connect()

  return m
}

// Subscribes to the one shared ComfyUI WebSocket connection (see getManager
// above) — safe to call from as many hook instances as are mounted at once,
// each gets every message. Returns an unsubscribe function; the underlying
// connection itself is deliberately never torn down on unsubscribe (this
// app never unmounts its generation tabs, so there's nothing to gain from
// closing and reopening it) — only delivery to this particular caller stops.
export function connectComfySocket(onMessage: (msg: ComfyWsMessage) => void, onStatusChange?: (status: ComfyConnectionStatus) => void): () => void {
  const m = getManager()
  const sub: ComfySocketSubscriber = { onMessage, onStatusChange }
  m.subscribers.add(sub)
  // A subscriber joining after the shared socket is already open (or still
  // connecting) would otherwise never hear about that — the status change
  // that got it there already fired for whoever was subscribed at the time.
  onStatusChange?.(m.ws?.readyState === WebSocket.OPEN ? 'open' : 'connecting')
  return () => {
    m.subscribers.delete(sub)
  }
}
