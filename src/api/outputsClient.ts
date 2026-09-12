// Client for the local Output Browser backend (server/index.js), proxied at
// /api by Vite. Unrelated to the ComfyUI REST API in comfyClient.ts.

export interface OutputFile {
  name: string
  type: 'image' | 'video'
  ext: string
  size: number
  mtimeMs: number
}

export interface OutputSource {
  id: string
  label: string
  configured: boolean
}

// One directory level: subfolders (as full paths relative to the source
// root) to navigate into, plus the media files directly inside it. Never
// recursive — a source organized into subfolders (e.g. each generation
// type's own <date>/ subfolder) is browsed folder-by-folder instead of being
// flattened into one giant list.
export interface OutputListing {
  folders: string[]
  files: OutputFile[]
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function listSources(): Promise<OutputSource[]> {
  const res = await fetch('/api/outputs/sources')
  return asJson(res)
}

export async function listOutputs(source: string, path: string): Promise<OutputListing> {
  const params = new URLSearchParams({ source })
  if (path) params.set('path', path)
  const res = await fetch(`/api/outputs?${params.toString()}`)
  return asJson(res)
}

export function outputFileUrl(source: string, name: string): string {
  return `/api/outputs/file?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`
}

export function outputThumbnailUrl(source: string, name: string): string {
  return `/api/outputs/thumbnail?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`
}

export function outputDownloadUrl(source: string, name: string): string {
  return `/api/outputs/download?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

// Used by the native SaveMedia plugin (see src/native/saveMedia.ts) — it
// needs a real MIME type to write a MediaStore entry other apps recognize as
// an actual photo/video, not just a request-carried Content-Type.
export function outputMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
}
