// Which ComfyUI prompt a generation kind ('video' | 'sdxl' | 'krea2') is
// currently on, as tracked by the PC's output-server
// (server/index.js, /api/state/:kind/job). The server sets it when its
// queue dispatcher submits a job and marks it done once ComfyUI is finished
// with it; the app only reads it — to follow whatever the server started,
// including after a reload or from a different device — and clears it once
// it has shown that job's result. This module never talks to ComfyUI
// itself; see useComfyGeneration.ts/useImageGeneration.ts for that.
export interface RemoteJob {
  promptId: string
  startedAt: number
  // Node id → title and node count of the submitted workflow, for the
  // progress display (absent on jobs from an older server).
  titles: Record<string, string> | null
  nodeCount: number
}

export async function loadRemoteJob(kind: string): Promise<RemoteJob | null> {
  try {
    const res = await fetch(`/api/state/${kind}/job`)
    if (!res.ok) return null
    const data = (await res.json()) as Partial<RemoteJob> | null
    if (!data || typeof data.promptId !== 'string' || !data.promptId) return null
    return {
      promptId: data.promptId,
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : Date.now(),
      titles: data.titles && typeof data.titles === 'object' ? data.titles : null,
      nodeCount: typeof data.nodeCount === 'number' ? data.nodeCount : 0,
    }
  } catch {
    return null
  }
}

// Only clears if the server is still on this exact job — by the time the
// app gets here, the dispatcher may already have moved on to the next one.
// Fire-and-forget: if it fails, the app just shows this result again on its
// next load.
export function clearRemoteJob(kind: string, promptId: string): void {
  fetch(`/api/state/${kind}/job?promptId=${encodeURIComponent(promptId)}`, { method: 'DELETE' }).catch(() => {})
}
