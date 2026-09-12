// Client for the output-server's /api/system/* routes — the "Ayarlar" tab's
// three controls: llama-swap model on/off, the ComfyUI start-all.sh stack,
// and machine power-off. Same base/proxy as outputsClient.ts (Vite forwards
// /api to server/index.js); unrelated to the ComfyUI REST API.

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body as { error?: string } | null)?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

export interface SwapModel {
  id: string
  name: string
  // 'ready' | 'loading' | 'starting' | 'stopped' | ... — passed through from
  // llama-swap's /running as-is, so treat anything unrecognized as "on".
  state: string
  running: boolean
}

export interface SwapModelsResponse {
  url: string
  models: SwapModel[]
}

export function fetchSwapModels(): Promise<SwapModelsResponse> {
  return fetch('/api/system/models').then((r) => asJson<SwapModelsResponse>(r))
}

export function loadSwapModel(id: string): Promise<{ ok: true }> {
  return fetch(`/api/system/models/${encodeURIComponent(id)}/load`, { method: 'POST' }).then((r) => asJson(r))
}

export function unloadSwapModel(id: string): Promise<{ ok: true }> {
  return fetch(`/api/system/models/${encodeURIComponent(id)}/unload`, { method: 'POST' }).then((r) => asJson(r))
}

export interface StartAllStatus {
  script: string
  // A copy this server started and is still tracking — only such a copy can
  // be stopped from here.
  running: boolean
  pid?: number
  startedAt?: number
  // Bare port probes, independent of who started what: ComfyUI's listen port
  // and the Vite dev server's.
  comfyUp: boolean
  panelUp: boolean
}

export function fetchStartAllStatus(): Promise<StartAllStatus> {
  return fetch('/api/system/start-all').then((r) => asJson<StartAllStatus>(r))
}

export function startStack(): Promise<{ ok: true; pid: number }> {
  return fetch('/api/system/start-all/start', { method: 'POST' }).then((r) => asJson(r))
}

export function stopStack(): Promise<{ ok: true }> {
  return fetch('/api/system/start-all/stop', { method: 'POST' }).then((r) => asJson(r))
}

export function shutdownMachine(): Promise<{ ok: true }> {
  return fetch('/api/system/shutdown', { method: 'POST' }).then((r) => asJson(r))
}
