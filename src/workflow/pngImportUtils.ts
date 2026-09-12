import type { ComfyWorkflow } from '../api/comfyClient'

// Shared by pngImport.ts (video), imagePngImport.ts (SDXL) and
// krea2PngImport.ts (Krea2/FLUX) — each workflow family needs the exact same
// trick (a PNG's embedded node graph can have completely different node ids
// than this app's own template, e.g. after ComfyUI renumbers on export, so
// nodes are matched by class_type + title instead) just against a different
// template/NODE_IDS map, so the matching logic itself lives here once.
export function findNodeByIdentity(prompt: ComfyWorkflow, template: ComfyWorkflow, templateNodeId: string) {
  const templateNode = template[templateNodeId]
  const classType = templateNode.class_type
  const title = templateNode._meta?.title
  return Object.values(prompt).find((n) => n.class_type === classType && (!title || n._meta?.title === title))
}

export function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
