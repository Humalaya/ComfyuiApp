// Persists the Generate tab's form state (prompt, seed, model, LoRAs, input
// image reference, ...) across page reloads — a mobile WebView can be torn
// down and reloaded from scratch at any time (screen lock, OEM background
// process kill, manual refresh), and losing the whole form every time that
// happens is worse than losing a live WebSocket connection.
//
// inputImage is just `{ filename, subfolder, type }` — a reference to a file
// already uploaded to ComfyUI's /upload/image, not the raw browser File
// object (which can't be serialized anyway). That reference alone is enough
// to redraw the preview (via viewUrl, same as ImageUploader already does)
// and to reuse the image in a future generate() call, so plain JSON/
// localStorage covers it — no IndexedDB/blob storage needed.
import type { GenerationSettings, LoraSlot } from '../workflow/fieldMap'
import { getDefaultSettings, LORA_SLOT_COUNT } from '../workflow/fieldMap'

const STORAGE_KEY = 'mobile-control:settings'
const STORAGE_VERSION = 1

function isInputImage(v: unknown): v is GenerationSettings['inputImage'] {
  if (v === null) return true
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.filename === 'string' && typeof o.subfolder === 'string' && typeof o.type === 'string'
}

function normalizeLoras(v: unknown, fallback: LoraSlot[]): LoraSlot[] {
  if (!Array.isArray(v)) return fallback
  return fallback.map((def, i) => {
    const slot = v[i]
    if (!slot || typeof slot !== 'object') return def
    const s = slot as Partial<LoraSlot>
    return {
      on: typeof s.on === 'boolean' ? s.on : def.on,
      lora: typeof s.lora === 'string' ? s.lora : def.lora,
      strength: typeof s.strength === 'number' && Number.isFinite(s.strength) ? s.strength : def.strength,
    }
  })
}

// Rebuilds a fully-valid GenerationSettings from untrusted parsed JSON,
// field by field — anything missing, mistyped, or from an incompatible
// schema silently falls back to the matching default instead of corrupting
// the whole form or crashing the app. Exported so queueStorage.ts can apply
// the exact same validation to each item of a persisted queue.
export function normalizeSettings(raw: unknown, defaults: GenerationSettings = getDefaultSettings()): GenerationSettings {
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<GenerationSettings>
  return {
    prompt: typeof r.prompt === 'string' ? r.prompt : defaults.prompt,
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : defaults.seed,
    fixedSeed: typeof r.fixedSeed === 'boolean' ? r.fixedSeed : defaults.fixedSeed,
    aspectRatio: typeof r.aspectRatio === 'string' ? r.aspectRatio : defaults.aspectRatio,
    megapixels: typeof r.megapixels === 'number' && Number.isFinite(r.megapixels) ? r.megapixels : defaults.megapixels,
    videoLengthSeconds:
      typeof r.videoLengthSeconds === 'number' && Number.isFinite(r.videoLengthSeconds) ? r.videoLengthSeconds : defaults.videoLengthSeconds,
    framerate: typeof r.framerate === 'number' && Number.isFinite(r.framerate) ? r.framerate : defaults.framerate,
    unetName: typeof r.unetName === 'string' ? r.unetName : defaults.unetName,
    totalSteps: typeof r.totalSteps === 'number' && Number.isFinite(r.totalSteps) ? r.totalSteps : defaults.totalSteps,
    denoise: typeof r.denoise === 'number' && Number.isFinite(r.denoise) ? r.denoise : defaults.denoise,
    inputImage: isInputImage(r.inputImage) ? r.inputImage : defaults.inputImage,
    loras: normalizeLoras(r.loras, defaults.loras).slice(0, LORA_SLOT_COUNT),
  }
}

// Returns null when there's nothing usable saved yet (first-ever launch, or
// storage was cleared) — the caller decides what "no saved settings" means
// (getDefaultSettings() picks a fresh random seed in that case, same as
// before this persistence layer existed; a restored settings object keeps
// whatever seed the user last had, on purpose).
export function loadSettings(): GenerationSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; settings?: unknown }
    if (parsed.version !== STORAGE_VERSION || !parsed.settings) return null
    return normalizeSettings(parsed.settings)
  } catch {
    return null
  }
}

export function saveSettings(settings: GenerationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, settings }))
  } catch {
    // localStorage full/unavailable (e.g. private browsing) — best effort,
    // losing persistence isn't worth breaking the generate flow over.
  }
}
