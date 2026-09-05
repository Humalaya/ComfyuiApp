import { useEffect, useState } from 'react'
import { extractComboOptions, getObjectInfo, type ObjectInfoEntry } from '../api/comfyClient'

interface ObjectInfoState {
  aspectRatios: string[]
  unetNames: string[]
  loraNames: string[]
  loading: boolean
  error: string | null
}

const initialState: ObjectInfoState = {
  aspectRatios: [],
  unetNames: [],
  loraNames: [],
  loading: true,
  error: null,
}

// Pulls live dropdown option lists (available models, loras, aspect ratios...)
// straight from the running ComfyUI instance instead of hardcoding them,
// so the UI always matches whatever is actually installed.
export function useObjectInfo() {
  const [state, setState] = useState<ObjectInfoState>(initialState)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [resolution, unet, lora] = await Promise.all([
          getObjectInfo('ResolutionSelector').catch(() => ({}) as Record<string, ObjectInfoEntry>),
          getObjectInfo('UNETLoader').catch(() => ({}) as Record<string, ObjectInfoEntry>),
          getObjectInfo('LoraLoader').catch(() => ({}) as Record<string, ObjectInfoEntry>),
        ])
        if (cancelled) return
        setState({
          aspectRatios: extractComboOptions(resolution['ResolutionSelector'], 'aspect_ratio'),
          unetNames: extractComboOptions(unet['UNETLoader'], 'unet_name'),
          loraNames: extractComboOptions(lora['LoraLoader'], 'lora_name'),
          loading: false,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        setState({ ...initialState, loading: false, error: (err as Error).message })
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
