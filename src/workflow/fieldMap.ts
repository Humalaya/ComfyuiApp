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
  inputImage: '687',
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
  inputImage: { filename: string; subfolder: string; type: string } | null
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
    inputImage: null,
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
  // Denoise is intentionally not user-editable — left at the workflow's own
  // baked-in default (1, i.e. full-strength) rather than exposed in the UI.

  if (settings.inputImage) {
    // LoadImageCrop expects just the filename ComfyUI's /upload/image returned
    // (subfolder-qualified as "subfolder/filename" when not the root input dir).
    const { filename, subfolder } = settings.inputImage
    workflow[NODE_IDS.inputImage].inputs.image = subfolder ? `${subfolder}/${filename}` : filename
  }

  const loraInputs = workflow[NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  return workflow
}

export const VIDEO_OUTPUT_NODE_ID = '702'
