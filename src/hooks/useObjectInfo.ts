import { useEffect, useState } from 'react'
import { extractComboOptions, getObjectInfo } from '../api/comfyClient'

interface ObjectInfoState {
  aspectRatios: string[]
  unetNames: string[]
  // Same UNETLoader combo as unetNames, filtered to the "image" subfolder
  // instead of "video" — Krea2/FLUX's diffusion model lives there (see
  // krea2FieldMap.ts), sharing the folder with SDXL-adjacent checkpoints even
  // though SDXL itself uses a separate CheckpointLoaderSimple, not UNETLoader.
  krea2UnetNames: string[]
  loraNames: string[]
  // Checkpoints (used by the Text2Img screen's CheckpointLoaderSimple) —
  // fetched here alongside everything else rather than in a separate hook,
  // since loraNames is already shared between the video and image screens
  // the same way (same underlying folder, regardless of which node class
  // exposes the combo).
  checkpointNames: string[]
  // Standard ComfyUI sampler/scheduler enums — confirmed via /object_info to
  // be the exact same list on plain KSampler (SDXL), KSamplerSelect (video),
  // and BasicScheduler's own scheduler field (video), so one fetch covers
  // both the SDXL and video tabs' "Gelişmiş Ayarlar".
  samplerNames: string[]
  schedulerNames: string[]
  // Krea2's ClownsharKSampler_Beta (RES4LYF) has its own, much larger sampler
  // list — completely different from the standard one above — but the same
  // standard scheduler list, so it reuses schedulerNames rather than needing
  // its own.
  krea2SamplerNames: string[]
  loading: boolean
  error: string | null
}

const initialState: ObjectInfoState = {
  aspectRatios: [],
  unetNames: [],
  krea2UnetNames: [],
  loraNames: [],
  checkpointNames: [],
  samplerNames: [],
  schedulerNames: [],
  krea2SamplerNames: [],
  loading: true,
  error: null,
}

const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000

// The user organizes diffusion models with an "image" vs "video" subfolder
// (diffusion_models/Image + Video) — ComfyUI's combo list returns the
// subfolder as part of the path (e.g. "Video/minimaxH3..."), so filtering on
// it keeps a FLUX diffusion-only file dropped into diffusion_models/Image
// out of the video tab's Model list. Case-insensitive since the folders mix
// "Image"/"image" casing.
function filterByFolder(names: string[], folder: 'image' | 'video'): string[] {
  const prefix = `${folder}/`
  return names.filter((n) => n.toLowerCase().startsWith(prefix))
}

// Pulls live dropdown option lists (available models, loras, aspect ratios...)
// straight from the running ComfyUI instance instead of hardcoding them,
// so the UI always matches whatever is actually installed.
//
// An unrecognized class_type (a node genuinely not installed on this ComfyUI)
// is not a failure here — /object_info/<anything unknown> resolves with
// `{}` (HTTP 200), not an error, so extractComboOptions just yields an empty
// list for that one field. The only thing that actually throws is ComfyUI
// being unreachable — most commonly caught mid-startup (the app opened in
// the few seconds between the process starting and it actually listening on
// its port). That's retried with backoff instead of requiring a manual page
// reload once ComfyUI finishes coming up.
export function useObjectInfo() {
  const [state, setState] = useState<ObjectInfoState>(initialState)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryDelay = RETRY_BASE_MS

    async function load() {
      try {
        const [resolution, unet, lora, checkpoint, ksampler, krea2Sampler] = await Promise.all([
          getObjectInfo('ResolutionSelector'),
          getObjectInfo('UNETLoader'),
          getObjectInfo('LoraLoader'),
          getObjectInfo('CheckpointLoaderSimple'),
          getObjectInfo('KSampler'),
          getObjectInfo('ClownsharKSampler_Beta'),
        ])
        if (cancelled) return
        setState({
          aspectRatios: extractComboOptions(resolution['ResolutionSelector'], 'aspect_ratio'),
          unetNames: filterByFolder(extractComboOptions(unet['UNETLoader'], 'unet_name'), 'video'),
          krea2UnetNames: filterByFolder(extractComboOptions(unet['UNETLoader'], 'unet_name'), 'image'),
          loraNames: extractComboOptions(lora['LoraLoader'], 'lora_name'),
          checkpointNames: extractComboOptions(checkpoint['CheckpointLoaderSimple'], 'ckpt_name'),
          samplerNames: extractComboOptions(ksampler['KSampler'], 'sampler_name'),
          schedulerNames: extractComboOptions(ksampler['KSampler'], 'scheduler'),
          krea2SamplerNames: extractComboOptions(krea2Sampler['ClownsharKSampler_Beta'], 'sampler_name'),
          loading: false,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        setState((s) => ({ ...s, loading: false, error: (err as Error).message }))
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
          load()
        }, retryDelay)
      }
    }

    load()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [])

  return state
}
