// Base-model groups of SDXL checkpoints and LoRAs — the ✨ prompt
// generator writes rating / quality tags for the checkpoint's family
// (hooks/useCheckpointFamily.ts).

// Civitai's baseModel
// names ("Illustrious", "Pony", "SDXL 1.0", "Krea 2", "MiniMax H3"…) map
// onto these; anything else is its own group under its own name.
export type BaseGroup = 'illustrious' | 'pony' | 'sdxl' | 'sd1' | 'krea2' | 'video' | string

const GROUP_LABEL: Record<string, string> = {
  illustrious: 'Illustrious',
  pony: 'Pony',
  sdxl: 'SDXL',
  sd1: 'SD 1.5',
  krea2: 'Krea2',
  video: 'MiniMax H3',
}

export function groupLabel(g: BaseGroup): string {
  return GROUP_LABEL[g] ?? g
}

export function groupOfCivitaiBase(base: string | null | undefined): BaseGroup | null {
  if (!base) return null
  const b = base.toLowerCase()
  if (b.includes('illustrious') || b.includes('noobai')) return 'illustrious'
  if (b.includes('pony')) return 'pony'
  if (b.startsWith('sdxl')) return 'sdxl'
  if (b.startsWith('sd 1') || b.startsWith('sd 2')) return 'sd1'
  if (b.includes('krea')) return 'krea2'
  if (b.includes('minimax')) return 'video'
  if (b === 'other') return null
  return base
}

// A checkpoint name's group when Civitai doesn't know it (or hasn't
// answered yet): most SDXL checkpoints say which family they are.
export function groupOfCheckpointName(name: string): BaseGroup {
  const n = name.toLowerCase()
  if (n.includes('pony')) return 'pony'
  if (n.includes('illustrious') || n.includes('noob') || /(^|[/_-])wai/.test(n)) return 'illustrious'
  return 'sdxl'
}
