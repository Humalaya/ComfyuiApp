import { useEffect, useState } from 'react'
import { fetchCheckpointBase } from '../api/civitaiClient'
import { groupOfCheckpointName, groupOfCivitaiBase, type BaseGroup } from '../utils/baseModel'

// The SDXL checkpoint's family (Illustrious / Pony / plain SDXL): Civitai's
// base model once the PC has looked it up (hashed once, then cached), its
// file name until then. The ✨ prompt generator writes rating / quality tags
// for this family.
export function useCheckpointFamily(checkpoint: string): BaseGroup | null {
  const [civitai, setCivitai] = useState<{ name: string; group: BaseGroup | null } | null>(null)
  useEffect(() => {
    if (!checkpoint) return
    let cancelled = false
    fetchCheckpointBase(checkpoint).then((base) => {
      if (!cancelled) setCivitai({ name: checkpoint, group: groupOfCivitaiBase(base) })
    })
    return () => {
      cancelled = true
    }
  }, [checkpoint])
  if (!checkpoint) return null
  return (civitai?.name === checkpoint && civitai.group) || groupOfCheckpointName(checkpoint)
}
