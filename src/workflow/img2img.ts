// img2img for the SDXL and Krea2 tabs: instead of an empty latent, the
// sampler starts from an uploaded picture — LoadImage → ImageScale (to the
// tab's Genişlik×Yükseklik, center-cropped) → VAEEncode → RepeatLatentBatch
// (one copy per batch image). How much of it survives is the sampler's
// denoise (SDXL "Denoise", Krea2 "Denoise · 1"): ~0.3 keeps it close, ~0.7
// keeps only the composition and colors.
import { viewUrl, type ComfyWorkflow } from '../api/comfyClient'
import type { GenerationSettings } from './fieldMap'

export type InputImageRef = NonNullable<GenerationSettings['inputImage']>

// What a tab's denoise becomes when img2img is switched on while it still
// says 1 (= ignore the picture entirely).
export const IMG2IMG_DEFAULT_DENOISE = 0.6

// Node ids for the added chain — clear of both templates' own ids.
const IDS = { load: '9001', scale: '9002', encode: '9003', repeat: '9004' }

export function applyImg2Img(
  workflow: ComfyWorkflow,
  opts: {
    image: InputImageRef
    vae: [string, number]
    width: number
    height: number
    batchSize: number
    // The sampler input that took the empty latent.
    target: { node: string; input: string }
  },
) {
  const { filename, subfolder } = opts.image
  const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs }) as unknown as ComfyWorkflow[string]
  // "subfolder/filename" when not in the input root — as Anime2Real does.
  workflow[IDS.load] = node('LoadImage', { image: subfolder ? `${subfolder}/${filename}` : filename })
  workflow[IDS.scale] = node('ImageScale', {
    image: [IDS.load, 0],
    upscale_method: 'lanczos',
    width: opts.width,
    height: opts.height,
    crop: 'center',
  })
  workflow[IDS.encode] = node('VAEEncode', { pixels: [IDS.scale, 0], vae: opts.vae })
  workflow[IDS.repeat] = node('RepeatLatentBatch', { samples: [IDS.encode, 0], amount: Math.max(1, Math.round(opts.batchSize)) })
  ;(workflow[opts.target.node].inputs as Record<string, unknown>)[opts.target.input] = [IDS.repeat, 0]
}

export function normalizeInputImage(v: unknown): InputImageRef | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return typeof o.filename === 'string' && typeof o.subfolder === 'string' && typeof o.type === 'string'
    ? { filename: o.filename, subfolder: o.subfolder, type: o.type }
    : null
}

// "Boyutu görselden al": the picture's aspect ratio at about the current
// pixel count, both sides on the 64 grid — so img2img doesn't crop it.
export function sizeForImage(image: InputImageRef, current: { width: number; height: number }): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight
      const pixels = current.width * current.height
      const snap = (v: number) => Math.max(256, Math.round(v / 64) * 64)
      resolve({ width: snap(Math.sqrt(pixels * ratio)), height: snap(Math.sqrt(pixels / ratio)) })
    }
    img.onerror = () => reject(new Error('Görsel okunamadı.'))
    img.src = viewUrl(image.filename, image.subfolder, image.type)
  })
}
