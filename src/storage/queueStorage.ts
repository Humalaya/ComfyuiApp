// Persists the "Kuyruğa Ekle" pending-jobs list — before this existed, an
// overnight batch of many queued generations lived only in React state
// (App.tsx), so a single page reload (screen lock, OEM background kill,
// manual refresh) at any point during the batch silently wiped every
// not-yet-started item with no way to recover them: the active job could
// resume via jobStorage.ts, but everything still waiting in line was just
// gone, which is exactly what happened overnight — the queue "disappeared"
// and nothing after the first item or two ever actually ran.
import type { GenerationSettings } from '../workflow/fieldMap'
import { normalizeSettings } from './settingsStorage'

const STORAGE_KEY = 'mobile-control:queue'
const STORAGE_VERSION = 1

export function saveQueue(queue: GenerationSettings[]): void {
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

export function loadQueue(): GenerationSettings[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: number; queue?: unknown }
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.queue)) return []
    // Each entry goes through the same field-by-field validation as the main
    // settings — a corrupt/outdated single queued item shouldn't take the
    // rest of a batch down with it.
    return parsed.queue.map((item) => normalizeSettings(item))
  } catch {
    return []
  }
}
