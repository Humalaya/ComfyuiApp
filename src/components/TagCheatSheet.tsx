import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { HelpTip } from './HelpTip'
import { useBackHandler } from '../native/backButton'
import { hasPromptTag, insertPromptTag, normalizeTag, togglePromptTag } from '../utils/promptText'
import type { TagCategory } from '../workflow/danbooruTags'

interface Props {
  prompt: string
  negativePrompt: string
  onPromptChange: (prompt: string) => void
  onNegativePromptChange: (negativePrompt: string) => void
  // Where the cursor last was in each box (null → never touched: append at
  // the end). A tapped tag goes there and the ref moves past it.
  promptCursor?: MutableRefObject<number | null>
  negativeCursor?: MutableRefObject<number | null>
}

type TagData = { categories: TagCategory[]; counts: Record<string, number> }

// Compact Danbooru post count — "6.3M", "434K", "9.6K". Only a rough sense
// of how common a tag is (≈ how strongly the model knows it).
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

const MAX_SEARCH_RESULTS = 120

// How tags are ordered inside each section (and in search results):
// Danbooru's own wiki order (related tags sit together), most used first,
// or alphabetical. Remembered per device.
type SortMode = 'danbooru' | 'popular' | 'az'
const SORT_KEY = 'tagSheetSort'
const SORT_LABELS: [SortMode, string][] = [
  ['danbooru', 'Danbooru'],
  ['popular', 'Popüler'],
  ['az', 'A–Z'],
]

function loadSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY)
    if (v === 'danbooru' || v === 'popular' || v === 'az') return v
  } catch {
    // storage unavailable — default below
  }
  return 'danbooru'
}

function saveSort(mode: SortMode) {
  try {
    localStorage.setItem(SORT_KEY, mode)
  } catch {
    // not remembered — fine
  }
}

// Kalite / Negatif have no post counts: under Popüler they keep their
// hand-picked order (the sort is stable and they all tie).
function sortTags(tags: string[], mode: SortMode, counts: Record<string, number>): string[] {
  if (mode === 'popular') return [...tags].sort((a, b) => (counts[b] ?? -1) - (counts[a] ?? -1))
  if (mode === 'az') return [...tags].sort((a, b) => a.localeCompare(b, 'en'))
  return tags
}

// Danbooru tag cheat sheet for the SDXL tab, laid out the way Danbooru's own
// "tag group" wiki pages are (see danbooruTags.ts): category → Danbooru page
// → that page's headings, each a collapsible section of tags. Tapping a tag
// adds it to the Prompt box (Negatif → the Negatif Prompt box), tapping
// again removes it; a tag already in the box — typed by hand, weighted,
// underscored — shows as active too.
//
// Opens as a pop-up page over the form rather than unfolding inline, so the
// long tag lists don't push the rest of the tab around. It stays mounted
// once opened (just hidden), so category / page / open sections / scroll
// are where you left them next time.
export function TagCheatSheet(props: Props) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  useBackHandler(open, () => setOpen(false))

  return (
    <div className="field">
      <button
        type="button"
        className="collapsible-toggle"
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        <span className="collapsible-toggle-label">🏷️ Danbooru Tag Rehberi</span>
        <span className="collapsible-toggle-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {mounted && (
        <div role="dialog" aria-modal="true" className="popup-overlay tag-sheet-overlay" hidden={!open} onClick={() => setOpen(false)}>
          <div className="tag-sheet-modal" role="dialog" aria-label="Danbooru Tag Rehberi" onClick={(e) => e.stopPropagation()}>
            <TagSheetBody {...props} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

// The prompt is hidden behind the pop-up, so its top shows the box the
// current category writes to, with a caret where the next tag will land.
function PromptPreview({ label, text, cursor }: { label: string; text: string; cursor: number | null }) {
  const caretRef = useRef<HTMLSpanElement>(null)
  const at = cursor === null ? text.length : Math.min(cursor, text.length)
  useLayoutEffect(() => {
    caretRef.current?.scrollIntoView({ block: 'nearest' })
  }, [text, at])
  return (
    <div className="tag-sheet-preview">
      <span className="tag-sheet-preview-label">{label}</span>
      <div className="tag-sheet-preview-text">
        {text.slice(0, at)}
        <span ref={caretRef} className="tag-sheet-preview-caret" />
        {text.slice(at)}
        {!text && <span className="tag-sheet-preview-empty">boş</span>}
      </div>
    </div>
  )
}

// Only mounted once the pop-up has been opened — and the ~4,000-tag data
// file is only loaded then too, not with the rest of the app.
function TagSheetBody({
  prompt,
  negativePrompt,
  onPromptChange,
  onNegativePromptChange,
  promptCursor,
  negativeCursor,
  onClose,
}: Props & { onClose: () => void }) {
  const [data, setData] = useState<TagData | null>(null)
  const [categoryId, setCategoryId] = useState('quality')
  const [pageId, setPageId] = useState<string | null>(null)
  const [openSections, setOpenSections] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>(loadSort)

  useEffect(() => {
    let cancelled = false
    import('../workflow/danbooruTags').then((m) => {
      if (!cancelled) setData({ categories: m.DANBOORU_TAG_CATEGORIES, counts: m.DANBOORU_TAG_POST_COUNTS })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const q = query.trim().toLowerCase().replace(/_/g, ' ')

  // Search: every match, grouped under "Category › Page › Section", most
  // used first within each group.
  const results = useMemo(() => {
    if (!data || !q) return []
    const groups: { key: string; label: string; negative: boolean; tags: string[] }[] = []
    let n = 0
    for (const c of data.categories) {
      for (const p of c.pages) {
        for (const s of p.sections) {
          const tags = sortTags(
            s.tags.filter((t) => t.includes(q)),
            sortMode,
            data.counts,
          )
          if (tags.length === 0) continue
          const path = c.pages.length > 1 || p.title !== c.label ? [c.label, p.title, s.title] : [c.label]
          groups.push({ key: `${c.id}/${p.id}/${s.title}`, label: [...new Set(path)].join(' › '), negative: c.target === 'negative', tags })
          n += tags.length
          if (n >= MAX_SEARCH_RESULTS) return groups
        }
      }
    }
    return groups
  }, [data, q, sortMode])

  // The content tags already in the prompt (hair, clothes, pose…), shown on
  // top so the current picks are visible and removable without hunting. The
  // standing quality/negative boilerplate isn't listed — it's in nearly
  // every prompt and would bury the actual picks.
  const selected = useMemo(() => {
    if (!data) return []
    const known = new Set<string>()
    for (const c of data.categories) {
      if (c.id === 'quality' || c.target === 'negative') continue
      for (const p of c.pages) for (const s of p.sections) for (const t of s.tags) known.add(normalizeTag(t))
    }
    return prompt
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t && known.has(normalizeTag(t)))
      .map((tag) => ({ tag, negative: false }))
  }, [data, prompt])

  if (!data)
    return (
      <>
        <div className="tag-sheet-modal-header">
          <span className="tag-sheet-modal-title">🏷️ Danbooru Tag Rehberi</span>
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>
        <div className="spinner" aria-label="Yükleniyor" />
      </>
    )

  const category = data.categories.find((c) => c.id === categoryId) ?? data.categories[0]
  const page = category.pages.find((p) => p.id === pageId) ?? category.pages[0]
  const negative = category.target === 'negative'

  function toggle(tag: string, neg: boolean) {
    const text = neg ? negativePrompt : prompt
    const set = neg ? onNegativePromptChange : onPromptChange
    if (hasPromptTag(text, tag)) {
      set(togglePromptTag(text, tag))
      return
    }
    const ref = neg ? negativeCursor : promptCursor
    const result = insertPromptTag(text, tag, ref?.current ?? null)
    if (ref) ref.current = result.cursor
    set(result.text)
  }

  function toggleSection(key: string) {
    setOpenSections((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function chip(tag: string, neg: boolean) {
    const active = hasPromptTag(neg ? negativePrompt : prompt, tag)
    const count = data!.counts[tag]
    return (
      <button
        key={`${neg ? 'n' : 'p'}:${tag}`}
        type="button"
        className={['tag-chip', neg ? 'tag-chip-negative' : '', active ? (neg ? 'tag-chip-negative-active' : 'tag-chip-active') : '']
          .filter(Boolean)
          .join(' ')}
        aria-pressed={active}
        onClick={() => toggle(tag, neg)}
      >
        {tag}
        {count !== undefined && <span className="tag-chip-count">{formatCount(count)}</span>}
      </button>
    )
  }

  return (
    <div className="tag-sheet">
      <div className="tag-sheet-top">
        <div className="tag-sheet-modal-header">
          <input
            type="search"
            className="tag-sheet-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tag ara… (ör. braid, smile)"
            aria-label="Danbooru tag ara"
          />
          <HelpTip>
            Kategoriler ve alt başlıklar Danbooru'nun kendi "tag group" sayfalarından; sayılar Danbooru'daki post sayısı — ne kadar yaygınsa
            model o kadar iyi tanır. Dokun → ekle, tekrar dokun → çıkar; "Negatif" Negatif Prompt'a ekler. Prompt'taki tag'ler üstte
            "Seçili" satırında görünür, dokununca çıkar. Tag, prompt kutusunda en son dokunduğun yere eklenir (üstteki önizlemede imleç).
            Güçlendirmek için prompt'ta (tag:1.2) yazabilirsin.
          </HelpTip>
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>

        {negative ? (
          <PromptPreview label="Negatif" text={negativePrompt} cursor={negativeCursor?.current ?? null} />
        ) : (
          <PromptPreview label="Prompt" text={prompt} cursor={promptCursor?.current ?? null} />
        )}

        <div className="tag-sheet-sort">
          <span className="tag-sheet-sort-label">Sırala</span>
          <div className="seg">
            {SORT_LABELS.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={mode === sortMode ? 'seg-btn seg-btn-active' : 'seg-btn'}
                onClick={() => {
                  setSortMode(mode)
                  saveSort(mode)
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="tag-sheet-selected">
          <span className="tag-sheet-selected-label">Seçili</span>
          {selected.map(({ tag, negative: neg }) => (
            <button
              key={`${neg ? 'n' : 'p'}:${tag}`}
              type="button"
              className={neg ? 'tag-chip tag-chip-negative-active' : 'tag-chip tag-chip-active'}
              onClick={() => toggle(tag, neg)}
            >
              {tag} ✕
            </button>
          ))}
        </div>
      )}

      {q ? (
        <div className="tag-sheet-results">
          {results.length === 0 && <span className="field-hint">Eşleşen tag yok.</span>}
          {results.map((g) => (
            <div key={g.key} className="tag-sheet-group">
              <div className="tag-sheet-path">{g.label}</div>
              <div className="tag-sheet-tags">{g.tags.map((t) => chip(t, g.negative))}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="chip-row">
            {data.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={c.id === category.id ? 'chip chip-active' : 'chip'}
                onClick={() => {
                  setCategoryId(c.id)
                  setPageId(null)
                }}
              >
                {c.label}
              </button>
            ))}
          </div>

          {category.pages.length > 1 && (
            <div className="chip-row tag-sheet-pages">
              {category.pages.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === page.id ? 'tag-sheet-page tag-sheet-page-active' : 'tag-sheet-page'}
                  onClick={() => setPageId(p.id)}
                >
                  {p.title}
                </button>
              ))}
            </div>
          )}

          {page.sections.length === 1 ? (
            <div className="tag-sheet-tags">{sortTags(page.sections[0].tags, sortMode, data.counts).map((t) => chip(t, negative))}</div>
          ) : (
            <div className="tag-sheet-sections">
              {page.sections.map((s) => {
                const key = `${category.id}/${page.id}/${s.title}`
                const open = openSections.has(key)
                const picked = s.tags.filter((t) => hasPromptTag(negative ? negativePrompt : prompt, t)).length
                return (
                  <div key={key} className="tag-sheet-section">
                    <button type="button" className="tag-sheet-section-head" onClick={() => toggleSection(key)} aria-expanded={open}>
                      <span className="tag-sheet-section-title">{s.title}</span>
                      {picked > 0 && <span className="tag-sheet-section-picked">{picked}</span>}
                      <span className="tag-sheet-section-count">{s.tags.length}</span>
                      <span className={open ? 'collapsible-toggle-chevron collapsible-toggle-chevron-open' : 'collapsible-toggle-chevron'}>
                        ▾
                      </span>
                    </button>
                    {open && <div className="tag-sheet-tags">{sortTags(s.tags, sortMode, data.counts).map((t) => chip(t, negative))}</div>}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
