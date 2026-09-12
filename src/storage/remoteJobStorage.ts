// Persists which ComfyUI prompt_id (if any) is currently being tracked, for
// a given generation kind ('video' | 'sdxl' | 'krea2') — same purpose as the
// old jobStorage.ts, but backed by the small output-server's in-memory store
// (see server/index.js's /api/state/:kind/job) instead of the phone's own
// localStorage. That's the whole point: a job tracked only in the phone's
// storage was lost the moment the phone's browser data was gone for any
// reason, even though the actual generation was running on this same PC the
// whole time. This module never talks to ComfyUI itself — it only remembers
// *which* prompt_id to go ask ComfyUI's /history about; see
// useComfyGeneration.ts/useImageGeneration.ts's own recovery effects for that.
export interface RemoteJob {
  promptId: string
  startedAt: number
}

export async function loadRemoteJob(kind: string): Promise<RemoteJob | null> {
  try {
    const res = await fetch(`/api/state/${kind}/job`)
    if (!res.ok) return null
    const data = (await res.json()) as Partial<RemoteJob> | null
    if (!data || typeof data.promptId !== 'string' || !data.promptId) return null
    return { promptId: data.promptId, startedAt: typeof data.startedAt === 'number' ? data.startedAt : Date.now() }
  } catch {
    return null
  }
}

// Fire-and-forget, same "best effort" philosophy as the old localStorage
// helpers (a failed save here just means recovery won't work for *this* one
// job if something goes wrong before the next successful save — it doesn't
// block or fail the generation itself).
export function saveRemoteJob(kind: string, promptId: string, startedAt: number): void {
  fetch(`/api/state/${kind}/job`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptId, startedAt }),
  }).catch(() => {})
}

export function clearRemoteJob(kind: string): void {
  // `{}` rather than `null` — Express's JSON body parser runs in "strict"
  // mode by default, which rejects a bare top-level primitive like the
  // literal 4 bytes `null` as invalid JSON (only objects/arrays are accepted
  // at the top level), even though `null` is technically valid JSON on its
  // own. An empty object has no `promptId`, which the server already treats
  // exactly like an explicit null does.
  fetch(`/api/state/${kind}/job`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => {})
}
