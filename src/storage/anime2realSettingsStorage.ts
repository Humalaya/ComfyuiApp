// Persists the Anime2Real screen's form across reloads — same approach as
// krea2SettingsStorage.ts, for this workflow's own settings shape.
import { type LoraSlot } from '../workflow/fieldMap'
import {
  ANIME2REAL_LORA_SLOT_COUNT,
  getDefaultAnime2RealSettings,
  type Anime2RealSettings,
  type ImageRef,
} from '../workflow/anime2realFieldMap'

const STORAGE_KEY = 'mobile-control:anime2real-settings'
const STORAGE_VERSION = 1

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function normalizeImage(v: unknown): ImageRef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<ImageRef>
  if (typeof r.filename !== 'string' || !r.filename) return null
  return { filename: r.filename, subfolder: typeof r.subfolder === 'string' ? r.subfolder : '', type: typeof r.type === 'string' ? r.type : 'input' }
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
      strength: num(s.strength, def.strength),
    }
  })
}

export function normalizeAnime2RealSettings(raw: unknown, defaults: Anime2RealSettings = getDefaultAnime2RealSettings()): Anime2RealSettings {
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<Anime2RealSettings>
  return {
    inputImage: normalizeImage(r.inputImage),
    prompt: str(r.prompt, defaults.prompt),
    systemPrompt: str(r.systemPrompt, defaults.systemPrompt),
    unetName: str(r.unetName, defaults.unetName),
    seed: num(r.seed, defaults.seed),
    fixedSeed: typeof r.fixedSeed === 'boolean' ? r.fixedSeed : defaults.fixedSeed,
    maxSide: num(r.maxSide, defaults.maxSide),
    steps: num(r.steps, defaults.steps),
    cfg: num(r.cfg, defaults.cfg),
    samplerName: str(r.samplerName, defaults.samplerName),
    scheduler: str(r.scheduler, defaults.scheduler),
    batchCount: num(r.batchCount, defaults.batchCount),
    loras: normalizeLoras(r.loras, defaults.loras).slice(0, ANIME2REAL_LORA_SLOT_COUNT),
  }
}

export function loadAnime2RealSettings(): Anime2RealSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; settings?: unknown }
    if (parsed.version !== STORAGE_VERSION || !parsed.settings) return null
    return normalizeAnime2RealSettings(parsed.settings)
  } catch {
    return null
  }
}

export function saveAnime2RealSettings(settings: Anime2RealSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, settings }))
  } catch {
    // best effort — see settingsStorage.ts
  }
}
