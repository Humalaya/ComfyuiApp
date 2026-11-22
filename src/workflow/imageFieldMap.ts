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
  positiveEncode: '36', // CLIPTextEncode fed by 3 → 39 (RegexReplace)
  negativeEncode: '38',
  width: '1',
  height: '11',
  steps: '17',
  cfg: '18',
  batchSize: '23',
  seed: '40',
  checkpoint: '45',
  loraLoader: '27',
  sampler: '41', // KSampler — sampler_name/scheduler are literal here
  denoiseValue: '35', // "easy float" node KSampler.denoise links to
  // FaceDetailerPipe — the face touch-up pass after the main sampler.
  faceDetailer: '31',
  clipSkip: '51', // CLIPSetLastLayer — stop_at_clip_layer = -clipSkip
  decode: '33', // VAEDecode of the main sampler — the image before touch-up
  saveImage: '50',
  comparer: '57', // Image Comparer (before/after), only meaningful with the touch-up
} as const

// The output actually worth watching in ComfyUI's /history: node 31
// (FaceDetailer) processes the image but never saves it — node 50
// (SaveImage) is what ComfyUI records under "outputs", same as
// VIDEO_OUTPUT_NODE_ID points at the video-workflow's actual save node.
export const IMAGE_OUTPUT_NODE_ID = '50'

// Checkpoint-family "quality tags" — the fixed positive/negative snippets
// certain SDXL finetune families expect at the front of the prompt for
// their trained quality conditioning to actually kick in (Pony Diffusion's
// score_9.../score_6... convention, Illustrious/anime finetunes' more
// generic masterpiece/best quality convention). These are merged into the
// actual prompt text sent to ComfyUI (see buildImageWorkflow) but never
// written into settings.prompt/negativePrompt themselves — the visible
// Prompt/Negatif Prompt fields only ever show what the user actually typed.
export const QUALITY_PRESETS = {
  pony: {
    label: 'Pony',
    positive: 'score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up,',
    negative: 'score_6, score_5, score_4, worst quality, low quality, blurry,',
  },
  illustrious: {
    label: 'Illustrious',
    positive: 'masterpiece, best quality, very aesthetic, absurdres,',
    negative: 'bad quality, worst quality, worst detail, sketch, jpeg artifacts, signature, watermark, username, blurry,',
  },
} as const

export type QualityPreset = 'none' | keyof typeof QUALITY_PRESETS

export interface ImageGenerationSettings {
  prompt: string
  negativePrompt: string
  // 'none' by default — see QUALITY_PRESETS above for what each one adds.
  qualityPreset: QualityPreset
  seed: number
  fixedSeed: boolean
  width: number
  height: number
  steps: number
  cfg: number
  samplerName: string
  scheduler: string
  denoise: number
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
  // FaceDetailer pass: re-renders detected faces at higher resolution after
  // the main image. Off → the main sampler's image is saved as is.
  faceDetailer: boolean
  faceDetailerSteps: number
  // A1111-style clip skip (2 → CLIPSetLastLayer -2).
  clipSkip: number
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
    qualityPreset: 'none',
    seed: Number(t[IMAGE_NODE_IDS.seed].inputs.seed ?? 0),
    fixedSeed: false,
    width: Number(t[IMAGE_NODE_IDS.width].inputs.value ?? 1024),
    height: Number(t[IMAGE_NODE_IDS.height].inputs.value ?? 1536),
    steps: Number(t[IMAGE_NODE_IDS.steps].inputs.value ?? 28),
    cfg: Number(t[IMAGE_NODE_IDS.cfg].inputs.value ?? 6),
    samplerName: String(t[IMAGE_NODE_IDS.sampler].inputs.sampler_name ?? 'euler_ancestral'),
    scheduler: String(t[IMAGE_NODE_IDS.sampler].inputs.scheduler ?? 'normal'),
    // The sampler node's own denoise input is a *link* to denoiseValue
    // rather than a literal — buildImageWorkflow overwrites it with a
    // literal either way, same as sampler_name/scheduler above.
    denoise: Number(t[IMAGE_NODE_IDS.denoiseValue].inputs.value ?? 1),
    batchSize: Number(t[IMAGE_NODE_IDS.batchSize].inputs.value ?? 1),
    batchCount: 1,
    checkpoint: String(t[IMAGE_NODE_IDS.checkpoint].inputs.ckpt_name ?? ''),
    loras: readImageLoraSlots(),
    faceDetailer: true,
    faceDetailerSteps: Number(t[IMAGE_NODE_IDS.faceDetailer].inputs.steps ?? 14),
    clipSkip: Math.abs(Number(t[IMAGE_NODE_IDS.clipSkip].inputs.stop_at_clip_layer ?? -2)),
  }
}

// A1111-style BREAK, which ComfyUI's CLIPTextEncode doesn't know (it would
// just read the word "break"). BREAK means "encode the next part as its own
// CLIP chunk" — in ComfyUI that's encoding each part separately and joining
// them with ConditioningConcat. Keeps one person's colors / clothes from
// bleeding into another's. The first part stays in the template's own
// wildcard → regex → encode chain; every later part gets its own encoder,
// and whatever used the template's encoder (KSampler, the face detailer
// pipe) is rewired to the end of the concat chain.
export function splitBreak(text: string): string[] {
  return text
    .split(/\bBREAK\b/)
    .map((part) => part.trim().replace(/^[\s,]+|[\s,]+$/g, ''))
    .filter(Boolean)
}

function applyBreakChunks(workflow: ComfyWorkflow, encoderId: string, clip: unknown, parts: string[], idBase: number) {
  let prev: [string, number] = [encoderId, 0]
  parts.forEach((part, i) => {
    const enc = String(idBase + i * 2)
    const cat = String(idBase + i * 2 + 1)
    workflow[enc] = { class_type: 'CLIPTextEncode', inputs: { text: part, clip } } as ComfyWorkflow[string]
    workflow[cat] = {
      class_type: 'ConditioningConcat',
      inputs: { conditioning_to: prev, conditioning_from: [enc, 0] },
    } as ComfyWorkflow[string]
    prev = [cat, 0]
  })
  const added = new Set(parts.flatMap((_, i) => [String(idBase + i * 2), String(idBase + i * 2 + 1)]))
  for (const [id, node] of Object.entries(workflow)) {
    if (added.has(id)) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value[0] === encoderId && value[1] === 0) (node.inputs as Record<string, unknown>)[key] = prev
    }
  }
}

export function buildImageWorkflow(settings: ImageGenerationSettings): ComfyWorkflow {
  const workflow = structuredClone(imageTemplateJson) as unknown as ComfyWorkflow

  // The selected checkpoint family's quality tags (if any) are prepended
  // here, at submit time — never merged into settings.prompt/negativePrompt
  // themselves, so the visible Prompt/Negatif Prompt fields always show
  // exactly what the user typed, nothing more.
  const preset = settings.qualityPreset !== 'none' ? QUALITY_PRESETS[settings.qualityPreset] : null
  const finalPositive = preset ? `${preset.positive} ${settings.prompt}` : settings.prompt
  const finalNegative = preset ? `${preset.negative} ${settings.negativePrompt}` : settings.negativePrompt

  // ImpactWildcardProcessor's mode is "populate": it takes wildcard_text,
  // resolves any {a|b}/__file__ wildcard syntax using `seed`, and writes the
  // result into populated_text, which is what actually feeds the prompt
  // downstream (via RegexReplace → CLIPTextEncode). The mobile UI's prompt
  // has no wildcard syntax in it, so populating is a no-op either way —
  // setting both keeps them consistent regardless.
  const [positiveHead, ...positiveRest] = splitBreak(finalPositive)
  const [negativeHead, ...negativeRest] = splitBreak(finalNegative)
  const positiveInputs = workflow[IMAGE_NODE_IDS.positivePrompt].inputs as Record<string, unknown>
  positiveInputs.wildcard_text = positiveHead ?? ''
  positiveInputs.populated_text = positiveHead ?? ''
  const negativeInputs = workflow[IMAGE_NODE_IDS.negativePrompt].inputs as Record<string, unknown>
  negativeInputs.wildcard_text = negativeHead ?? ''
  negativeInputs.populated_text = negativeHead ?? ''
  // Same CLIP (after clip skip + LoRAs) the template's encoders use.
  const clip = workflow[IMAGE_NODE_IDS.positiveEncode].inputs.clip
  if (positiveRest.length) applyBreakChunks(workflow, IMAGE_NODE_IDS.positiveEncode, clip, positiveRest, 9100)
  if (negativeRest.length) applyBreakChunks(workflow, IMAGE_NODE_IDS.negativeEncode, clip, negativeRest, 9200)

  workflow[IMAGE_NODE_IDS.width].inputs.value = settings.width
  workflow[IMAGE_NODE_IDS.height].inputs.value = settings.height
  workflow[IMAGE_NODE_IDS.steps].inputs.value = settings.steps
  workflow[IMAGE_NODE_IDS.cfg].inputs.value = settings.cfg
  workflow[IMAGE_NODE_IDS.batchSize].inputs.value = settings.batchSize
  workflow[IMAGE_NODE_IDS.sampler].inputs.sampler_name = settings.samplerName
  workflow[IMAGE_NODE_IDS.sampler].inputs.scheduler = settings.scheduler
  // Overwrites the link to node 35 with a literal — same reasoning as the
  // video tab's identical override in fieldMap.ts.
  workflow[IMAGE_NODE_IDS.sampler].inputs.denoise = settings.denoise
  workflow[IMAGE_NODE_IDS.seed].inputs.seed = settings.seed
  workflow[IMAGE_NODE_IDS.checkpoint].inputs.ckpt_name = settings.checkpoint

  const loraInputs = workflow[IMAGE_NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  workflow[IMAGE_NODE_IDS.clipSkip].inputs.stop_at_clip_layer = -Math.max(1, Math.round(settings.clipSkip))

  if (settings.faceDetailer) {
    workflow[IMAGE_NODE_IDS.faceDetailer].inputs.steps = settings.faceDetailerSteps
  } else {
    // Save the main sampler's image directly. The detailer and the
    // before/after comparer are removed; the detector/pipe nodes left
    // behind feed no output, so ComfyUI doesn't run them.
    workflow[IMAGE_NODE_IDS.saveImage].inputs.images = [IMAGE_NODE_IDS.decode, 0]
    delete workflow[IMAGE_NODE_IDS.faceDetailer]
    delete workflow[IMAGE_NODE_IDS.comparer]
  }

  return workflow
}
