import templateJson from './template.json'
import { parseComfyWorkflowJson, readPngTextChunks } from '../utils/pngMetadata'
import type { ComfyWorkflow } from '../api/comfyClient'
import { LORA_SLOT_COUNT, NODE_IDS, type GenerationSettings, type LoraSlot } from './fieldMap'
import { findNodeByIdentity, num } from './pngImportUtils'

export interface PngImportResult {
  settings: Partial<GenerationSettings>
  foundFields: string[]
  missingFields: string[]
}

const template = templateJson as unknown as ComfyWorkflow

// Reuses the exact node identity (class_type + title) our own template already
// uses for each field — never a guessed/new mapping — so this only recognizes
// PNGs that came from this same MiniMax H3 workflow family. If a PNG's node ids
// were renumbered on a later export, class_type + title still finds the field;
// if it's from an unrelated workflow, the field is correctly reported missing
// instead of guessing a value from an unrelated node.
function findNode(prompt: ComfyWorkflow, nodeId: keyof typeof NODE_IDS) {
  return findNodeByIdentity(prompt, template, NODE_IDS[nodeId])
}

export async function extractPromptFromPng(file: Blob): Promise<ComfyWorkflow> {
  const chunks = await readPngTextChunks(file)
  const raw = chunks.prompt
  if (!raw) {
    throw new Error(
      'Bu PNG içinde ComfyUI workflow metadata\'sı (prompt bilgisi) bulunamadı. Görsel ComfyUI dışında oluşturulmuş ya da metadata kaydı kapalıyken üretilmiş olabilir.',
    )
  }
  try {
    return parseComfyWorkflowJson(raw) as ComfyWorkflow
  } catch {
    throw new Error('PNG içindeki workflow metadata\'sı okunamadı (bozuk JSON).')
  }
}

const FIELD_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  seed: 'Seed',
  resolution: 'En-boy oranı / megapiksel',
  videoLength: 'Süre',
  framerate: 'FPS',
  model: 'Model',
  totalSteps: 'Adım sayısı',
  inputImage: 'Girdi görseli',
  loraLoader: "LoRA'lar",
}

export function extractSettingsFromPrompt(prompt: ComfyWorkflow): PngImportResult {
  const settings: Partial<GenerationSettings> = {}
  const foundFields: string[] = []
  const missingFields: string[] = []

  function mark(field: keyof typeof FIELD_LABELS, ok: boolean) {
    ;(ok ? foundFields : missingFields).push(FIELD_LABELS[field])
  }

  const promptNode = findNode(prompt, 'prompt')
  if (promptNode) {
    settings.prompt = String(promptNode.inputs.value ?? '')
  }
  mark('prompt', !!promptNode)

  const seedNode = findNode(prompt, 'seed')
  if (seedNode) {
    settings.seed = num(seedNode.inputs.seed, 0)
    // Importing settings almost always means "reproduce this exact result" —
    // fix the seed so the next generate() doesn't immediately randomize it away.
    settings.fixedSeed = true
  }
  mark('seed', !!seedNode)

  const resolutionNode = findNode(prompt, 'resolution')
  if (resolutionNode) {
    settings.aspectRatio = String(resolutionNode.inputs.aspect_ratio ?? '')
    settings.megapixels = num(resolutionNode.inputs.megapixels, 2)
  }
  mark('resolution', !!resolutionNode)

  const videoLengthNode = findNode(prompt, 'videoLength')
  if (videoLengthNode) settings.videoLengthSeconds = num(videoLengthNode.inputs.value, 5)
  mark('videoLength', !!videoLengthNode)

  const framerateNode = findNode(prompt, 'framerate')
  if (framerateNode) settings.framerate = num(framerateNode.inputs.value, 24)
  mark('framerate', !!framerateNode)

  const modelNode = findNode(prompt, 'model')
  if (modelNode) settings.unetName = String(modelNode.inputs.unet_name ?? '')
  mark('model', !!modelNode)

  const stepsNode = findNode(prompt, 'totalSteps')
  if (stepsNode) settings.totalSteps = num(stepsNode.inputs.value, 10)
  mark('totalSteps', !!stepsNode)

  const inputImageNode = findNode(prompt, 'inputImage')
  const imagePath = inputImageNode ? String(inputImageNode.inputs.image ?? '') : ''
  if (imagePath) {
    const slashIdx = imagePath.lastIndexOf('/')
    settings.inputImage =
      slashIdx === -1
        ? { filename: imagePath, subfolder: '', type: 'input' }
        : { filename: imagePath.slice(slashIdx + 1), subfolder: imagePath.slice(0, slashIdx), type: 'input' }
  }
  mark('inputImage', !!imagePath)

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
