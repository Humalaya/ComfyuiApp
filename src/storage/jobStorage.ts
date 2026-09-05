// Persists which ComfyUI prompt_id (if any) is currently being tracked, so a
// generation in progress can be recovered after the page is fully reloaded
// (screen lock, OEM background kill, manual refresh) — not just after a
// WebSocket drop. See useComfyGeneration.ts's mount-time recovery effect.
const STORAGE_KEY = 'mobile-control:active-job'
const STORAGE_VERSION = 1

export interface ActiveJob {
  promptId: string
  startedAt: number
}

export function saveActiveJob(promptId: string, startedAt: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, promptId, startedAt }))
  } catch {
    // best effort — see settingsStorage.ts
  }
}

export function loadActiveJob(): ActiveJob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; promptId?: unknown; startedAt?: unknown }
    if (parsed.version !== STORAGE_VERSION || typeof parsed.promptId !== 'string' || !parsed.promptId) return null
    return { promptId: parsed.promptId, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now() }
  } catch {
    return null
  }
}

export function clearActiveJob(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
