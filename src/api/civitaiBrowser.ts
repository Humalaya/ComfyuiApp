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
  postId: number | null
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
  // versionId: the Civitai model version — tapping a resource filters the
  // browser to posts made with it.
  resources: { versionId: number | null; name: string; type: string | null; baseModel: string | null; strength: number | null }[]
}

export type CivitaiSort = 'Newest' | 'Most Reactions'
export type CivitaiPeriod = 'Day' | 'Week' | 'Month' | 'Year' | 'AllTime'

export type CivitaiModelSort = 'Most Downloaded' | 'Highest Rated' | 'Newest'

export interface CivitaiQuery {
  // 'models': browse Civitai's models themselves (the "Modeller" tab)
  // instead of posts.
  type: 'image' | 'video' | 'models'
  modelSort: CivitaiModelSort
  modelTypes: string[] // [] = all; Civitai's names (Checkpoint, LORA…)
  sort: CivitaiSort
  period: CivitaiPeriod
  baseModels: string[] // [] = all
  withMeta: boolean
  // Only posts made with this model version (tapped in a post's resources);
  // overrides baseModels.
  modelVersion: { id: number; name: string } | null
  nsfwOnly: boolean // only R / X / XXX
  // Modeller: models with this tag name (Civitai's model search takes one).
  tag: CivitaiTag | null
  // Görseller / Videolar: posts carrying every one of `tags`, and none of
  // `excludedTags` (images and videos share one tag list).
  tags: CivitaiTag[]
  excludedTags: CivitaiTag[]
}

export interface CivitaiTag {
  id: number
  name: string
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body as { error?: string } | null)?.error || `İstek başarısız (${res.status})`)
  }
  return res.json() as Promise<T>
}

// The post feed's own fields (image / video tab, a model page's images).
export type CivitaiPostQuery = Pick<CivitaiQuery, 'sort' | 'period' | 'baseModels' | 'withMeta' | 'nsfwOnly' | 'modelVersion'> & {
  // 'all': images and videos together (a user's / a post's page).
  type: 'image' | 'video' | 'all'
  tags?: CivitaiTag[]
  excludedTags?: CivitaiTag[]
  // One user's posts, or one post's pictures.
  username?: string
  postId?: number
}

export function fetchCivitaiPage(q: CivitaiPostQuery, cursor: string | null): Promise<CivitaiPage> {
  const params = new URLSearchParams({
    sort: q.sort,
    period: q.period,
    type: q.type,
    withMeta: String(q.withMeta),
    nsfwOnly: String(q.nsfwOnly),
  })
  // Civitai's base model names never contain commas.
  if (q.modelVersion) params.set('modelVersionId', String(q.modelVersion.id))
  else if (q.baseModels.length > 0) params.set('baseModels', q.baseModels.join(','))
  if (q.tags?.length) params.set('tagIds', q.tags.map((t) => t.id).join(','))
  if (q.excludedTags?.length) params.set('excludedTagIds', q.excludedTags.map((t) => t.id).join(','))
  if (q.username) params.set('username', q.username)
  if (q.postId) params.set('postId', String(q.postId))
  if (cursor) params.set('cursor', cursor)
  return fetch(`/api/civitai/images?${params}`).then((r) => asJson<CivitaiPage>(r))
}

export interface CivitaiModelItem {
  id: number
  name: string
  type: string
  nsfw: boolean
  creator: string | null
  downloads: number
  likes: number
  baseModel: string | null
  versionId: number | null
  versions: number
  cover: string | null
}

export function fetchCivitaiModels(
  q: CivitaiQuery,
  search: string,
  cursor: string | null,
): Promise<{ items: CivitaiModelItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ sort: q.modelSort, period: q.period, nsfwOnly: String(q.nsfwOnly) })
  if (q.modelTypes.length) params.set('types', q.modelTypes.join(','))
  if (q.baseModels.length) params.set('baseModels', q.baseModels.join(','))
  if (search.trim()) params.set('query', search.trim())
  if (q.tag) params.set('tag', q.tag.name)
  if (cursor) params.set('cursor', cursor)
  return fetch(`/api/civitai/models?${params}`).then((r) => asJson<{ items: CivitaiModelItem[]; nextCursor: string | null }>(r))
}

export interface CivitaiTagItem extends CivitaiTag {
  isCategory: boolean
  // Place in Civitai's most-used tags (1 = most used); null = outside the
  // top 3000 or unknown. Drives the picker's "Popüler" sort.
  rank?: number | null
}

// No query: Civitai's category list ('image' covers videos too); with one:
// tag-name search.
export function fetchCivitaiTags(kind: 'image' | 'model', query: string): Promise<CivitaiTagItem[]> {
  const params = new URLSearchParams({ kind })
  if (query.trim()) params.set('query', query.trim())
  return fetch(`/api/civitai/tags?${params}`)
    .then((r) => asJson<{ items: CivitaiTagItem[] }>(r))
    .then((d) => d.items)
}

// One post's tags, most confident first.
export function fetchCivitaiImageTags(id: number): Promise<CivitaiTag[]> {
  return fetch(`/api/civitai/image-tags?id=${id}`)
    .then((r) => asJson<{ items: CivitaiTag[] }>(r))
    .then((d) => d.items)
}

// One post by id — an opened civitai.com/images/… link.
export function fetchCivitaiImage(id: number): Promise<CivitaiItem> {
  return fetch(`/api/civitai/image?id=${id}`).then((r) => asJson<CivitaiItem>(r))
}

// A pasted Civitai link → what to open in the app. Any Civitai domain
// (civitai.com / .red / .green); null if it isn't one this app can show.
export type CivitaiLink =
  | { kind: 'image'; id: number }
  | { kind: 'post'; id: number }
  | { kind: 'model'; modelId: number; versionId?: number }
  | { kind: 'user'; username: string }

export function parseCivitaiLink(text: string): CivitaiLink | null {
  const raw = text.trim().match(/\S*civitai\.[a-z]+\S*/i)?.[0]
  if (!raw) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/(^|\.)civitai\.[a-z]+$/i.test(url.hostname)) return null
  const parts = url.pathname.split('/').filter(Boolean)
  const num = (v: string | undefined | null) => (v && /^\d+$/.test(v) ? Number(v) : null)
  const [section, value] = parts
  if (section === 'images' && num(value)) return { kind: 'image', id: num(value)! }
  if (section === 'posts' && num(value)) return { kind: 'post', id: num(value)! }
  if (section === 'models' && num(value)) {
    const versionId = num(url.searchParams.get('modelVersionId'))
    return versionId ? { kind: 'model', modelId: num(value)!, versionId } : { kind: 'model', modelId: num(value)! }
  }
  if (section === 'user' && value && /^[\w.-]{1,64}$/.test(decodeURIComponent(value)))
    return { kind: 'user', username: decodeURIComponent(value) }
  return null
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

export interface InputImageRef {
  filename: string
  subfolder: string
  type: string
}

// Has the PC download this image from Civitai and put it into ComfyUI's
// input folder (server/index.js /api/civitai/to-input) — the result is
// usable as the video tab's first frame or Edit (Qwen)'s picture 1. Images only:
// Civitai's CDN won't hand out a still of a video, only the whole file.
export async function sendCivitaiImageToInput(item: CivitaiItem): Promise<InputImageRef> {
  const res = await fetch('/api/civitai/to-input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, url: item.url }),
  })
  return asJson<InputImageRef>(res)
}
