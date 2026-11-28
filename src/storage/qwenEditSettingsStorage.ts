// Persists the Edit (Qwen) screen's form across reloads — same approach as
// krea2SettingsStorage.ts, for this workflow's own settings shape.
import {
  getDefaultQwenEditSettings,
  QWEN_EDIT_IMAGE_COUNT,
  type ImageRef,
  type QwenEditImage,
  type QwenEditSettings,
} from '../workflow/qwenEditFieldMap'

const STORAGE_KEY = 'mobile-control:qwenedit-settings'
const STORAGE_VERSION = 1

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function normalizeImage(v: unknown): ImageRef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<ImageRef>
  if (typeof r.filename !== 'string' || !r.filename) return null
  return {
    filename: r.filename,
    subfolder: typeof r.subfolder === 'string' ? r.subfolder : '',
    type: typeof r.type === 'string' ? r.type : 'input',
  }
}

function normalizeImages(v: unknown, fallback: QwenEditImage[]): QwenEditImage[] {
  const list = Array.isArray(v) ? v : []
  return Array.from({ length: QWEN_EDIT_IMAGE_COUNT }, (_, i) => {
    const raw = list[i] as Partial<QwenEditImage> | undefined
    if (!raw || typeof raw !== 'object') return fallback[i]
    return { image: normalizeImage(raw.image), on: i === 0 ? true : bool(raw.on, fallback[i].on) }
  })
}

export function normalizeQwenEditSettings(raw: unknown, defaults: QwenEditSettings = getDefaultQwenEditSettings()): QwenEditSettings {
  if (!raw || typeof raw !== 'object') return defaults
  const r = raw as Partial<QwenEditSettings>
  return {
    images: normalizeImages(r.images, defaults.images),
    prompt: str(r.prompt, defaults.prompt),
    negativePrompt: str(r.negativePrompt, defaults.negativePrompt),
    unetName: str(r.unetName, defaults.unetName),
    clipName: str(r.clipName, defaults.clipName),
    vaeName: str(r.vaeName, defaults.vaeName),
    scaleImages: bool(r.scaleImages, defaults.scaleImages),
    maxSide: num(r.maxSide, defaults.maxSide),
    refSide: num(r.refSide, defaults.refSide),
    encoderResolution: num(r.encoderResolution, defaults.encoderResolution),
    customSize: bool(r.customSize, defaults.customSize),
    width: num(r.width, defaults.width),
    height: num(r.height, defaults.height),
    seed: num(r.seed, defaults.seed),
    fixedSeed: bool(r.fixedSeed, defaults.fixedSeed),
    steps: num(r.steps, defaults.steps),
    cfg: num(r.cfg, defaults.cfg),
    samplerName: str(r.samplerName, defaults.samplerName),
    scheduler: str(r.scheduler, defaults.scheduler),
    batchCount: num(r.batchCount, defaults.batchCount),
  }
}

export function loadQwenEditSettings(): QwenEditSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; settings?: unknown }
    if (parsed.version !== STORAGE_VERSION || !parsed.settings) return null
    return normalizeQwenEditSettings(parsed.settings)
  } catch {
    return null
  }
}

export function saveQwenEditSettings(settings: QwenEditSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, settings }))
  } catch {
    // best effort — see settingsStorage.ts
  }
}
