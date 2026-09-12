// Same rationale as imageSettingsStorage.ts — persists the Krea2 (FLUX)
// Text2Img screen's form across reloads. Its own module since the settings
// shape differs (22 LoRA slots instead of 10, no checkpoint/cfg/steps —
// see krea2FieldMap.ts for why).
import { type LoraSlot } from '../workflow/fieldMap'
import { getDefaultKrea2Settings, KREA2_LORA_SLOT_COUNT, type Krea2GenerationSettings } from '../workflow/krea2FieldMap'

const STORAGE_KEY = 'mobile-control:krea2-settings'
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

export function normalizeKrea2Settings(raw: unknown, defaults: Krea2GenerationSettings = getDefaultKrea2Settings()): Krea2GenerationSettings {
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<Krea2GenerationSettings>
  return {
    prompt: typeof r.prompt === 'string' ? r.prompt : defaults.prompt,
    unetName: typeof r.unetName === 'string' ? r.unetName : defaults.unetName,
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : defaults.seed,
    fixedSeed: typeof r.fixedSeed === 'boolean' ? r.fixedSeed : defaults.fixedSeed,
    width: typeof r.width === 'number' && Number.isFinite(r.width) ? r.width : defaults.width,
    height: typeof r.height === 'number' && Number.isFinite(r.height) ? r.height : defaults.height,
    batchSize: typeof r.batchSize === 'number' && Number.isFinite(r.batchSize) ? r.batchSize : defaults.batchSize,
    batchCount: typeof r.batchCount === 'number' && Number.isFinite(r.batchCount) ? r.batchCount : defaults.batchCount,
    steps1: typeof r.steps1 === 'number' && Number.isFinite(r.steps1) ? r.steps1 : defaults.steps1,
    steps2: typeof r.steps2 === 'number' && Number.isFinite(r.steps2) ? r.steps2 : defaults.steps2,
    samplerName1: typeof r.samplerName1 === 'string' ? r.samplerName1 : defaults.samplerName1,
    scheduler1: typeof r.scheduler1 === 'string' ? r.scheduler1 : defaults.scheduler1,
    denoise1: typeof r.denoise1 === 'number' && Number.isFinite(r.denoise1) ? r.denoise1 : defaults.denoise1,
    samplerName2: typeof r.samplerName2 === 'string' ? r.samplerName2 : defaults.samplerName2,
    scheduler2: typeof r.scheduler2 === 'string' ? r.scheduler2 : defaults.scheduler2,
    denoise2: typeof r.denoise2 === 'number' && Number.isFinite(r.denoise2) ? r.denoise2 : defaults.denoise2,
    loras: normalizeLoras(r.loras, defaults.loras).slice(0, KREA2_LORA_SLOT_COUNT),
  }
}

export function loadKrea2Settings(): Krea2GenerationSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; settings?: unknown }
    if (parsed.version !== STORAGE_VERSION || !parsed.settings) return null
    return normalizeKrea2Settings(parsed.settings)
  } catch {
    return null
  }
}

export function saveKrea2Settings(settings: Krea2GenerationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, settings }))
  } catch {
    // best effort — see settingsStorage.ts
  }
}
