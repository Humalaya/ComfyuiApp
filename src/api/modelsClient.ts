// Client for server/models.js — Civitai model info, PC-side downloads, the
// Modeller view (list / move / delete / preview picture) and disk space.
import { loadQwenEditSettings } from '../storage/qwenEditSettingsStorage'
import { loadImageSettings } from '../storage/imageSettingsStorage'
import { loadKrea2Settings } from '../storage/krea2SettingsStorage'
import { loadSettings } from '../storage/settingsStorage'

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body as { error?: string } | null)?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
    asJson<T>(r),
  )
}

// --- Civitai model page -----------------------------------------------------

export interface CivitaiModelFile {
  id: number
  name: string
  type: string | null // Model, VAE, Training Data…
  bytes: number
  format: string | null // SafeTensor, GGUF, PickleTensor…
  fp: string | null
  size: string | null // pruned / full
  primary: boolean
  allowed: boolean // .safetensors / .gguf only
  local: string | null // already on the PC: "models/loras/x.safetensors" / "İndirilenler/x"
  jobId: string | null
}

export interface CivitaiModelVersion {
  id: number
  name: string
  baseModel: string | null
  publishedAt: string | null
  availability: string // Public, EarlyAccess, …
  earlyAccessEndsAt: string | null
  trainedWords: string[]
  description: string
  cover: string | null
  downloads: number
  files: CivitaiModelFile[]
}

export interface CivitaiModel {
  id: number
  name: string
  type: string
  nsfw: boolean
  creator: string | null
  tags: string[]
  downloads: number
  likes: number
  description: string
  versions: CivitaiModelVersion[]
}

export function fetchCivitaiModel(ref: { versionId?: number; modelId?: number }): Promise<CivitaiModel> {
  const params = new URLSearchParams()
  if (ref.modelId) params.set('modelId', String(ref.modelId))
  else if (ref.versionId) params.set('versionId', String(ref.versionId))
  return fetch(`/api/civitai/model?${params}`).then((r) => asJson<CivitaiModel>(r))
}

// --- Downloads -----------------------------------------------------------

export interface ModelDownload {
  id: string
  versionId: number
  fileId: number
  modelId: number
  modelName: string
  versionName: string
  modelType: string | null
  name: string
  bytes: number
  received: number
  speed: number // bytes/s
  status: 'downloading' | 'done' | 'error' | 'canceled'
  // While downloading: "bağlantı koptu, … devam", "Doğrulanıyor…",
  // "Panel yeniden başladı…" — null when it's just running.
  note: string | null
  error: string | null
  startedAt: number
}

export function listDownloads(): Promise<ModelDownload[]> {
  return fetch('/api/models/downloads').then((r) => asJson<ModelDownload[]>(r))
}

export function startDownload(versionId: number, fileId: number): Promise<ModelDownload> {
  return postJson<ModelDownload>('/api/models/downloads', { versionId, fileId })
}

// Cancels a running download; removes a finished / failed one from the list.
export function removeDownload(id: string): Promise<unknown> {
  return fetch(`/api/models/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => asJson(r))
}

// --- Local models ------------------------------------------------------------

export type ModelArea = 'models' | 'downloads'

export interface LocalModel {
  area: ModelArea
  path: string // relative to the area: "loras/Krea2/x.safetensors" / "x.safetensors"
  size: number
  mtimeMs: number
  preview: number | null // picture's mtime (cache-buster), null = none
  protectedBy: string[] | null // tabs whose template loads it
  civitai: { modelId: number | null; versionId: number } | null
}

export interface ModelListing {
  models: LocalModel[]
  downloads: LocalModel[]
  folders: string[] // every folder under models/, for the move picker
  downloadDir: string
}

export function listModels(): Promise<ModelListing> {
  return fetch('/api/models').then((r) => asJson<ModelListing>(r))
}

// What the tabs have selected right now, as ComfyUI names them
// ("Video/x.safetensors") — those are locked too, not only the templates'
// defaults (see server/models.js protectedBy).
export function modelsInUse(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const add = (name: string | undefined, tab: string) => {
    if (name) out[name] = [...new Set([...(out[name] ?? []), tab])]
  }
  try {
    add(loadSettings()?.unetName, 'Video')
    add(loadImageSettings()?.checkpoint, 'SDXL')
    add(loadKrea2Settings()?.unetName, 'Krea2')
    add(loadQwenEditSettings()?.unetName, 'Edit')
  } catch {
    // storage unavailable — the server's template check still applies
  }
  return out
}

// The model's name inside its type folder, as ComfyUI lists it.
export function comfyModelName(m: LocalModel): string | null {
  if (m.area !== 'models' || m.path.startsWith('loras/')) return null
  return m.path.split('/').slice(1).join('/')
}

export function lockedBy(m: LocalModel, inUse: Record<string, string[]>): string[] | null {
  const name = comfyModelName(m)
  const tabs = [...(m.protectedBy ?? []), ...(name ? (inUse[name] ?? []) : [])]
  return tabs.length ? [...new Set(tabs)] : null
}

export function moveModel(m: LocalModel, toDir: string): Promise<{ ok: true; path: string }> {
  return postJson('/api/models/move', { area: m.area, path: m.path, toDir, inUse: modelsInUse() })
}

export function deleteModel(m: LocalModel): Promise<unknown> {
  return postJson('/api/models/delete', { area: m.area, path: m.path, inUse: modelsInUse() })
}

export function modelPreviewUrl(m: LocalModel): string | null {
  if (m.preview == null) return null
  return `/api/models/preview?${new URLSearchParams({ area: m.area, path: m.path, v: String(m.preview) })}`
}

export async function setModelPreviewBlob(m: LocalModel, blob: Blob): Promise<unknown> {
  const res = await fetch(`/api/models/preview?${new URLSearchParams({ area: m.area, path: m.path })}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg' },
    body: blob,
  })
  return asJson(res)
}

export function setModelPreviewFrom(m: LocalModel, from: { url: string } | { source: string; name: string }): Promise<unknown> {
  return postJson('/api/models/preview-from', { area: m.area, path: m.path, ...from })
}

// --- Disk ----------------------------------------------------------------

export interface StorageInfo {
  disks: { total: number; free: number; folders: { key: string; label: string; bytes: number }[] }[]
  reserve: number
}

export function fetchStorage(): Promise<StorageInfo> {
  return fetch('/api/models/storage').then((r) => asJson<StorageInfo>(r))
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
