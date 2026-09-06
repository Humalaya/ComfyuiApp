// Same rationale as settingsStorage.ts (video) — persists the Text2Img
// screen's form across reloads. Kept as its own small module rather than
// generalizing settingsStorage.ts, since the two settings shapes only
// overlap in prompt/seed/loras and diverge everywhere else (width/height/cfg
// vs aspect ratio/framerate/duration).
import { LORA_SLOT_COUNT, type LoraSlot } from '../workflow/fieldMap'
import { getDefaultImageSettings, type ImageGenerationSettings } from '../workflow/imageFieldMap'

const STORAGE_KEY = 'mobile-control:image-settings'
const STORAGE_VERSION = 1

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

// Exported so imageQueueStorage.ts can apply the exact same validation to
// each item of a persisted queue.
export function normalizeImageSettings(raw: unknown, defaults: ImageGenerationSettings = getDefaultImageSettings()): ImageGenerationSettings {
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<ImageGenerationSettings>
  return {
    prompt: typeof r.prompt === 'string' ? r.prompt : defaults.prompt,
    negativePrompt: typeof r.negativePrompt === 'string' ? r.negativePrompt : defaults.negativePrompt,
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : defaults.seed,
    fixedSeed: typeof r.fixedSeed === 'boolean' ? r.fixedSeed : defaults.fixedSeed,
    width: typeof r.width === 'number' && Number.isFinite(r.width) ? r.width : defaults.width,
    height: typeof r.height === 'number' && Number.isFinite(r.height) ? r.height : defaults.height,
    steps: typeof r.steps === 'number' && Number.isFinite(r.steps) ? r.steps : defaults.steps,
    cfg: typeof r.cfg === 'number' && Number.isFinite(r.cfg) ? r.cfg : defaults.cfg,
    batchSize: typeof r.batchSize === 'number' && Number.isFinite(r.batchSize) ? r.batchSize : defaults.batchSize,
    batchCount: typeof r.batchCount === 'number' && Number.isFinite(r.batchCount) ? r.batchCount : defaults.batchCount,
    checkpoint: typeof r.checkpoint === 'string' ? r.checkpoint : defaults.checkpoint,
    loras: normalizeLoras(r.loras, defaults.loras).slice(0, LORA_SLOT_COUNT),
  }
}

export function loadImageSettings(): ImageGenerationSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; settings?: unknown }
    if (parsed.version !== STORAGE_VERSION || !parsed.settings) return null
    return normalizeImageSettings(parsed.settings)
  } catch {
    return null
  }
}

export function saveImageSettings(settings: ImageGenerationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, settings }))
  } catch {
    // best effort — see settingsStorage.ts
  }
}
