import qwenEditTemplateJson from './qwenEditTemplate.json'
import type { ComfyWorkflow } from '../api/comfyClient'

// Edit (Qwen) — Qwen Image 2.1's instruction edit, from the user's "Qwen
// Image 2.1 Edit" workflow. Up to four pictures go to TextEncodeQwenImage21,
// which shows them to the Qwen3-VL text encoder together with the
// instruction and splices them into the sequence as VAE latents; the
// instruction names them <image1>…<image4>. Its latent output is an empty
// latent at picture 1's size, so the result comes out at that size unless a
// custom size is set. Node ids inside qwenEditTemplate.json — keep in sync.
//
// Differences from the export: the "Scale Image N?" / "Image N Scale"
// primitives and the custom-size switch are set here instead of being wired
// through primitive nodes, and a picture that's off is cut out of the graph
// (the export bypassed those nodes by hand).
export const QWEN_EDIT_NODE_IDS = {
  diffusionModel: '260', // UNETLoader
  clip: '38', // CLIPLoader (type qwen_image)
  vae: '39', // VAELoader
  encode: '317', // TextEncodeQwenImage21
  customLatent: '172', // EmptyLatentImage — only used with a custom size
  sampler: '252', // KSampler
} as const

// Per picture: its LoadImage and its LayerUtility: ImageScaleByAspectRatio
// (longest side, rounded to a multiple of 16).
export const QWEN_EDIT_IMAGE_NODES = [
  { load: '78', scale: '262' },
  { load: '320', scale: '319' },
  { load: '328', scale: '329' },
  { load: '330', scale: '331' },
] as const

export const QWEN_EDIT_OUTPUT_NODE_ID = '60'
export const QWEN_EDIT_IMAGE_COUNT = QWEN_EDIT_IMAGE_NODES.length

export interface ImageRef {
  filename: string
  subfolder: string
  type: string
}

export interface QwenEditImage {
  image: ImageRef | null
  // Picture 1 is always on (it's the one being edited, and sets the size);
  // 2–4 are references switched on and off without losing the pick.
  on: boolean
}

export interface QwenEditSettings {
  images: QwenEditImage[]
  // The instruction — plain English, the pictures named <image1>…<image4>.
  prompt: string
  negativePrompt: string
  unetName: string
  clipName: string
  vaeName: string
  // Longest side the pictures are scaled to (picture 1 / the references) —
  // picture 1's also sets the result's size. Off: each keeps its own size
  // (still cropped to a multiple of 16).
  scaleImages: boolean
  maxSide: number
  refSide: number
  // TextEncodeQwenImage21's `resolution`: what the text encoder resizes
  // the references to (≈ N×N pixels); 0 keeps each at its own size.
  encoderResolution: number
  // Off: the result is picture 1's size (best — other sizes shift the
  // edit). On: width × height.
  customSize: boolean
  width: number
  height: number
  seed: number
  fixedSeed: boolean
  steps: number
  cfg: number
  samplerName: string
  scheduler: string
  // UI-only: queue this many separate jobs (fresh seed each, unless fixed).
  batchCount: number
}

function template(): ComfyWorkflow {
  return qwenEditTemplateJson as unknown as ComfyWorkflow
}

// The turbo checkpoint is distilled for few steps; the full one wants the
// export's 30.
export const isTurboModel = (name: string) => /turbo|lightning/i.test(name)
export const defaultStepsFor = (unetName: string) => (isTurboModel(unetName) ? 8 : 30)

export function getDefaultQwenEditSettings(): QwenEditSettings {
  const t = template()
  const s = t[QWEN_EDIT_NODE_IDS.sampler].inputs
  const latent = t[QWEN_EDIT_NODE_IDS.customLatent].inputs
  const unetName = String(t[QWEN_EDIT_NODE_IDS.diffusionModel].inputs.unet_name ?? '')
  return {
    images: QWEN_EDIT_IMAGE_NODES.map((_, i) => ({ image: null, on: i === 0 })),
    prompt: '',
    negativePrompt: '',
    unetName,
    clipName: String(t[QWEN_EDIT_NODE_IDS.clip].inputs.clip_name ?? ''),
    vaeName: String(t[QWEN_EDIT_NODE_IDS.vae].inputs.vae_name ?? ''),
    scaleImages: true,
    maxSide: Number(t[QWEN_EDIT_IMAGE_NODES[0].scale].inputs.longest_side ?? 1920),
    refSide: Number(t[QWEN_EDIT_IMAGE_NODES[2].scale].inputs.longest_side ?? 1536),
    encoderResolution: Number(t[QWEN_EDIT_NODE_IDS.encode].inputs.resolution ?? 0),
    customSize: false,
    width: Number(latent.width ?? 1440),
    height: Number(latent.height ?? 1920),
    seed: Number(s.seed ?? 0),
    fixedSeed: false,
    steps: defaultStepsFor(unetName),
    cfg: Number(s.cfg ?? 1),
    samplerName: String(s.sampler_name ?? 'euler'),
    scheduler: String(s.scheduler ?? 'beta'),
    batchCount: 1,
  }
}

const imageName = (r: ImageRef) => (r.subfolder ? `${r.subfolder}/${r.filename}` : r.filename)

// The pictures that go in, in order — picture 1 plus the references that are
// on and picked. The instruction's <imageN> numbers follow this order, so a
// reference that's off closes the gap (picture 3 alone becomes <image2>).
export function activeImages(settings: QwenEditSettings): { slot: number; image: ImageRef }[] {
  return settings.images.flatMap((img, slot) => (img.image && (slot === 0 || img.on) ? [{ slot, image: img.image }] : []))
}

export function buildQwenEditWorkflow(settings: QwenEditSettings): ComfyWorkflow {
  if (!settings.images[0]?.image) throw new Error('Önce düzenlenecek görseli (Görsel 1) seç.')
  const workflow = structuredClone(qwenEditTemplateJson) as unknown as ComfyWorkflow
  const encode = workflow[QWEN_EDIT_NODE_IDS.encode].inputs

  // Unwire every picture, then wire the active ones as image_1, image_2, …
  QWEN_EDIT_IMAGE_NODES.forEach((_, i) => delete encode[`images.image_${i + 1}`])
  const active = new Set<number>()
  activeImages(settings).forEach(({ slot, image }, n) => {
    const nodes = QWEN_EDIT_IMAGE_NODES[slot]
    active.add(slot)
    workflow[nodes.load].inputs.image = imageName(image)
    const scale = workflow[nodes.scale].inputs
    scale.scale_to_longest_side = settings.scaleImages
    scale.longest_side = slot === 0 ? settings.maxSide : settings.refSide
    encode[`images.image_${n + 1}`] = [nodes.scale, 0]
  })
  QWEN_EDIT_IMAGE_NODES.forEach((nodes, slot) => {
    if (active.has(slot)) return
    delete workflow[nodes.load]
    delete workflow[nodes.scale]
  })

  encode.prompt = settings.prompt
  encode.negative_prompt = settings.negativePrompt
  encode.resolution = settings.encoderResolution
  workflow[QWEN_EDIT_NODE_IDS.diffusionModel].inputs.unet_name = settings.unetName
  workflow[QWEN_EDIT_NODE_IDS.clip].inputs.clip_name = settings.clipName
  workflow[QWEN_EDIT_NODE_IDS.vae].inputs.vae_name = settings.vaeName

  const sampler = workflow[QWEN_EDIT_NODE_IDS.sampler].inputs
  if (settings.customSize) {
    const latent = workflow[QWEN_EDIT_NODE_IDS.customLatent].inputs
    latent.width = settings.width
    latent.height = settings.height
    sampler.latent_image = [QWEN_EDIT_NODE_IDS.customLatent, 0]
  } else {
    delete workflow[QWEN_EDIT_NODE_IDS.customLatent]
  }
  sampler.seed = settings.seed
  sampler.steps = settings.steps
  sampler.cfg = settings.cfg
  sampler.sampler_name = settings.samplerName
  sampler.scheduler = settings.scheduler
  return workflow
}

// Recognizes an Edit (Qwen) PNG's embedded workflow (by its encode node —
// these land in the Krea gallery folder) and reads the settings back out —
// null if it isn't one. The pictures aren't restored: they're inputs, not
// part of the result.
export function extractQwenEditSettings(workflow: ComfyWorkflow): Partial<QwenEditSettings> | null {
  const nodes = Object.values(workflow)
  const encode = nodes.find((n) => n?.class_type === 'TextEncodeQwenImage21')
  if (!encode) return null
  const settings: Partial<QwenEditSettings> = {}
  if (typeof encode.inputs.prompt === 'string') settings.prompt = encode.inputs.prompt
  if (typeof encode.inputs.negative_prompt === 'string') settings.negativePrompt = encode.inputs.negative_prompt
  if (typeof encode.inputs.resolution === 'number') settings.encoderResolution = encode.inputs.resolution
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
  return settings
}
