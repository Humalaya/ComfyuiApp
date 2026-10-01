import type { ImportPayload } from '../components/Gallery'
import type { CivitaiGeneration } from '../api/civitaiBrowser'

export type ImportKind = ImportPayload['kind']

// Civitai reports A1111/Forge sampler names ("DPM++ 2M Karras"); ComfyUI
// splits that into a sampler + a scheduler. Only mappings whose result is in
// the live ComfyUI lists get applied (see civitaiToImport) — a name ComfyUI
// doesn't know would just make the next generation fail.
const A1111_SAMPLERS: Record<string, [string, string?]> = {
  'euler a': ['euler_ancestral'],
  euler: ['euler'],
  lms: ['lms'],
  'lms karras': ['lms', 'karras'],
  heun: ['heun'],
  dpm2: ['dpm_2'],
  'dpm2 a': ['dpm_2_ancestral'],
  'dpm2 karras': ['dpm_2', 'karras'],
  'dpm2 a karras': ['dpm_2_ancestral', 'karras'],
  'dpm++ 2s a': ['dpmpp_2s_ancestral'],
  'dpm++ 2s a karras': ['dpmpp_2s_ancestral', 'karras'],
  'dpm++ 2m': ['dpmpp_2m'],
  'dpm++ 2m karras': ['dpmpp_2m', 'karras'],
  'dpm++ sde': ['dpmpp_sde'],
  'dpm++ sde karras': ['dpmpp_sde', 'karras'],
  'dpm++ 2m sde': ['dpmpp_2m_sde'],
  'dpm++ 2m sde karras': ['dpmpp_2m_sde', 'karras'],
  'dpm++ 2m sde exponential': ['dpmpp_2m_sde', 'exponential'],
  'dpm++ 3m sde': ['dpmpp_3m_sde'],
  'dpm++ 3m sde karras': ['dpmpp_3m_sde', 'karras'],
  'dpm++ 3m sde exponential': ['dpmpp_3m_sde', 'exponential'],
  'dpm fast': ['dpm_fast'],
  'dpm adaptive': ['dpm_adaptive'],
  ddim: ['ddim'],
  unipc: ['uni_pc'],
  lcm: ['lcm'],
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

// Latent sizes must be multiples of 8.
function dim(v: unknown): number | null {
  const n = num(v)
  return n && n >= 64 ? Math.round(n / 8) * 8 : null
}

function size(gen: CivitaiGeneration): [number, number] | null {
  const w = dim(gen.width)
  const h = dim(gen.height)
  return w && h ? [w, h] : null
}

export interface CivitaiImportResult {
  payload: ImportPayload
  // Human-readable list of what was actually carried over, for the toast.
  filled: string[]
}

// Maps a Civitai post's generation metadata onto one Create tab's settings.
// Only the fields that tab has and that came through cleanly are set — the
// rest of the tab's settings stay as they were.
export function civitaiToImport(
  kind: ImportKind,
  gen: CivitaiGeneration | null,
  comfy: { samplerNames: string[]; schedulerNames: string[] },
): CivitaiImportResult | null {
  const prompt = gen?.prompt || ''
  if (!gen || !prompt.trim()) return null
  const filled = ['Prompt']
  const seed = num(gen.seed)
  const seedPart = seed !== null ? { seed, fixedSeed: true } : {}
  if (seed !== null) filled.push('Seed')

  if (kind === 'video') {
    return { payload: { kind, settings: { prompt, ...seedPart } }, filled }
  }

  const wh = size(gen)
  const sizePart = wh ? { width: wh[0], height: wh[1] } : {}
  if (wh) filled.push(`Boyut ${wh[0]}×${wh[1]}`)

  if (kind === 'krea2') {
    return { payload: { kind, settings: { prompt, ...seedPart, ...sizePart } }, filled }
  }

  const settings: NonNullable<Extract<ImportPayload, { kind: 'sdxl' }>['settings']> = { prompt, ...seedPart, ...sizePart }
  const negative = gen.negativePrompt
  if (negative) {
    settings.negativePrompt = negative
    filled.push('Negatif prompt')
  }
  const steps = num(gen.steps)
  if (steps && steps > 0 && steps <= 150) {
    settings.steps = Math.round(steps)
    filled.push(`Adım ${settings.steps}`)
  }
  const cfg = num(gen.cfgScale)
  if (cfg !== null && cfg >= 0 && cfg <= 30) {
    settings.cfg = cfg
    filled.push(`CFG ${cfg}`)
  }
  const rawSampler = (gen.sampler || '').trim()
  if (rawSampler) {
    const mapped = A1111_SAMPLERS[rawSampler.toLowerCase()] ?? [rawSampler.toLowerCase().replace(/\s+/g, '_')]
    if (comfy.samplerNames.includes(mapped[0])) {
      settings.samplerName = mapped[0]
      filled.push(`Sampler ${mapped[0]}`)
    }
    const sched = (gen.scheduler || mapped[1] || '').toLowerCase()
    if (sched && comfy.schedulerNames.includes(sched)) {
      settings.scheduler = sched
      filled.push(`Scheduler ${sched}`)
    }
  }
  return { payload: { kind: 'sdxl', settings }, filled }
}
