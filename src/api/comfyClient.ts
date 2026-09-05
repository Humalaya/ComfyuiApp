// Thin wrapper around the ComfyUI REST + WebSocket API.
// All HTTP calls go through the Vite dev-server proxy (/comfy-api -> ComfyUI),
// so the browser never talks to the ComfyUI host directly (avoids CORS).

const API_BASE = '/comfy-api'
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comfy-ws`

// Direct (non-proxied) ComfyUI address — the browser normally never needs
// this (everything goes through the /comfy-api proxy above to dodge CORS),
// but the native Android KeepAlive service polls ComfyUI directly from Java
// while the WebView is backgrounded, so it needs the real address.
export const COMFY_BASE_URL: string = import.meta.env.VITE_COMFYUI_URL || 'http://192.168.1.65:8188'

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
  status?: { completed?: boolean; status_str?: string }
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

const WS_RECONNECT_DELAY_MS = 2000

// Mobile browsers routinely drop the underlying TCP connection when the
// screen locks or the tab is backgrounded (and plain WiFi/NAT hiccups can do
// the same even in the foreground) — without reconnecting, a single drop
// meant this app never received another progress/executing message for the
// rest of the page's lifetime. This keeps retrying until it's told to stop,
// so live progress resumes as soon as connectivity comes back; it's not the
// only safety net (useComfyGeneration also polls /history independently),
// but it's what makes the live "which step is running" display recover
// instead of going silent forever after the first drop.
export function connectComfySocket(onMessage: (msg: ComfyWsMessage) => void): () => void {
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function connect() {
    ws = new WebSocket(`${WS_BASE}?clientId=${clientId}`)
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data) as ComfyWsMessage
        onMessage(msg)
      } catch {
        // ignore non-JSON (binary preview frames etc.)
      }
    }
    ws.onclose = () => {
      if (stopped) return
      reconnectTimer = setTimeout(connect, WS_RECONNECT_DELAY_MS)
    }
    ws.onerror = () => {
      ws?.close() // ensures onclose (and therefore the reconnect scheduling) always runs
    }
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    ws?.close()
  }
}
