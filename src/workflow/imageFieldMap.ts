import imageTemplateJson from './imageTemplate.json'
import type { ComfyWorkflow } from '../api/comfyClient'
import { LORA_SLOT_COUNT, type LoraSlot } from './fieldMap'

// Node ids inside the Text2Img workflow (Basic_V38) the mobile UI is allowed
// to touch — keep in sync with imageTemplate.json.
//
// The FaceDetailer pipeline's ~29 parameters (node 31, FaceDetailerPipe) are
// left completely untouched here even though they now have real, known
// names — that's deliberately the future "Detail Enhancers" tab, not part
// of this basic screen. Also note: this template has no SAM model wired in
// (node 5's optional sam_model_opt input was dropped) because this ComfyUI
// instance has zero SAM models installed (/object_info/SAMLoader returned an
// empty option list) — the FaceDetailer still works via bbox detection
// alone, just without SAM-based mask refinement.
export const IMAGE_NODE_IDS = {
  positivePrompt: '3',
  negativePrompt: '4',
  width: '1',
  height: '11',
  steps: '17',
  cfg: '18',
  batchSize: '23',
  seed: '40',
  checkpoint: '45',
  loraLoader: '27',
} as const

// The output actually worth watching in ComfyUI's /history: node 31
// (FaceDetailer) processes the image but never saves it — node 50
// (SaveImage) is what ComfyUI records under "outputs", same as
// VIDEO_OUTPUT_NODE_ID points at the video-workflow's actual save node.
export const IMAGE_OUTPUT_NODE_ID = '50'

export interface ImageGenerationSettings {
  prompt: string
  negativePrompt: string
  seed: number
  fixedSeed: boolean
  width: number
  height: number
  steps: number
  cfg: number
  // A real ComfyUI batch (EmptyLatentImage's batch_size) — one job produces
  // this many images in a single sampling pass, not N separate queued jobs.
  // Only the first of the batch is shown inline in the app; all of them are
  // saved to disk and browsable in Galeri either way.
  batchSize: number
  // UI-only, mirrors the video tab's identical field (see fieldMap.ts) —
  // never written into buildImageWorkflow()'s output. Queues this many
  // separate jobs back-to-back instead of asking ComfyUI for a bigger batch,
  // so it stacks with batchSize rather than replacing it (e.g. batchSize 4 +
  // batchCount 3 = 3 separate jobs of 4 images each = 12 images total).
  batchCount: number
  checkpoint: string
  loras: LoraSlot[]
}

function readImageLoraSlots(): LoraSlot[] {
  const raw = (imageTemplateJson as unknown as ComfyWorkflow)[IMAGE_NODE_IDS.loraLoader].inputs
  const slots: LoraSlot[] = []
  for (let i = 1; i <= LORA_SLOT_COUNT; i++) {
    const slot = raw[`lora_${i}`] as LoraSlot | undefined
    slots.push(slot ? { ...slot } : { on: false, lora: '', strength: 1 })
  }
  return slots
}

export function getDefaultImageSettings(): ImageGenerationSettings {
  const t = imageTemplateJson as unknown as ComfyWorkflow
  const positiveInputs = t[IMAGE_NODE_IDS.positivePrompt].inputs as Record<string, unknown>
  const negativeInputs = t[IMAGE_NODE_IDS.negativePrompt].inputs as Record<string, unknown>
  return {
    prompt: String(positiveInputs.wildcard_text ?? ''),
    negativePrompt: String(negativeInputs.wildcard_text ?? ''),
    seed: Number(t[IMAGE_NODE_IDS.seed].inputs.seed ?? 0),
    fixedSeed: false,
    width: Number(t[IMAGE_NODE_IDS.width].inputs.value ?? 1024),
    height: Number(t[IMAGE_NODE_IDS.height].inputs.value ?? 1536),
    steps: Number(t[IMAGE_NODE_IDS.steps].inputs.value ?? 28),
    cfg: Number(t[IMAGE_NODE_IDS.cfg].inputs.value ?? 6),
    batchSize: Number(t[IMAGE_NODE_IDS.batchSize].inputs.value ?? 1),
    batchCount: 1,
    checkpoint: String(t[IMAGE_NODE_IDS.checkpoint].inputs.ckpt_name ?? ''),
    loras: readImageLoraSlots(),
  }
}

export function buildImageWorkflow(settings: ImageGenerationSettings): ComfyWorkflow {
  const workflow = structuredClone(imageTemplateJson) as unknown as ComfyWorkflow

  // ImpactWildcardProcessor's mode is "populate": it takes wildcard_text,
  // resolves any {a|b}/__file__ wildcard syntax using `seed`, and writes the
  // result into populated_text, which is what actually feeds the prompt
  // downstream (via RegexReplace → CLIPTextEncode). The mobile UI's prompt
  // has no wildcard syntax in it, so populating is a no-op either way —
  // setting both keeps them consistent regardless.
  const positiveInputs = workflow[IMAGE_NODE_IDS.positivePrompt].inputs as Record<string, unknown>
  positiveInputs.wildcard_text = settings.prompt
  positiveInputs.populated_text = settings.prompt
  const negativeInputs = workflow[IMAGE_NODE_IDS.negativePrompt].inputs as Record<string, unknown>
  negativeInputs.wildcard_text = settings.negativePrompt
  negativeInputs.populated_text = settings.negativePrompt

  workflow[IMAGE_NODE_IDS.width].inputs.value = settings.width
  workflow[IMAGE_NODE_IDS.height].inputs.value = settings.height
  workflow[IMAGE_NODE_IDS.steps].inputs.value = settings.steps
  workflow[IMAGE_NODE_IDS.cfg].inputs.value = settings.cfg
  workflow[IMAGE_NODE_IDS.batchSize].inputs.value = settings.batchSize
  // Denoise (node 35) is intentionally not user-editable — left at the
  // workflow's own baked-in default (1, full-strength).
  workflow[IMAGE_NODE_IDS.seed].inputs.seed = settings.seed
  workflow[IMAGE_NODE_IDS.checkpoint].inputs.ckpt_name = settings.checkpoint

  const loraInputs = workflow[IMAGE_NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  return workflow
}
