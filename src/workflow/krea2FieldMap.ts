import krea2TemplateJson from './krea2Template.json'
import type { ComfyWorkflow } from '../api/comfyClient'
import { type LoraSlot } from './fieldMap'

// Node ids inside the Krea2 (FLUX) Text2Img workflow — keep in sync with
// krea2Template.json.
//
// This workflow's original export was missing three real connections
// (Power Lora Loader's model/clip inputs, and both CLIPTextEncode nodes'
// clip input) — ComfyUI's static validator didn't catch it because those
// inputs are declared optional on the receiving nodes, but the actual node
// code crashes on a missing one at runtime. Traced and fixed by hand,
// verified with a real end-to-end generation before this went into the app.
export const KREA2_NODE_IDS = {
  positivePrompt: '91:104',
  // Not user-editable (see Krea2GenerationSettings) — kept at the
  // workflow's own baked-in default text, never touched by
  // buildKrea2Workflow. Recorded here only so it's clear where that
  // default lives, in case it's ever worth exposing again.
  negativePrompt: '91:96',
  // EmptyLatentImage — width/height/batch_size all live here.
  latent: '91:93',
  loraLoader: '113',
  // Unlike the other two workflows, this one has no single shared SeedNode
  // feeding every consumer via links — each of these three nodes carries
  // its own literal seed value. buildKrea2Workflow writes the same seed
  // into all three so "Seed" behaves as one control in the UI.
  seedEnhancer: '43',
  pass1: '91:108',
  pass2: '91:109',
  diffusionModel: '91:100', // UNETLoader — the actual FLUX/Krea2 checkpoint
} as const

export const KREA2_LORA_SLOT_COUNT = 22

// SaveImage — the only node here that actually persists a file, so it's
// what shows up under ComfyUI's /history "outputs".
export const KREA2_OUTPUT_NODE_ID = '112'

export interface Krea2GenerationSettings {
  prompt: string
  // UNETLoader's unet_name — the "Image/" folder (per this app's own
  // image-vs-video diffusion_models split, see useObjectInfo.ts) holds every
  // FLUX/Krea2-compatible checkpoint, so this dropdown lists that, same as
  // the video tab's Model dropdown lists the "Video/" folder.
  unetName: string
  // No negativePrompt field here — removed from the UI on request. The
  // underlying CLIPTextEncode node (KREA2_NODE_IDS.negativePrompt) still
  // exists in the workflow, just left at its own fixed default text.
  seed: number
  fixedSeed: boolean
  width: number
  height: number
  // Real ComfyUI batch (EmptyLatentImage's batch_size, same node as
  // width/height) — one job produces this many images in one pass.
  batchSize: number
  // UI-only, mirrors the video tab's identical field (see fieldMap.ts) —
  // never written into buildKrea2Workflow()'s output. Queues this many
  // separate jobs back-to-back on top of batchSize rather than in place of
  // it (batchSize 4 + batchCount 3 = 3 jobs of 4 images each = 12 total).
  batchCount: number
  // This workflow's two Clownshark sampler passes each have their own step
  // count by design (a coarse first pass, a quick low-denoise refine pass)
  // — exposed as two separate fields rather than one, since collapsing them
  // into a single "steps" control would mean inventing a scaling rule that
  // doesn't exist in the original workflow.
  steps1: number
  steps2: number
  // Same "each pass has its own everything" reasoning as steps1/steps2 —
  // sampler/scheduler/denoise are independent controls per pass, not one
  // shared triple, matching how the two ClownsharKSampler_Beta nodes are
  // actually configured in the original workflow (a completely different
  // sampler/scheduler pair on each pass, denoise 1 → 0.27).
  samplerName1: string
  scheduler1: string
  denoise1: number
  samplerName2: string
  scheduler2: string
  denoise2: number
  loras: LoraSlot[]
}

function readKrea2LoraSlots(): LoraSlot[] {
  const raw = (krea2TemplateJson as unknown as ComfyWorkflow)[KREA2_NODE_IDS.loraLoader].inputs
  const slots: LoraSlot[] = []
  for (let i = 1; i <= KREA2_LORA_SLOT_COUNT; i++) {
    const slot = raw[`lora_${i}`] as LoraSlot | undefined
    slots.push(slot ? { ...slot } : { on: false, lora: '', strength: 1 })
  }
  return slots
}

export function getDefaultKrea2Settings(): Krea2GenerationSettings {
  const t = krea2TemplateJson as unknown as ComfyWorkflow
  return {
    prompt: String(t[KREA2_NODE_IDS.positivePrompt].inputs.text ?? ''),
    unetName: String(t[KREA2_NODE_IDS.diffusionModel].inputs.unet_name ?? ''),
    seed: Number(t[KREA2_NODE_IDS.seedEnhancer].inputs.seed ?? 0),
    fixedSeed: false,
    width: Number(t[KREA2_NODE_IDS.latent].inputs.width ?? 1440),
    height: Number(t[KREA2_NODE_IDS.latent].inputs.height ?? 1920),
    batchSize: Number(t[KREA2_NODE_IDS.latent].inputs.batch_size ?? 1),
    batchCount: 1,
    steps1: Number(t[KREA2_NODE_IDS.pass1].inputs.steps ?? 12),
    steps2: Number(t[KREA2_NODE_IDS.pass2].inputs.steps ?? 3),
    samplerName1: String(t[KREA2_NODE_IDS.pass1].inputs.sampler_name ?? 'linear/euler'),
    scheduler1: String(t[KREA2_NODE_IDS.pass1].inputs.scheduler ?? 'beta'),
    denoise1: Number(t[KREA2_NODE_IDS.pass1].inputs.denoise ?? 1),
    samplerName2: String(t[KREA2_NODE_IDS.pass2].inputs.sampler_name ?? 'exponential/res_4s_munthe-kaas'),
    scheduler2: String(t[KREA2_NODE_IDS.pass2].inputs.scheduler ?? 'kl_optimal'),
    denoise2: Number(t[KREA2_NODE_IDS.pass2].inputs.denoise ?? 0.27),
    loras: readKrea2LoraSlots(),
  }
}

export function buildKrea2Workflow(settings: Krea2GenerationSettings): ComfyWorkflow {
  const workflow = structuredClone(krea2TemplateJson) as unknown as ComfyWorkflow

  workflow[KREA2_NODE_IDS.positivePrompt].inputs.text = settings.prompt
  workflow[KREA2_NODE_IDS.diffusionModel].inputs.unet_name = settings.unetName
  // Negative prompt intentionally left untouched — see Krea2GenerationSettings.
  workflow[KREA2_NODE_IDS.latent].inputs.width = settings.width
  workflow[KREA2_NODE_IDS.latent].inputs.height = settings.height
  workflow[KREA2_NODE_IDS.latent].inputs.batch_size = settings.batchSize

  workflow[KREA2_NODE_IDS.seedEnhancer].inputs.seed = settings.seed
  workflow[KREA2_NODE_IDS.pass1].inputs.seed = settings.seed
  workflow[KREA2_NODE_IDS.pass2].inputs.seed = settings.seed
  workflow[KREA2_NODE_IDS.pass1].inputs.steps = settings.steps1
  workflow[KREA2_NODE_IDS.pass2].inputs.steps = settings.steps2
  workflow[KREA2_NODE_IDS.pass1].inputs.sampler_name = settings.samplerName1
  workflow[KREA2_NODE_IDS.pass1].inputs.scheduler = settings.scheduler1
  workflow[KREA2_NODE_IDS.pass1].inputs.denoise = settings.denoise1
  workflow[KREA2_NODE_IDS.pass2].inputs.sampler_name = settings.samplerName2
  workflow[KREA2_NODE_IDS.pass2].inputs.scheduler = settings.scheduler2
  workflow[KREA2_NODE_IDS.pass2].inputs.denoise = settings.denoise2

  const loraInputs = workflow[KREA2_NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  return workflow
}
