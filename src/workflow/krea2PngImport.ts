import krea2TemplateJson from './krea2Template.json'
import type { ComfyWorkflow } from '../api/comfyClient'
import type { LoraSlot } from './fieldMap'
import { KREA2_LORA_SLOT_COUNT, KREA2_NODE_IDS, type Krea2GenerationSettings } from './krea2FieldMap'
import { findNodeByIdentity, num } from './pngImportUtils'

export interface Krea2PngImportResult {
  settings: Partial<Krea2GenerationSettings>
  foundFields: string[]
  missingFields: string[]
}

const template = krea2TemplateJson as unknown as ComfyWorkflow

function findNode(prompt: ComfyWorkflow, nodeId: keyof typeof KREA2_NODE_IDS) {
  return findNodeByIdentity(prompt, template, KREA2_NODE_IDS[nodeId])
}

const FIELD_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  unetName: 'Model',
  seed: 'Seed',
  size: 'Genişlik/Yükseklik/Batch Size',
  steps1: 'Adım Sayısı (1. Geçiş)',
  steps2: 'Adım Sayısı (2. Geçiş)',
  loraLoader: "LoRA'lar",
}

// Same node-identity trick as pngImport.ts (video)/imagePngImport.ts (SDXL),
// against the Krea2 (FLUX) template instead — no negativePrompt field here
// since Krea2GenerationSettings doesn't expose one (removed from the UI, see
// krea2FieldMap.ts).
export function extractKrea2SettingsFromPrompt(prompt: ComfyWorkflow): Krea2PngImportResult {
  const settings: Partial<Krea2GenerationSettings> = {}
  const foundFields: string[] = []
  const missingFields: string[] = []

  function mark(field: keyof typeof FIELD_LABELS, ok: boolean) {
    ;(ok ? foundFields : missingFields).push(FIELD_LABELS[field])
  }

  const positiveNode = findNode(prompt, 'positivePrompt')
  if (positiveNode) settings.prompt = String(positiveNode.inputs.text ?? '')
  mark('prompt', !!positiveNode)

  const modelNode = findNode(prompt, 'diffusionModel')
  if (modelNode) settings.unetName = String(modelNode.inputs.unet_name ?? '')
  mark('unetName', !!modelNode)

  // This workflow has no single shared SeedNode (see krea2FieldMap.ts) — the
  // seed enhancer node is as good a source as any of the three literal seed
  // values, since buildKrea2Workflow writes one seed into all three anyway.
  const seedNode = findNode(prompt, 'seedEnhancer')
  if (seedNode) {
    settings.seed = num(seedNode.inputs.seed, 0)
    settings.fixedSeed = true
  }
  mark('seed', !!seedNode)

  const latentNode = findNode(prompt, 'latent')
  if (latentNode) {
    settings.width = num(latentNode.inputs.width, 1440)
    settings.height = num(latentNode.inputs.height, 1920)
    settings.batchSize = num(latentNode.inputs.batch_size, 1)
  }
  mark('size', !!latentNode)

  const pass1Node = findNode(prompt, 'pass1')
  if (pass1Node) settings.steps1 = num(pass1Node.inputs.steps, 12)
  mark('steps1', !!pass1Node)

  const pass2Node = findNode(prompt, 'pass2')
  if (pass2Node) settings.steps2 = num(pass2Node.inputs.steps, 3)
  mark('steps2', !!pass2Node)

  const loraNode = findNode(prompt, 'loraLoader')
  if (loraNode) {
    const loras: LoraSlot[] = []
    for (let i = 1; i <= KREA2_LORA_SLOT_COUNT; i++) {
      const slot = loraNode.inputs[`lora_${i}`] as LoraSlot | undefined
      loras.push(slot ? { on: !!slot.on, lora: String(slot.lora ?? ''), strength: num(slot.strength, 1) } : { on: false, lora: '', strength: 1 })
    }
    settings.loras = loras
  }
  mark('loraLoader', !!loraNode)

  return { settings, foundFields, missingFields }
}
