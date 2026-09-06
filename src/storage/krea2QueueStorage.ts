// Same rationale as imageQueueStorage.ts (SDXL tab) — persists the Krea2
// screen's "Kuyruğa Ekle" pending-jobs list so a page reload doesn't silently
// drop everything still waiting in line. Its own module (rather than reusing
// imageQueueStorage.ts) since the settings shape differs — see
// krea2SettingsStorage.ts for why.
import { normalizeKrea2Settings } from './krea2SettingsStorage'
import type { Krea2GenerationSettings } from '../workflow/krea2FieldMap'

const STORAGE_KEY = 'mobile-control:krea2-queue'
const STORAGE_VERSION = 1

export function saveKrea2Queue(queue: Krea2GenerationSettings[]): void {
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

export function loadKrea2Queue(): Krea2GenerationSettings[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: number; queue?: unknown }
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.queue)) return []
    return parsed.queue.map((item) => normalizeKrea2Settings(item))
  } catch {
    return []
  }
}
