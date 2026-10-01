// Client for the output-server's Civitai image/video browser proxy
// (/api/civitai/images, /api/civitai/generation in server/index.js).

export interface CivitaiItem {
  id: number
  url: string
  type: 'image' | 'video'
  width: number
  height: number
  createdAt: string
  baseModel: string | null
  username: string | null
  reactions: number
  comments: number
}

export interface CivitaiPage {
  items: CivitaiItem[]
  nextCursor: string | null
}

// A post's generation metadata — the feed itself carries none, so this is
// fetched per opened post.
export interface CivitaiGeneration {
  prompt: string | null
  negativePrompt: string | null
  seed: number | string | null
  steps: number | string | null
  cfgScale: number | string | null
  sampler: string | null
  scheduler: string | null
  model: string | null
  width: number | null
  height: number | null
  resources: { name: string; type: string | null; baseModel: string | null; strength: number | null }[]
}

export type CivitaiSort = 'Newest' | 'Most Reactions'
export type CivitaiPeriod = 'Day' | 'Week' | 'Month' | 'Year' | 'AllTime'

export interface CivitaiQuery {
  type: 'image' | 'video'
  sort: CivitaiSort
  period: CivitaiPeriod
  baseModels: string // '' = all
  withMeta: boolean
  nsfwOnly: boolean // only R / X / XXX
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body as { error?: string } | null)?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

export function fetchCivitaiPage(q: CivitaiQuery, cursor: string | null): Promise<CivitaiPage> {
  const params = new URLSearchParams({ sort: q.sort, period: q.period, type: q.type, withMeta: String(q.withMeta), nsfwOnly: String(q.nsfwOnly) })
  if (q.baseModels) params.set('baseModels', q.baseModels)
  if (cursor) params.set('cursor', cursor)
  return fetch(`/api/civitai/images?${params}`).then((r) => asJson<CivitaiPage>(r))
}

export function fetchCivitaiGeneration(id: number): Promise<CivitaiGeneration> {
  return fetch(`/api/civitai/generation?id=${id}`).then((r) => asJson<CivitaiGeneration>(r))
}

// Civitai's image CDN resizes on the fly via a path segment. For a video,
// `anim=false` returns a still JPEG of the first frame — what the grid shows.
export function civitaiThumbUrl(item: CivitaiItem): string {
  return item.url.replace('/original=true/', item.type === 'video' ? '/anim=false,transcode=true,width=450/' : '/width=450/')
}

// Full-screen view: images capped at 1080px wide (the originals can be
// 4000px+ and several MB each over mobile data); videos stay original.
export function civitaiFullUrl(item: CivitaiItem): string {
  return item.type === 'video' ? item.url : item.url.replace('/original=true/', '/width=1080/')
}

export function civitaiPageUrl(item: CivitaiItem): string {
  return `https://civitai.com/images/${item.id}`
}
