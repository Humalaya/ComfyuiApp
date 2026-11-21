import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchCivitaiTags, type CivitaiTag, type CivitaiTagItem } from '../api/civitaiBrowser'
import { useBackHandler } from '../native/backButton'
import { loadRecentCivitaiTags as loadRecent, rememberCivitaiTag, recentCivitaiTagsKey as recentKey } from './civitaiShared'

interface Props {
  // 'image' covers videos too — Civitai tags both with the same list.
  kind: 'image' | 'model'
  current: CivitaiTag | null
  onPick: (tag: CivitaiTag | null) => void
  onClose: () => void
}

type TagSort = 'civitai' | 'az'

const SORT_KEY = 'civitai-tag-sort'

function sortTags<T extends CivitaiTag>(tags: T[], sort: TagSort): T[] {
  return sort === 'az' ? [...tags].sort((a, b) => a.name.localeCompare(b.name, 'en')) : tags
}

// Pick a Civitai tag to filter the feed by: the site's categories, any tag
// by search, or one used before.
export function CivitaiTagPicker({ kind, current, onPick, onClose }: Props) {
  useBackHandler(true, onClose)
  const [categories, setCategories] = useState<CivitaiTagItem[] | null>(null)
  const [input, setInput] = useState('')
  const [results, setResults] = useState<CivitaiTagItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState(() => loadRecent(kind))
  const [sort, setSort] = useState<TagSort>(() => {
    try {
      return localStorage.getItem(SORT_KEY) === 'az' ? 'az' : 'civitai'
    } catch {
      return 'civitai'
    }
  })
  const searchId = useRef(0)

  useEffect(() => {
    fetchCivitaiTags(kind, '')
      .then(setCategories)
      .catch((e: Error) => setError(e.message))
  }, [kind])

  // Search as you type, a beat after the last key.
  useEffect(() => {
    const q = input.trim()
    const id = ++searchId.current
    if (q.length < 2) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = window.setTimeout(() => {
      fetchCivitaiTags(kind, q)
        .then((items) => id === searchId.current && setResults(items))
        .catch((e: Error) => id === searchId.current && setError(e.message))
        .finally(() => id === searchId.current && setSearching(false))
    }, 300)
    return () => window.clearTimeout(t)
  }, [input, kind])

  function changeSort(s: TagSort) {
    setSort(s)
    try {
      localStorage.setItem(SORT_KEY, s)
    } catch {
      // not remembered — fine
    }
  }

  function pick(tag: CivitaiTag) {
    rememberCivitaiTag(kind, { id: tag.id, name: tag.name })
    onPick({ id: tag.id, name: tag.name })
  }

  const sortedCategories = useMemo(() => (categories ? sortTags(categories, sort) : null), [categories, sort])
  const sortedResults = useMemo(() => (results ? sortTags(results, sort) : null), [results, sort])

  const tagButton = (t: CivitaiTag & { isCategory?: boolean }) => (
    <button
      key={t.name}
      type="button"
      className={current?.name === t.name ? 'chip chip-active' : t.isCategory && results ? 'chip civitai-tag-category' : 'chip'}
      aria-pressed={current?.name === t.name}
      onClick={() => pick(t)}
    >
      {t.name}
    </button>
  )

  return (
    <div className="popup-overlay prompt-gen-overlay" onClick={onClose}>
      <div className="prompt-gen civitai-tag-picker" role="dialog" aria-label="Etiket seç" onClick={(e) => e.stopPropagation()}>
        <div className="lora-picker-header">
          <span className="prompt-gen-title">🏷 Etiket</span>
          <span className="prompt-gen-target">{kind === 'model' ? 'Modeller' : 'Görseller ve videolar'}</span>
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>

        <div className="search-row">
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Etiket ara… (ör. cyberpunk, beach)"
            aria-label="Etiket ara"
            enterKeyHint="search"
          />
          {input && (
            <button type="button" className="icon-button" aria-label="Aramayı temizle" onClick={() => setInput('')}>
              ✕
            </button>
          )}
        </div>

        <div className="civitai-tag-toolbar">
          <span className="prompt-gen-label">Sırala</span>
          <div className="seg">
            <button
              type="button"
              className={sort === 'civitai' ? 'seg-btn seg-btn-active' : 'seg-btn'}
              onClick={() => changeSort('civitai')}
            >
              {results ? 'En yakın' : 'Civitai'}
            </button>
            <button type="button" className={sort === 'az' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => changeSort('az')}>
              A–Z
            </button>
          </div>
          {current && (
            <button type="button" className="prompt-gen-link civitai-tag-clear" onClick={() => onPick(null)}>
              Filtreyi kaldır
            </button>
          )}
        </div>

        {error && <div className="field-error">{error}</div>}

        {input.trim().length >= 2 ? (
          <section className="civitai-tag-section">
            <span className="prompt-gen-label">Arama sonuçları</span>
            {searching && !sortedResults ? (
              <div className="spinner" aria-label="Aranıyor" />
            ) : sortedResults && sortedResults.length > 0 ? (
              <div className="civitai-tag-cloud">{sortedResults.map(tagButton)}</div>
            ) : (
              <div className="empty-state civitai-tag-empty">"{input.trim()}" için etiket yok.</div>
            )}
          </section>
        ) : (
          <>
            {recent.length > 0 && (
              <section className="civitai-tag-section">
                <div className="civitai-tag-section-head">
                  <span className="prompt-gen-label">Son kullanılanlar</span>
                  <button
                    type="button"
                    className="prompt-gen-link"
                    onClick={() => {
                      try {
                        localStorage.removeItem(recentKey(kind))
                      } catch {
                        // nothing to clear
                      }
                      setRecent([])
                    }}
                  >
                    Temizle
                  </button>
                </div>
                <div className="civitai-tag-cloud">{sortTags(recent, sort).map(tagButton)}</div>
              </section>
            )}
            <section className="civitai-tag-section">
              <span className="prompt-gen-label">Kategoriler</span>
              {sortedCategories ? (
                <div className="civitai-tag-cloud">{sortedCategories.map(tagButton)}</div>
              ) : (
                !error && <div className="spinner" aria-label="Yükleniyor" />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

// The feed's tag row: with no tag, a "🏷 Etiket" chip (opens the picker)
// followed by recently used tags for one-tap reuse; with one, a filter bar
// showing it, tap to change, ✕ to drop.
export function CivitaiTagBar({
  kind,
  tag,
  onChange,
}: {
  kind: 'image' | 'model'
  tag: CivitaiTag | null
  onChange: (tag: CivitaiTag | null) => void
}) {
  const [open, setOpen] = useState(false)
  // Read each render (a tiny localStorage read): picks from the picker or a
  // post's tags add to it.
  const recent = open ? [] : loadRecent(kind)

  return (
    <>
      {tag ? (
        <div className="civitai-model-filter">
          <span className="civitai-model-filter-label">Etiket</span>
          <button
            type="button"
            className="civitai-model-filter-name civitai-tag-filter-name"
            onClick={() => setOpen(true)}
            aria-label={`Etiket: ${tag.name} — değiştir`}
          >
            {tag.name}
          </button>
          <button type="button" className="icon-button" onClick={() => onChange(null)} aria-label="Etiket filtresini kaldır">
            ✕
          </button>
        </div>
      ) : (
        <div className="chip-row">
          <button type="button" className="chip civitai-tag-open" onClick={() => setOpen(true)}>
            🏷 Etiket
          </button>
          {recent.map((t) => (
            <button
              key={t.name}
              type="button"
              className="chip"
              onClick={() => {
                rememberCivitaiTag(kind, t)
                onChange(t)
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      {open && (
        <CivitaiTagPicker
          kind={kind}
          current={tag}
          onClose={() => setOpen(false)}
          onPick={(t) => {
            setOpen(false)
            onChange(t)
          }}
        />
      )}
    </>
  )
}
