import anime2realTemplateJson from './anime2realTemplate.json'
import type { ComfyWorkflow } from '../api/comfyClient'
import { type LoraSlot } from './fieldMap'

// Anime2Real — a Krea2 *image edit* workflow: an input picture (typically
// anime/illustration) is turned into a realistic photo by the
// PornMaster_Krea2_AnimeToReal LoRA on Ostris' Krea2 edit patch, with the
// picture fed in as a reference latent (Easy_QwenEdit2509). Node ids inside
// anime2realTemplate.json — keep in sync.
//
// Differences from the user's original export (krea2_v10.json): the
// "Lora Loader Stack (rgthree)" (4 fixed slots) became a Power Lora Loader
// like every other workflow here, so the same LoRA list UI works; and
// SaveImage writes into the Krea gallery folder (krea/<date>/Anime2Real_…)
// instead of ComfyUI's output root, where Galeri never looked.
export const ANIME2REAL_NODE_IDS = {
  diffusionModel: '215', // UNETLoader
  // Easy_QwenEdit2509 — the edit instruction (`prompt`) and the reference
  // image; its latent output (sized from the input) is what gets sampled.
  edit: '220',
  sampler: '221', // KSampler
  inputImage: '227', // LoadImage
  // ColorCorrect on the input (saturation −20, as in the original) — tones
  // down flat anime colors before conversion. Not exposed.
  colorCorrect: '237',
  // ImageResizeKJv2 — the input is fit into a maxSide × maxSide box (aspect
  // kept, multiple of 16); the output comes out at that size.
  resize: '238',
  loraLoader: '236',
} as const

export const ANIME2REAL_LORA_SLOT_COUNT = 10

// Defaults are the original workflow's CFG 1 + 8 steps (a turbo setting).
// On a regular (non-turbo) Krea2 model that comes out paler and flatter —
// measured 2026-10 on krea2_v25, same input and seed: CFG 1/8 steps gave
// saturation 66 / contrast 50 vs the input's 81 / 63, CFG 3/20 steps kept
// them (84 / 64) at ~5× the time. Left to the user (Gelişmiş Ayarlar).

export const ANIME2REAL_OUTPUT_NODE_ID = '228'

export interface ImageRef {
  filename: string
  subfolder: string
  type: string
}

// The Edit (Flux) tab's two jobs. 'edit': a plain-language instruction
// ("make this man smile") applied to the picture — what the instruction
// doesn't mention stays. 'anime2real': the original workflow — an anime /
// illustration turned into a realistic photo by the AnimeToReal LoRA.
//
// How editing works here: the Qwen3-VL text encoder looks at the picture
// together with the instruction, and the picture is also handed to the model
// as a reference latent (Ostris' Krea2 edit patch). The patch only *enables*
// references; the editing skill itself comes from an edit LoRA trained for
// it (AnimeToReal is one). Without one (measured 2026-11-21) small changes
// work — an expression, a smile, a raised hand at full strength — but
// removing or adding objects ("remove the microphone") does not.
export type EditMode = 'edit' | 'anime2real'

// Easy_QwenEdit2509's standing instruction for 'edit': the original's, plus
// an explicit "keep everything else", identity first.
export const EDIT_SYSTEM_PROMPT =
  "Describe the key features of the input image (people, faces, hair, clothing, pose, objects, background, lighting, colors), then explain how the user's text instruction should alter the image. Generate a new image that applies only the requested change. Everything the instruction does not mention must stay exactly as in the input image: the same person with the same face, identity, age, skin, hair and body, the same clothing, pose, framing, background, lighting and photographic style."

// "Yüzü koru" strength — see Anime2RealSettings.denoise.
export const EDIT_KEEP_FACE_DENOISE = 0.75

// The template's ColorCorrect saturation (−20) suits flat anime colors only.
const ANIME_INPUT_SATURATION = -20

const isAnimeToRealLora = (name: string) => /animetoreal/i.test(name)

export interface Anime2RealSettings {
  mode: EditMode
  // The sampler's denoise. 1 = the change is fully drawn (colors, clothes,
  // pose) but the face can drift; ~0.75 starts from the picture itself, so
  // the person stays the same but only small changes (expression) come
  // through. Measured: a smile works at 0.7–1; a sweater color or a raised
  // hand needs 1.
  denoise: number
  // The picture to convert — required.
  inputImage: ImageRef | null
  // The edit instruction. The LoRA's own trigger phrase is the default; a
  // short description (ethnicity, age, hair, pose, camera angle) after it
  // helps, per the LoRA's author.
  prompt: string
  // Easy_QwenEdit2509's system_prompt — the standing instruction to the
  // Qwen3-VL text encoder on how to read the input picture and apply the
  // edit. Defaults to the original workflow's text.
  systemPrompt: string
  unetName: string
  seed: number
  fixedSeed: boolean
  // Longest side of the result, in pixels (the input is scaled to fit).
  maxSide: number
  steps: number
  cfg: number
  samplerName: string
  scheduler: string
  // UI-only: queue this many separate jobs (fresh seed each, unless fixed).
  batchCount: number
  loras: LoraSlot[]
}

function template(): ComfyWorkflow {
  return anime2realTemplateJson as unknown as ComfyWorkflow
}

function readLoraSlots(): LoraSlot[] {
  const raw = template()[ANIME2REAL_NODE_IDS.loraLoader].inputs
  const slots: LoraSlot[] = []
  for (let i = 1; i <= ANIME2REAL_LORA_SLOT_COUNT; i++) {
    const slot = raw[`lora_${i}`] as LoraSlot | undefined
    slots.push(slot ? { ...slot } : { on: false, lora: '', strength: 1 })
  }
  return slots
}

// What switching modes resets: the instruction and system text (only while
// they're still the other mode's defaults — see switchEditMode) and the
// AnimeToReal LoRA (on only for 'anime2real').
export function editModeDefaults(mode: EditMode): { prompt: string; systemPrompt: string } {
  const t = template()
  return mode === 'anime2real'
    ? {
        prompt: String(t[ANIME2REAL_NODE_IDS.edit].inputs.prompt ?? ''),
        systemPrompt: String(t[ANIME2REAL_NODE_IDS.edit].inputs.system_prompt ?? ''),
      }
    : { prompt: '', systemPrompt: EDIT_SYSTEM_PROMPT }
}

export function switchEditMode(s: Anime2RealSettings, mode: EditMode): Anime2RealSettings {
  if (s.mode === mode) return s
  const from = editModeDefaults(s.mode)
  const to = editModeDefaults(mode)
  return {
    ...s,
    mode,
    prompt: s.prompt.trim() === from.prompt.trim() ? to.prompt : s.prompt,
    systemPrompt: s.systemPrompt === from.systemPrompt ? to.systemPrompt : s.systemPrompt,
    loras: s.loras.map((l) => (isAnimeToRealLora(l.lora) ? { ...l, on: mode === 'anime2real' } : l)),
  }
}

export function getDefaultAnime2RealSettings(): Anime2RealSettings {
  const t = template()
  const s = t[ANIME2REAL_NODE_IDS.sampler].inputs
  const edit = editModeDefaults('edit')
  return {
    mode: 'edit',
    denoise: 1,
    inputImage: null,
    prompt: edit.prompt,
    systemPrompt: edit.systemPrompt,
    unetName: String(t[ANIME2REAL_NODE_IDS.diffusionModel].inputs.unet_name ?? ''),
    seed: Number(s.seed ?? 0),
    fixedSeed: false,
    maxSide: Number(t[ANIME2REAL_NODE_IDS.resize].inputs.width ?? 1536),
    steps: Number(s.steps ?? 8),
    cfg: Number(s.cfg ?? 1),
    samplerName: String(s.sampler_name ?? 'euler'),
    scheduler: String(s.scheduler ?? 'beta57'),
    batchCount: 1,
    loras: readLoraSlots().map((l) => (isAnimeToRealLora(l.lora) ? { ...l, on: false } : l)),
  }
}

export function buildAnime2RealWorkflow(settings: Anime2RealSettings): ComfyWorkflow {
  if (!settings.inputImage) throw new Error('Önce düzenlenecek görseli seç.')
  const workflow = structuredClone(anime2realTemplateJson) as unknown as ComfyWorkflow

  const { filename, subfolder } = settings.inputImage
  // LoadImage takes the name /upload/image returned, "subfolder/filename"
  // when not in the input root — same as the video tab's LoadImageCrop.
  workflow[ANIME2REAL_NODE_IDS.inputImage].inputs.image = subfolder ? `${subfolder}/${filename}` : filename
  workflow[ANIME2REAL_NODE_IDS.edit].inputs.prompt = settings.prompt
  workflow[ANIME2REAL_NODE_IDS.edit].inputs.system_prompt = settings.systemPrompt
  workflow[ANIME2REAL_NODE_IDS.diffusionModel].inputs.unet_name = settings.unetName
  workflow[ANIME2REAL_NODE_IDS.resize].inputs.width = settings.maxSide
  workflow[ANIME2REAL_NODE_IDS.resize].inputs.height = settings.maxSide

  // Desaturating suits anime input only; a general edit keeps the colors.
  workflow[ANIME2REAL_NODE_IDS.colorCorrect].inputs.saturation = settings.mode === 'anime2real' ? ANIME_INPUT_SATURATION : 0
  const save = workflow[ANIME2REAL_OUTPUT_NODE_ID].inputs
  save.filename_prefix = `krea/%year%-%month%-%day%/${settings.mode === 'anime2real' ? 'Anime2Real' : 'Edit'}`

  const sampler = workflow[ANIME2REAL_NODE_IDS.sampler].inputs
  // Below 1 the sampler starts from the picture's own latent (the edit
  // node's latent output is the encoded input).
  sampler.denoise = Math.min(1, Math.max(0.3, settings.denoise))
  sampler.seed = settings.seed
  sampler.steps = settings.steps
  sampler.cfg = settings.cfg
  sampler.sampler_name = settings.samplerName
  sampler.scheduler = settings.scheduler

  const loraInputs = workflow[ANIME2REAL_NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  return workflow
}

// Recognizes an Anime2Real PNG's embedded workflow (by its edit node, since
// these land in the Krea gallery next to plain Krea2 images) and reads the
// settings back out — null if it isn't one.
export function extractAnime2RealSettings(workflow: ComfyWorkflow): Partial<Anime2RealSettings> | null {
  const nodes = Object.values(workflow)
  const edit = nodes.find((n) => n?.class_type === 'Easy_QwenEdit2509')
  if (!edit) return null
  // The file prefix tells the two modes apart (older "Krea2Edit" files were
  // the Krea2 tab's edit mode, now this one's 'edit').
  const prefix = String(nodes.find((n) => n?.class_type === 'SaveImage')?.inputs.filename_prefix ?? '')
  const settings: Partial<Anime2RealSettings> = { mode: prefix.includes('Anime2Real') ? 'anime2real' : 'edit' }
  if (typeof edit.inputs.prompt === 'string') settings.prompt = edit.inputs.prompt
  if (typeof edit.inputs.system_prompt === 'string') settings.systemPrompt = edit.inputs.system_prompt
  const sampler = nodes.find((n) => n?.class_type === 'KSampler')?.inputs
  if (sampler) {
    if (typeof sampler.seed === 'number') {
      settings.seed = sampler.seed
      settings.fixedSeed = true
    }
    if (typeof sampler.denoise === 'number') settings.denoise = sampler.denoise
    if (typeof sampler.steps === 'number') settings.steps = sampler.steps
    if (typeof sampler.cfg === 'number') settings.cfg = sampler.cfg
    if (typeof sampler.sampler_name === 'string') settings.samplerName = sampler.sampler_name
    if (typeof sampler.scheduler === 'string') settings.scheduler = sampler.scheduler
  }
  const unet = nodes.find((n) => n?.class_type === 'UNETLoader')?.inputs.unet_name
  if (typeof unet === 'string') settings.unetName = unet
  const width = nodes.find((n) => n?.class_type === 'ImageResizeKJv2')?.inputs.width
  if (typeof width === 'number') settings.maxSide = width
  return settings
}
