// Prompt geçmişi / kayıtlı promptlar — server/promptLibrary.js.

export type PromptKind = 'video' | 'sdxl' | 'krea2' | 'qwenedit'

export interface PromptHistoryEntry {
  text: string
  negative?: string
  at: number
  count: number
}

export interface SavedPrompt {
  id: string
  kind: PromptKind
  text: string
  negative?: string
  name?: string
  at: number
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export async function getPromptLibrary(kind: PromptKind): Promise<{ history: PromptHistoryEntry[]; saved: SavedPrompt[] }> {
  return asJson(await fetch(`/api/prompts?kind=${kind}`, { cache: 'no-store' }))
}

export async function savePrompt(kind: PromptKind, text: string, negative?: string, name?: string): Promise<SavedPrompt> {
  return asJson(await post('/api/prompts/saved', { kind, text, negative, name }))
}

export async function deleteSavedPrompt(id: string): Promise<void> {
  await asJson(await fetch(`/api/prompts/saved/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function deleteHistoryEntry(kind: PromptKind, text: string, negative?: string): Promise<void> {
  await asJson(await post('/api/prompts/history/delete', { kind, text, negative }))
}

export async function clearPromptHistory(kind: PromptKind): Promise<void> {
  await asJson(await post('/api/prompts/history/delete', { kind, all: true }))
}
