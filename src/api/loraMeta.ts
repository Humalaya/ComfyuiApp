import { useEffect, useState } from 'react'

// Which base model each LoRA was trained for — read by the output-server
// from each .safetensors header (see /api/loras/meta in server/index.js) so
// the LoRA picker can default to only the LoRAs that work with the current
// tab's model.
export type LoraFamily = 'video' | 'sdxl' | 'krea2' | 'sd1' | 'other'

// The Create tab a LoRA list lives on — the families it can actually use.
export type LoraTab = 'video' | 'sdxl' | 'krea2'

// For files whose header doesn't say (a handful don't): fall back to the
// top-level folder they're kept in. These are this install's own folder
// names under ComfyUI/models/loras — checked against the headers of the
// files that *do* carry metadata, which agree with them.
const FOLDER_FAMILY: Record<string, LoraFamily> = {
  MinimaxH3: 'video',
  Krea: 'krea2',
  Krea2: 'krea2',
  Characters: 'sdxl',
  Style: 'sdxl',
  Utility: 'sdxl',
  poses: 'sdxl',
}

export function loraFolder(name: string): string {
  const slash = name.indexOf('/')
  return slash === -1 ? '' : name.slice(0, slash)
}

// "Krea/RawGirlV3.safetensors" → "RawGirlV3" — the folder and extension eat
// most of a phone-width row otherwise.
export function loraDisplayName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1).replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '')
}

export function loraFamilyOf(name: string, families: Record<string, LoraFamily | null>): LoraFamily | null {
  return families[name] ?? FOLDER_FAMILY[loraFolder(name)] ?? null
}

// Unknown family (no header info, unrecognized folder) counts as compatible
// — hiding a LoRA we simply can't classify would be worse than showing it.
export function isLoraCompatible(name: string, tab: LoraTab, families: Record<string, LoraFamily | null>): boolean {
  const family = loraFamilyOf(name, families)
  return family === null || family === tab
}

let request: Promise<Record<string, LoraFamily | null>> | null = null

function fetchLoraFamilies(): Promise<Record<string, LoraFamily | null>> {
  if (!request) {
    request = fetch('/api/loras/meta')
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => {
        request = null // let the next picker opening retry
        return {}
      })
  }
  return request
}

// Fetched once per app load and shared by every tab's LoRA list — an empty
// map until it arrives (every LoRA then falls back to its folder).
export function useLoraFamilies(): Record<string, LoraFamily | null> {
  const [families, setFamilies] = useState<Record<string, LoraFamily | null>>({})
  useEffect(() => {
    let cancelled = false
    fetchLoraFamilies().then((f) => {
      if (!cancelled) setFamilies(f)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return families
}
