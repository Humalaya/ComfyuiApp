import { useMemo, useState } from 'react'
import { CollapsibleSection } from './CollapsibleSection'
import { HelpTip } from './HelpTip'
import { DANBOORU_TAG_CATEGORIES, DANBOORU_TAG_POST_COUNTS } from '../workflow/danbooruTags'
import { hasPromptTag, togglePromptTag } from '../utils/promptText'

interface Props {
  prompt: string
  negativePrompt: string
  onPromptChange: (prompt: string) => void
  onNegativePromptChange: (negativePrompt: string) => void
}

// Compact Danbooru post count — "6.3M", "434K", "9.6K". Only a rough sense
// of how common a tag is (≈ how strongly the model knows it), so no more
// precision than that.
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

// Tap-to-toggle Danbooru tag cheat sheet for the SDXL tab. Tapping a tag
// adds it to the Prompt box (or the Negatif Prompt box, for the "Negatif"
// category); tapping it again removes it. A tag already in the box — typed
// by hand, weighted like "(smile:1.2)", written with underscores — shows as
// active, so the sheet always reflects what's actually in the prompt rather
// than only what was tapped here.
export function TagCheatSheet({ prompt, negativePrompt, onPromptChange, onNegativePromptChange }: Props) {
  const [categoryId, setCategoryId] = useState(DANBOORU_TAG_CATEGORIES[0].id)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase().replace(/_/g, ' ')

  // With a search query, show matches from every category at once (a flat
  // list) — the point of searching is not having to guess which tab a tag
  // lives under.
  const visible = useMemo(() => {
    if (q) {
      // Most-used first, across all categories (model-convention tags like
      // "masterpiece" have no count and sort last).
      return DANBOORU_TAG_CATEGORIES.flatMap((c) =>
        c.tags.filter((t) => t.includes(q)).map((tag) => ({ tag, negative: c.target === 'negative' })),
      ).sort((a, b) => (DANBOORU_TAG_POST_COUNTS[b.tag] ?? -1) - (DANBOORU_TAG_POST_COUNTS[a.tag] ?? -1))
    }
    const category = DANBOORU_TAG_CATEGORIES.find((c) => c.id === categoryId) ?? DANBOORU_TAG_CATEGORIES[0]
    return category.tags.map((tag) => ({ tag, negative: category.target === 'negative' }))
  }, [q, categoryId])

  function toggle(tag: string, negative: boolean) {
    if (negative) onNegativePromptChange(togglePromptTag(negativePrompt, tag))
    else onPromptChange(togglePromptTag(prompt, tag))
  }

  return (
    <CollapsibleSection title="🏷️ Danbooru Tag Rehberi">
      <div className="search-row">
        <input
          type="search"
          className="tag-sheet-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tag ara… (ör. hair, smile)"
        />
        <HelpTip>
          Dokun → ekle, tekrar dokun → çıkar. "Negatif" kategorisi Negatif Prompt'a ekler. Yanındaki sayı Danbooru'daki post sayısı
          — ne kadar yaygınsa model o kadar iyi tanır. Bir tag'i güçlendirmek için prompt'ta (tag:1.2) şeklinde yazabilirsin.
        </HelpTip>
      </div>

      {!q && (
        <div className="chip-row">
          {DANBOORU_TAG_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.id === categoryId ? 'chip chip-active' : 'chip'}
              onClick={() => setCategoryId(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="tag-sheet-tags">
        {visible.length === 0 && <span className="field-hint">Eşleşen tag yok.</span>}
        {visible.map(({ tag, negative }) => {
          const active = hasPromptTag(negative ? negativePrompt : prompt, tag)
          return (
            <button
              key={`${negative ? 'n' : 'p'}:${tag}`}
              type="button"
              className={[
                'tag-chip',
                negative ? 'tag-chip-negative' : '',
                active ? (negative ? 'tag-chip-negative-active' : 'tag-chip-active') : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-pressed={active}
              onClick={() => toggle(tag, negative)}
            >
              {active ? '✓ ' : ''}
              {tag}
              {DANBOORU_TAG_POST_COUNTS[tag] !== undefined && (
                <span className="tag-chip-count">{formatCount(DANBOORU_TAG_POST_COUNTS[tag])}</span>
              )}
            </button>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}
