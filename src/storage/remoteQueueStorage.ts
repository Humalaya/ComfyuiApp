// Persists the "Kuyruğa Ekle" pending-jobs list for a given generation kind
// ('video' | 'sdxl' | 'krea2') on the small output-server's in-memory store
// (see server/index.js's /api/state/:kind/queue) instead of the phone's own
// localStorage — see remoteJobStorage.ts for the full rationale (same one,
// applied to the queue instead of the single active job). This is exactly
// the same failure mode the original queueStorage.ts was built to fix
// (an overnight queue of ~15 videos silently disappearing on a reload), one
// level further: now it survives losing the *phone* entirely, not just a
// reload of it.

const RETRY_MS = 2000

// Never "succeeds" with a made-up empty list: every caller marks its queue
// as loaded once this resolves, and from then on saves its in-memory queue
// straight back over the server's copy — so resolving [] after a failed
// fetch would *erase* whatever was actually waiting on the PC. Instead this
// keeps retrying until it genuinely has the server's list, and resolves null
// only if the caller says to stop (e.g. unmounted) first.
export async function loadRemoteQueue<T>(
  kind: string,
  normalizeItem: (raw: unknown) => T,
  shouldStop: () => boolean = () => false,
): Promise<T[] | null> {
  while (!shouldStop()) {
    try {
      const res = await fetch(`/api/state/${kind}/queue`)
      if (res.ok) {
        const data: unknown = await res.json()
        if (!Array.isArray(data)) return []
        const items: T[] = []
        for (const raw of data) {
          // Called with exactly one argument on purpose — not
          // `data.map(normalizeItem)`. Array.map passes (item, index), and
          // every normalizer here takes an optional second `defaults`
          // parameter, so the index silently landed in `defaults` (0, 1, …)
          // and blew up on `defaults.loras`. That throw used to fall into a
          // blanket catch that returned [] for the *whole* queue, which the
          // caller then saved back over the server's copy — every pending
          // job wiped the moment the app was reopened after being killed in
          // the background.
          try {
            items.push(normalizeItem(raw))
          } catch {
            // One corrupt/outdated entry shouldn't take the rest of the
            // batch down with it — drop just this one.
          }
        }
        return items
      }
    } catch {
      // network hiccup / server restarting — retry below
    }
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
  return null
}

// Fire-and-forget — see remoteJobStorage.ts's identical note.
export function saveRemoteQueue<T>(kind: string, queue: T[]): void {
  fetch(`/api/state/${kind}/queue`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(queue),
  }).catch(() => {})
}
