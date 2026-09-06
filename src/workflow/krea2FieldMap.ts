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
} as const

export const KREA2_LORA_SLOT_COUNT = 22

// SaveImage — the only node here that actually persists a file, so it's
// what shows up under ComfyUI's /history "outputs".
export const KREA2_OUTPUT_NODE_ID = '112'

export interface Krea2GenerationSettings {
  prompt: string
  negativePrompt: string
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
    negativePrompt: String(t[KREA2_NODE_IDS.negativePrompt].inputs.text ?? ''),
    seed: Number(t[KREA2_NODE_IDS.seedEnhancer].inputs.seed ?? 0),
    fixedSeed: false,
    width: Number(t[KREA2_NODE_IDS.latent].inputs.width ?? 1440),
    height: Number(t[KREA2_NODE_IDS.latent].inputs.height ?? 1920),
    batchSize: Number(t[KREA2_NODE_IDS.latent].inputs.batch_size ?? 1),
    batchCount: 1,
    steps1: Number(t[KREA2_NODE_IDS.pass1].inputs.steps ?? 12),
    steps2: Number(t[KREA2_NODE_IDS.pass2].inputs.steps ?? 3),
    loras: readKrea2LoraSlots(),
  }
}

export function buildKrea2Workflow(settings: Krea2GenerationSettings): ComfyWorkflow {
  const workflow = structuredClone(krea2TemplateJson) as unknown as ComfyWorkflow

  workflow[KREA2_NODE_IDS.positivePrompt].inputs.text = settings.prompt
  workflow[KREA2_NODE_IDS.negativePrompt].inputs.text = settings.negativePrompt
  workflow[KREA2_NODE_IDS.latent].inputs.width = settings.width
  workflow[KREA2_NODE_IDS.latent].inputs.height = settings.height
  workflow[KREA2_NODE_IDS.latent].inputs.batch_size = settings.batchSize

  workflow[KREA2_NODE_IDS.seedEnhancer].inputs.seed = settings.seed
  workflow[KREA2_NODE_IDS.pass1].inputs.seed = settings.seed
  workflow[KREA2_NODE_IDS.pass2].inputs.seed = settings.seed
  workflow[KREA2_NODE_IDS.pass1].inputs.steps = settings.steps1
  workflow[KREA2_NODE_IDS.pass2].inputs.steps = settings.steps2

  const loraInputs = workflow[KREA2_NODE_IDS.loraLoader].inputs
  settings.loras.forEach((slot, i) => {
    loraInputs[`lora_${i + 1}`] = { on: slot.on, lora: slot.lora, strength: slot.strength }
  })

  return workflow
}
