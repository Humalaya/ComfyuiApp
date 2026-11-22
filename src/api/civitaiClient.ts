// Client for the output-server's Civitai lookup endpoint (server/index.js) —
// not a direct call to civitai.com from the phone. The server hashes the
// actual lora file on disk and does the real Civitai API call (and caches
// the result), so the phone never needs to download a multi-hundred-MB lora
// file just to identify it, and civitai.com never sees the phone's IP.
export interface CivitaiLoraInfo {
  found: boolean
  imageUrl: string | null
  triggerWords: string[]
  modelName: string | null
  // Civitai's base model ("Illustrious", "Pony", "Krea 2"…) — see loraCompat.ts.
  baseModel?: string | null
}

const UNAVAILABLE: CivitaiLoraInfo = { found: false, imageUrl: null, triggerWords: [], modelName: null, baseModel: null }

// An SDXL checkpoint's Civitai base model (hashing a 7 GB file takes the PC
// ~20 s the first time; the server caches it). Memoized per app load.
const checkpointBase = new Map<string, Promise<string | null>>()
export function fetchCheckpointBase(name: string): Promise<string | null> {
  let p = checkpointBase.get(name)
  if (!p) {
    p = fetch(`/api/checkpoints/civitai?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((info: CivitaiLoraInfo | null) => info?.baseModel ?? null)
      .catch(() => {
        checkpointBase.delete(name)
        return null
      })
    checkpointBase.set(name, p)
  }
  return p
}

// Never throws — a lookup failure (server unreachable, COMFYUI_LORA_DIR not
// configured, Civitai itself down) just means no preview/trigger words for
// this lora, same as a lora that's genuinely not on Civitai at all. Callers
// treat both the same way: leave the thumbnail blank.
export async function fetchCivitaiLoraInfo(loraName: string): Promise<CivitaiLoraInfo> {
  try {
    const res = await fetch(`/api/loras/civitai?name=${encodeURIComponent(loraName)}`)
    if (!res.ok) return UNAVAILABLE
    return (await res.json()) as CivitaiLoraInfo
  } catch {
    return UNAVAILABLE
  }
}
