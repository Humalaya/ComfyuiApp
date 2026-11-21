// Client for server/promptgen.js — the ✨ prompt generator.
import type { PromptGenTarget } from '../workflow/promptGenPresets'

export interface PromptGenJob {
  id: string
  target: PromptGenTarget
  status: 'running' | 'done' | 'error'
  // While running: waiting (for ComfyUI's current job) → freeing (ComfyUI
  // unloads) → loading (LLM) → generating → unloading.
  stage: 'waiting' | 'freeing' | 'loading' | 'generating' | 'unloading' | null
  result: string | null
  error: string | null
  startedAt: number
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body as { error?: string } | null)?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

export function startPromptGen(body: {
  target: PromptGenTarget
  system: string
  request: string
  context?: string
  previous?: string
  feedback?: string
}): Promise<PromptGenJob> {
  return fetch('/api/promptgen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
    asJson<PromptGenJob>(r),
  )
}

export function getPromptGen(id: string): Promise<PromptGenJob> {
  return fetch(`/api/promptgen/${encodeURIComponent(id)}`).then((r) => asJson<PromptGenJob>(r))
}

export function cancelPromptGen(id: string): Promise<unknown> {
  return fetch(`/api/promptgen/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => asJson(r))
}
