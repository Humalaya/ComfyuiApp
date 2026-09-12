// Same rationale as settingsStorage.ts (video) — persists the Text2Img
// screen's form across reloads. Kept as its own small module rather than
// generalizing settingsStorage.ts, since the two settings shapes only
// overlap in prompt/seed/loras and diverge everywhere else (width/height/cfg
// vs aspect ratio/framerate/duration).
import { LORA_SLOT_COUNT, type LoraSlot } from '../workflow/fieldMap'
import { getDefaultImageSettings, QUALITY_PRESETS, type ImageGenerationSettings, type QualityPreset } from '../workflow/imageFieldMap'

const STORAGE_KEY = 'mobile-control:image-settings'
const STORAGE_VERSION = 1

const QUALITY_PRESET_IDS = new Set(['none', ...Object.keys(QUALITY_PRESETS)])

function normalizeQualityPreset(v: unknown, fallback: QualityPreset): QualityPreset {
  return typeof v === 'string' && QUALITY_PRESET_IDS.has(v) ? (v as QualityPreset) : fallback
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

// Exported so ImageGenerateTab.tsx can hand this to remoteQueueStorage.ts's
// loadRemoteQueue, applying the exact same validation to each item of a
// persisted queue as a normal settings load gets.
export function normalizeImageSettings(raw: unknown, defaults: ImageGenerationSettings = getDefaultImageSettings()): ImageGenerationSettings {
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<ImageGenerationSettings>
  return {
    prompt: typeof r.prompt === 'string' ? r.prompt : defaults.prompt,
    negativePrompt: typeof r.negativePrompt === 'string' ? r.negativePrompt : defaults.negativePrompt,
    qualityPreset: normalizeQualityPreset(r.qualityPreset, defaults.qualityPreset),
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : defaults.seed,
    fixedSeed: typeof r.fixedSeed === 'boolean' ? r.fixedSeed : defaults.fixedSeed,
    width: typeof r.width === 'number' && Number.isFinite(r.width) ? r.width : defaults.width,
    height: typeof r.height === 'number' && Number.isFinite(r.height) ? r.height : defaults.height,
    steps: typeof r.steps === 'number' && Number.isFinite(r.steps) ? r.steps : defaults.steps,
    cfg: typeof r.cfg === 'number' && Number.isFinite(r.cfg) ? r.cfg : defaults.cfg,
    samplerName: typeof r.samplerName === 'string' ? r.samplerName : defaults.samplerName,
    scheduler: typeof r.scheduler === 'string' ? r.scheduler : defaults.scheduler,
    denoise: typeof r.denoise === 'number' && Number.isFinite(r.denoise) ? r.denoise : defaults.denoise,
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
