import templateJson from './template.json'
import type { ComfyWorkflow } from '../api/comfyClient'

// Node ids inside the MiniMax H3 workflow that the mobile UI is allowed to touch.
// Keep this in sync with template.json — these are the *only* fields the mobile
// UI edits; every other node is left exactly as exported from ComfyUI.
export const NODE_IDS = {
  prompt: '138',
  seed: '142',
  resolution: '115',
  videoLength: '132',
  framerate: '149',
  model: '646',
  totalSteps: '750',
  // MiniMaxH3ImageToVideo itself — first_frame/last_frame are added to (or
  // deleted from) *this* node's inputs by buildWorkflow, not written as a
  // value on it, so it needs its own entry separate from the two loaders below.
  imageToVideo: '644',
  inputImage: '687', // "Picture 1" — LoadImageCrop feeding first_frame
  lastFrameImage: '900', // "Picture 2" — LoadImageCrop feeding last_frame
  samplerSelect: '123', // KSamplerSelect — sampler_name
  schedulerNode: '124', // BasicScheduler — scheduler + denoise
  loraLoader: '674',
} as const

export interface LoraSlot {
  on: boolean
  lora: string
  strength: number
}

export interface GenerationSettings {
  prompt: string
  seed: number
  // UI-only — ComfyUI's "easy seed" node has no server-side randomize
  // behavior of its own, it just uses whatever seed value it's given. So
  // "random each generation" has to happen on our side: when this is false,
  // the app picks a fresh seed right before submitting; when true, the seed
  // is left exactly as set.
  fixedSeed: boolean
  aspectRatio: string
  megapixels: number
  videoLengthSeconds: number
  framerate: number
  unetName: string
  totalSteps: number
  samplerName: string
  scheduler: string
  denoise: number
  // "Picture 1" (first_frame) — the difference between txt2vid and img2vid
  // for this node is purely whether first_frame is wired at all (confirmed
  // via MiniMaxH3ImageToVideo's own /object_info: it's an *optional* input,
  // completely absent from the node's inputs when not connected — there's no
  // "off" value for an IMAGE input). inputImageEnabled is what actually
  // decides that; inputImage itself just remembers the last picked image so
  // toggling back on doesn't lose it.
  inputImage: { filename: string; subfolder: string; type: string } | null
  inputImageEnabled: boolean
  // "Picture 2" (last_frame) — same idea, second/end reference frame. Wiring
  // both first_frame and last_frame at once is first-last-frame
  // interpolation; wiring only one is a plain single-image start frame.
  lastFrameImage: { filename: string; subfolder: string; type: string } | null
  lastFrameEnabled: boolean
  loras: LoraSlot[]
  // UI-only, like fixedSeed — this workflow's MiniMaxH3ImageToVideo node has
  // no batch_size input at all (checked via ComfyUI's own /object_info), so
  // there's no way to make ComfyUI itself render N videos in one job. This
  // is purely a convenience multiplier App.tsx uses to enqueue N copies (each
  // with its own freshly-randomized seed if not fixed) instead of one —
  // never written into the actual workflow sent to ComfyUI.
  batchCount: number
}

export const LORA_SLOT_COUNT = 10

function readLoraSlots(): LoraSlot[] {
  const raw = (templateJson as unknown as ComfyWorkflow)[NODE_IDS.loraLoader].inputs
  const slots: LoraSlot[] = []
  for (let i = 1; i <= LORA_SLOT_COUNT; i++) {
    const slot = raw[`lora_${i}`] as LoraSlot | undefined
    slots.push(slot ? { ...slot } : { on: false, lora: '', strength: 1 })
  }
  return slots
}

export function getDefaultSettings(): GenerationSettings {
  const t = templateJson as unknown as ComfyWorkflow
  return {
    prompt: String(t[NODE_IDS.prompt].inputs.value ?? ''),
    seed: Number(t[NODE_IDS.seed].inputs.seed ?? 0),
    fixedSeed: false,
    aspectRatio: String(t[NODE_IDS.resolution].inputs.aspect_ratio ?? ''),
    megapixels: Number(t[NODE_IDS.resolution].inputs.megapixels ?? 2),
    videoLengthSeconds: Number(t[NODE_IDS.videoLength].inputs.value ?? 5),
    framerate: Number(t[NODE_IDS.framerate].inputs.value ?? 24),
    unetName: String(t[NODE_IDS.model].inputs.unet_name ?? ''),
    totalSteps: Number(t[NODE_IDS.totalSteps].inputs.value ?? 10),
    samplerName: String(t[NODE_IDS.samplerSelect].inputs.sampler_name ?? 'euler'),
    scheduler: String(t[NODE_IDS.schedulerNode].inputs.scheduler ?? 'simple'),
    denoise: Number(t[NODE_IDS.schedulerNode].inputs.denoise ?? 1),
    // Defaults to OFF — a fresh install (or a "Varsayılana Sıfırla") starts
    // as pure txt2vid, matching what "off" actually means for this node.
    inputImage: null,
    inputImageEnabled: false,
    lastFrameImage: null,
    lastFrameEnabled: false,
    loras: readLoraSlots(),
    batchCount: 1,
  }
}

export function buildWorkflow(settings: GenerationSettings): ComfyWorkflow {
  const workflow = structuredClone(templateJson) as unknown as ComfyWorkflow

  workflow[NODE_IDS.prompt].inputs.value = settings.prompt
  workflow[NODE_IDS.seed].inputs.seed = settings.seed
  workflow[NODE_IDS.resolution].inputs.aspect_ratio = settings.aspectRatio
  workflow[NODE_IDS.resolution].inputs.megapixels = settings.megapixels
  workflow[NODE_IDS.videoLength].inputs.value = settings.videoLengthSeconds
  workflow[NODE_IDS.framerate].inputs.value = settings.framerate
  workflow[NODE_IDS.model].inputs.unet_name = settings.unetName
  workflow[NODE_IDS.totalSteps].inputs.value = settings.totalSteps
  workflow[NODE_IDS.samplerSelect].inputs.sampler_name = settings.samplerName
  workflow[NODE_IDS.schedulerNode].inputs.scheduler = settings.scheduler
  workflow[NODE_IDS.schedulerNode].inputs.denoise = settings.denoise

  // first_frame/last_frame are *optional* IMAGE inputs on MiniMaxH3ImageToVideo
  // — there's no "disabled" value for them, the key has to be entirely absent
  // from the node's inputs for txt2vid to actually happen (see
  // GenerationSettings.inputImageEnabled's comment). The template's own
  // baked-in default always has first_frame wired to node 687 regardless —
  // deleting it here every time it's off is what actually fixes txt2vid
  // instead of it silently img2vid-ing off whatever was last uploaded.
  const imageToVideoInputs = workflow[NODE_IDS.imageToVideo].inputs
  if (settings.inputImageEnabled && settings.inputImage) {
    // LoadImageCrop expects just the filename ComfyUI's /upload/image returned
    // (subfolder-qualified as "subfolder/filename" when not the root input dir).
    const { filename, subfolder } = settings.inputImage
    workflow[NODE_IDS.inputImage].inputs.image = subfolder ? `${subfolder}/${filename}` : filename
    imageToVideoInputs.first_frame = [NODE_IDS.inputImage, 0]
  } else {
    delete imageToVideoInputs.first_frame
  }

  if (settings.lastFrameEnabled && settings.lastFrameImage) {
    const { filename, subfolder } = settings.lastFrameImage
    workflow[NODE_IDS.lastFrameImage].inputs.image = subfolder ? `${subfolder}/${filename}` : filename
    imageToVideoInputs.last_frame = [NODE_IDS.lastFrameImage, 0]
  } else {
    delete imageToVideoInputs.last_frame
  }

  const loraInputs = workflow[NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  return workflow
}

export const VIDEO_OUTPUT_NODE_ID = '702'
