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

export const ANIME2REAL_OUTPUT_NODE_ID = '228'

export interface ImageRef {
  filename: string
  subfolder: string
  type: string
}

export interface Anime2RealSettings {
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

export function getDefaultAnime2RealSettings(): Anime2RealSettings {
  const t = template()
  const s = t[ANIME2REAL_NODE_IDS.sampler].inputs
  return {
    inputImage: null,
    prompt: String(t[ANIME2REAL_NODE_IDS.edit].inputs.prompt ?? ''),
    systemPrompt: String(t[ANIME2REAL_NODE_IDS.edit].inputs.system_prompt ?? ''),
    unetName: String(t[ANIME2REAL_NODE_IDS.diffusionModel].inputs.unet_name ?? ''),
    seed: Number(s.seed ?? 0),
    fixedSeed: false,
    maxSide: Number(t[ANIME2REAL_NODE_IDS.resize].inputs.width ?? 1536),
    steps: Number(s.steps ?? 8),
    cfg: Number(s.cfg ?? 1),
    samplerName: String(s.sampler_name ?? 'euler'),
    scheduler: String(s.scheduler ?? 'beta57'),
    batchCount: 1,
    loras: readLoraSlots(),
  }
}

export function buildAnime2RealWorkflow(settings: Anime2RealSettings): ComfyWorkflow {
  if (!settings.inputImage) throw new Error('Önce dönüştürülecek görseli seç.')
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

  const sampler = workflow[ANIME2REAL_NODE_IDS.sampler].inputs
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
  const settings: Partial<Anime2RealSettings> = {}
  if (typeof edit.inputs.prompt === 'string') settings.prompt = edit.inputs.prompt
  if (typeof edit.inputs.system_prompt === 'string') settings.systemPrompt = edit.inputs.system_prompt
  const sampler = nodes.find((n) => n?.class_type === 'KSampler')?.inputs
  if (sampler) {
    if (typeof sampler.seed === 'number') {
      settings.seed = sampler.seed
      settings.fixedSeed = true
    }
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
