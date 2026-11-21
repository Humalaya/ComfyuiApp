import type { ComfyWorkflow } from '../api/comfyClient'

// Galeri's "🔍 Büyüt": an upscale model (ESRGAN family, e.g. 4x-UltraSharp,
// from ComfyUI/models/upscale_models) enlarges the picture; no diffusion, so
// nothing about the picture changes, it only gets bigger and sharper.

// Gallery source id → its folder under ComfyUI's output/ (the same
// filename_prefix roots the generation templates save under).
const OUTPUT_SUBDIR: Record<string, string> = { video: 'video', krea: 'krea', sdxl: 'image' }

export const UPSCALE_FACTORS = [2, 4] as const
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number]

// "4x-UltraSharp.pth", "RealESRGAN_x2plus.pth" → 4, 2. Most such models are
// 4×, so that's assumed when the name doesn't say.
export function modelScale(modelName: string): number {
  const m = /(?:^|[^0-9])([1-8])x|x([1-8])(?:[^0-9]|$)/i.exec(modelName)
  return m ? Number(m[1] ?? m[2]) : 4
}

export function canUpscaleSource(source: string): boolean {
  return source in OUTPUT_SUBDIR
}

// `name` is the gallery item's path inside its source ("2026-11-21/x.png").
// The result is saved beside it, as "<stem>_2x_00001_.png".
export function buildUpscaleWorkflow(source: string, name: string, model: string, factor: UpscaleFactor): ComfyWorkflow {
  const subdir = OUTPUT_SUBDIR[source]
  if (!subdir) throw new Error(`Bu kaynak büyütülemez: ${source}`)
  const dot = name.lastIndexOf('.')
  const stem = dot > name.lastIndexOf('/') ? name.slice(0, dot) : name
  const native = modelScale(model)

  const workflow: ComfyWorkflow = {
    '1': {
      class_type: 'LoadImage',
      // The file already sits in ComfyUI's output folder — an "[output]"
      // annotated path loads it from there, no upload needed.
      inputs: { image: `${subdir}/${name} [output]` },
      _meta: { title: 'Galeri görseli' },
    },
    '2': { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
    '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
  }
  let out: [string, number] = ['3', 0]
  if (native !== factor) {
    // A 4× model asked for 2×: run the model, then resize down — still
    // sharper than a 2× resize of the original.
    workflow['4'] = { class_type: 'ImageScaleBy', inputs: { image: out, upscale_method: 'lanczos', scale_by: factor / native } }
    out = ['4', 0]
  }
  workflow['9'] = {
    class_type: 'SaveImage',
    inputs: { images: out, filename_prefix: `${subdir}/${stem}_${factor}x` },
    _meta: { title: 'Büyütülmüş' },
  }
  return workflow
}
