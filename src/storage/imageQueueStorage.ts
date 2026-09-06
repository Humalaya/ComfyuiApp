// Same rationale as queueStorage.ts (video) — persists the Text2Img screen's
// "Kuyruğa Ekle" pending-jobs list so a page reload doesn't silently drop
// everything still waiting in line.
import { normalizeImageSettings } from './imageSettingsStorage'
import type { ImageGenerationSettings } from '../workflow/imageFieldMap'

const STORAGE_KEY = 'mobile-control:image-queue'
const STORAGE_VERSION = 1

export function saveImageQueue(queue: ImageGenerationSettings[]): void {
  try {
    if (queue.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, queue }))
  } catch {
    // best effort — see settingsStorage.ts
  }
}

export function loadImageQueue(): ImageGenerationSettings[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: number; queue?: unknown }
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.queue)) return []
    return parsed.queue.map((item) => normalizeImageSettings(item))
  } catch {
    return []
  }
}
