// Constants and helpers shared by the Civitai views (CivitaiBrowser, its
// Modeller tab, the model page). Kept in their own module: those components
// import each other, and a constant read at module load through such a
// cycle isn't initialised yet.
import type { CivitaiPeriod, CivitaiTag } from '../api/civitaiBrowser'

// Civitai "baseModel" names, as the API spells them. Several can be picked
// at once; none picked means all. The video list is the five most posted
// video models (counted 2026-10, videos in one week: LTXV 2.3 and MiniMax H3
// 1000+, Wan 2.2 I2V-A14B ~530, Wan 3.0 ~290, Seedance ~245).
export const BASE_MODELS: Record<'image' | 'video', { label: string; value: string }[]> = {
  image: [
    { label: 'Illustrious', value: 'Illustrious' },
    { label: 'Pony', value: 'Pony' },
    { label: 'NoobAI', value: 'NoobAI' },
    { label: 'Anima', value: 'Anima' },
    { label: 'SDXL', value: 'SDXL 1.0' },
    { label: 'Krea 2', value: 'Krea 2' },
  ],
  video: [
    { label: 'MiniMax H3', value: 'MiniMax H3' },
    { label: 'LTXV 2.3', value: 'LTXV 2.3' },
    { label: 'Wan 2.2', value: 'Wan Video 2.2 I2V-A14B' },
    { label: 'Wan 3.0', value: 'Wan Video 3.0' },
    { label: 'Seedance', value: 'Seedance' },
  ],
}

export const PERIODS: { label: string; value: CivitaiPeriod }[] = [
  { label: 'Gün', value: 'Day' },
  { label: 'Hafta', value: 'Week' },
  { label: 'Ay', value: 'Month' },
  { label: 'Yıl', value: 'Year' },
  { label: 'Tüm zamanlar', value: 'AllTime' },
]

export function formatCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

// Starred Civitai tags, per list ('image' covers videos; 'model') — shown in
// the feed's tag row and at the top of the tag picker. (Replaced the old
// "recently used" list, which filled up with one-off picks.)
export const starredCivitaiTagsKey = (kind: string) => `civitai-starred-tags:${kind}`

export function loadStarredCivitaiTags(kind: string): CivitaiTag[] {
  try {
    const raw = JSON.parse(localStorage.getItem(starredCivitaiTagsKey(kind)) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((t): t is CivitaiTag => typeof t?.id === 'number' && typeof t?.name === 'string') : []
  } catch {
    return []
  }
}

// Stars the tag (at the end of the list) or unstars it; returns the new list.
export function toggleStarredCivitaiTag(kind: 'image' | 'model', tag: CivitaiTag): CivitaiTag[] {
  const list = loadStarredCivitaiTags(kind)
  // By name: a model's own tags (from its page) come without an id.
  const next = list.some((t) => t.name === tag.name) ? list.filter((t) => t.name !== tag.name) : [...list, tag]
  try {
    localStorage.setItem(starredCivitaiTagsKey(kind), JSON.stringify(next))
    localStorage.removeItem(`civitai-recent-tags:${kind}`)
  } catch {
    // not remembered — fine
  }
  return next
}
