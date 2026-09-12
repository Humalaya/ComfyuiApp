import imageTemplateJson from './imageTemplate.json'
import type { ComfyWorkflow } from '../api/comfyClient'
import { LORA_SLOT_COUNT, type LoraSlot } from './fieldMap'
import { IMAGE_NODE_IDS, type ImageGenerationSettings } from './imageFieldMap'
import { findNodeByIdentity, num } from './pngImportUtils'

export interface ImagePngImportResult {
  settings: Partial<ImageGenerationSettings>
  foundFields: string[]
  missingFields: string[]
}

const template = imageTemplateJson as unknown as ComfyWorkflow

function findNode(prompt: ComfyWorkflow, nodeId: keyof typeof IMAGE_NODE_IDS) {
  return findNodeByIdentity(prompt, template, IMAGE_NODE_IDS[nodeId])
}

const FIELD_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  negativePrompt: 'Negatif Prompt',
  seed: 'Seed',
  size: 'Genişlik/Yükseklik',
  steps: 'Adım Sayısı',
  cfg: 'CFG',
  batchSize: 'Batch Size',
  checkpoint: 'Checkpoint',
  loraLoader: "LoRA'lar",
}

// Same node-identity trick as pngImport.ts (video), just against the SDXL
// Text2Img template — a PNG saved from *this* workflow family recognizes
// every field below regardless of how ComfyUI renumbered its node ids on
// export; a PNG from an unrelated workflow (or the video/Krea2 families)
// correctly finds nothing instead of misreading an unrelated node.
export function extractImageSettingsFromPrompt(prompt: ComfyWorkflow): ImagePngImportResult {
  const settings: Partial<ImageGenerationSettings> = {}
  const foundFields: string[] = []
  const missingFields: string[] = []

  function mark(field: keyof typeof FIELD_LABELS, ok: boolean) {
    ;(ok ? foundFields : missingFields).push(FIELD_LABELS[field])
  }

  const positiveNode = findNode(prompt, 'positivePrompt')
  if (positiveNode) settings.prompt = String(positiveNode.inputs.wildcard_text ?? positiveNode.inputs.populated_text ?? '')
  mark('prompt', !!positiveNode)

  const negativeNode = findNode(prompt, 'negativePrompt')
  if (negativeNode) settings.negativePrompt = String(negativeNode.inputs.wildcard_text ?? negativeNode.inputs.populated_text ?? '')
  mark('negativePrompt', !!negativeNode)

  const seedNode = findNode(prompt, 'seed')
  if (seedNode) {
    settings.seed = num(seedNode.inputs.seed, 0)
    // Importing settings almost always means "reproduce this exact result" —
    // fix the seed so the next generate() doesn't immediately randomize it away.
    settings.fixedSeed = true
  }
  mark('seed', !!seedNode)

  const widthNode = findNode(prompt, 'width')
  const heightNode = findNode(prompt, 'height')
  if (widthNode) settings.width = num(widthNode.inputs.value, 1024)
  if (heightNode) settings.height = num(heightNode.inputs.value, 1536)
  mark('size', !!widthNode && !!heightNode)

  const stepsNode = findNode(prompt, 'steps')
  if (stepsNode) settings.steps = num(stepsNode.inputs.value, 28)
  mark('steps', !!stepsNode)

  const cfgNode = findNode(prompt, 'cfg')
  if (cfgNode) settings.cfg = num(cfgNode.inputs.value, 6)
  mark('cfg', !!cfgNode)

  const batchSizeNode = findNode(prompt, 'batchSize')
  if (batchSizeNode) settings.batchSize = num(batchSizeNode.inputs.value, 1)
  mark('batchSize', !!batchSizeNode)

  const checkpointNode = findNode(prompt, 'checkpoint')
  if (checkpointNode) settings.checkpoint = String(checkpointNode.inputs.ckpt_name ?? '')
  mark('checkpoint', !!checkpointNode)

  const loraNode = findNode(prompt, 'loraLoader')
  if (loraNode) {
    const loras: LoraSlot[] = []
    for (let i = 1; i <= LORA_SLOT_COUNT; i++) {
      const slot = loraNode.inputs[`lora_${i}`] as LoraSlot | undefined
      loras.push(slot ? { on: !!slot.on, lora: String(slot.lora ?? ''), strength: num(slot.strength, 1) } : { on: false, lora: '', strength: 1 })
    }
    settings.loras = loras
  }
  mark('loraLoader', !!loraNode)

  return { settings, foundFields, missingFields }
}
