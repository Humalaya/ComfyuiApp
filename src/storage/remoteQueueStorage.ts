// Persists the "Kuyruğa Ekle" pending-jobs list for a given generation kind
// ('video' | 'sdxl' | 'krea2') on the small output-server's in-memory store
// (see server/index.js's /api/state/:kind/queue) instead of the phone's own
// localStorage — see remoteJobStorage.ts for the full rationale (same one,
// applied to the queue instead of the single active job). This is exactly
// the same failure mode the original queueStorage.ts was built to fix
// (an overnight queue of ~15 videos silently disappearing on a reload), one
// level further: now it survives losing the *phone* entirely, not just a
// reload of it.
export async function loadRemoteQueue<T>(kind: string, normalizeItem: (raw: unknown) => T): Promise<T[]> {
  try {
    const res = await fetch(`/api/state/${kind}/queue`)
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    // Each entry goes through the same field-by-field validation the caller
    // already uses for its settings shape — a corrupt/outdated single queued
    // item shouldn't take the rest of a batch down with it.
    return data.map(normalizeItem)
  } catch {
    return []
  }
}

// Fire-and-forget — see remoteJobStorage.ts's identical note.
export function saveRemoteQueue<T>(kind: string, queue: T[]): void {
  fetch(`/api/state/${kind}/queue`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(queue),
  }).catch(() => {})
}
