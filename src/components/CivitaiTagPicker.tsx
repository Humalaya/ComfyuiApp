import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchCivitaiTags, type CivitaiTag, type CivitaiTagItem } from '../api/civitaiBrowser'
import { useBackHandler } from '../native/backButton'
import { loadStarredCivitaiTags, toggleStarredCivitaiTag } from './civitaiShared'

interface Props {
  // 'image' covers videos too — Civitai tags both with the same list.
  kind: 'image' | 'model'
  // Posts take several tags (all must match) and excluded ones; Civitai's
  // model search takes a single tag — then a tap just picks it.
  multi: boolean
  included: CivitaiTag[]
  excluded: CivitaiTag[]
  onApply: (included: CivitaiTag[], excluded: CivitaiTag[]) => void
  onClose: () => void
}

type TagSort = 'civitai' | 'popular' | 'az'
// What tapping a tag does.
type TapMode = 'include' | 'exclude' | 'star'

const SORT_KEY = 'civitai-tag-sort'

function sortTags<T extends CivitaiTag & { rank?: number | null }>(tags: T[], sort: TagSort): T[] {
  if (sort === 'az') return [...tags].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  // Unranked (rare) tags keep Civitai's order, after the ranked ones.
  if (sort === 'popular') return [...tags].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
  return tags
}

const has = (list: CivitaiTag[], t: CivitaiTag) => list.some((x) => x.name === t.name)
const without = (list: CivitaiTag[], t: CivitaiTag) => list.filter((x) => x.name !== t.name)
const plain = (t: CivitaiTag): CivitaiTag => ({ id: t.id, name: t.name })

// Pick Civitai tags to filter the feed by: the site's categories, any tag by
// search, or a starred one. In multi mode tags are gathered (+ include,
// − exclude) and applied together; ★ mode stars / unstars instead.
export function CivitaiTagPicker({ kind, multi, included: initialIncluded, excluded: initialExcluded, onApply, onClose }: Props) {
  useBackHandler(true, onClose)
  const [categories, setCategories] = useState<CivitaiTagItem[] | null>(null)
  const [input, setInput] = useState('')
  const [results, setResults] = useState<CivitaiTagItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starred, setStarred] = useState(() => loadStarredCivitaiTags(kind))
  const [included, setIncluded] = useState(initialIncluded)
  const [excluded, setExcluded] = useState(initialExcluded)
  const [mode, setMode] = useState<TapMode>('include')
  const [sort, setSort] = useState<TagSort>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY)
      return v === 'az' || v === 'popular' ? v : 'civitai'
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

  function tap(t: CivitaiTag) {
    const tag = plain(t)
    if (mode === 'star') {
      setStarred(toggleStarredCivitaiTag(kind, tag))
      return
    }
    if (!multi) {
      onApply([tag], [])
      return
    }
    // Tapping a tag already in that list takes it out again; a tag is
    // never both included and excluded.
    if (mode === 'include') {
      setIncluded((l) => (has(l, tag) ? without(l, tag) : [...l, tag]))
      setExcluded((l) => without(l, tag))
    } else {
      setExcluded((l) => (has(l, tag) ? without(l, tag) : [...l, tag]))
      setIncluded((l) => without(l, tag))
    }
  }

  const sortedCategories = useMemo(() => (categories ? sortTags(categories, sort) : null), [categories, sort])
  const sortedResults = useMemo(() => (results ? sortTags(results, sort) : null), [results, sort])
  const changed =
    included.map((t) => t.name).join('|') !== initialIncluded.map((t) => t.name).join('|') ||
    excluded.map((t) => t.name).join('|') !== initialExcluded.map((t) => t.name).join('|')

  const tagButton = (t: CivitaiTag & { isCategory?: boolean }) => {
    const inc = has(included, t)
    const exc = has(excluded, t)
    const star = has(starred, t)
    const cls = inc ? 'chip chip-active' : exc ? 'chip chip-exclude' : t.isCategory && results ? 'chip civitai-tag-category' : 'chip'
    return (
      <button key={t.name} type="button" className={cls} aria-pressed={inc || exc} onClick={() => tap(t)}>
        {star && <span className="civitai-tag-star">★</span>}
        {exc ? `− ${t.name}` : t.name}
      </button>
    )
  }

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

        <div className="seg civitai-tag-mode" role="group" aria-label="Dokununca">
          <button type="button" className={mode === 'include' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => setMode('include')}>
            {multi ? '+ Ekle' : 'Seç'}
          </button>
          {multi && (
            <button type="button" className={mode === 'exclude' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => setMode('exclude')}>
              − Hariç tut
            </button>
          )}
          <button type="button" className={mode === 'star' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => setMode('star')}>
            ★ Yıldızla
          </button>
        </div>
        {mode === 'star' && (
          <span className="field-hint">Dokunduğun etiket yıldızlanır / yıldızı kalkar. Yıldızlılar akışın üstünde durur.</span>
        )}

        {multi && (included.length > 0 || excluded.length > 0) && (
          <section className="civitai-tag-section">
            <div className="civitai-tag-section-head">
              <span className="prompt-gen-label">Seçili — hepsi olan postlar, hariçler olmadan</span>
              <button
                type="button"
                className="prompt-gen-link"
                onClick={() => {
                  setIncluded([])
                  setExcluded([])
                }}
              >
                Temizle
              </button>
            </div>
            <div className="civitai-tag-cloud">
              {included.map((t) => (
                <button key={`+${t.name}`} type="button" className="chip chip-active" onClick={() => setIncluded((l) => without(l, t))}>
                  {t.name} ✕
                </button>
              ))}
              {excluded.map((t) => (
                <button key={`-${t.name}`} type="button" className="chip chip-exclude" onClick={() => setExcluded((l) => without(l, t))}>
                  − {t.name} ✕
                </button>
              ))}
            </div>
          </section>
        )}

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
            <button
              type="button"
              className={sort === 'popular' ? 'seg-btn seg-btn-active' : 'seg-btn'}
              onClick={() => changeSort('popular')}
            >
              Popüler
            </button>
            <button type="button" className={sort === 'az' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => changeSort('az')}>
              A–Z
            </button>
          </div>
          {!multi && initialIncluded.length > 0 && (
            <button type="button" className="prompt-gen-link civitai-tag-clear" onClick={() => onApply([], [])}>
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
            {starred.length > 0 && (
              <section className="civitai-tag-section">
                <span className="prompt-gen-label">★ Yıldızlı</span>
                <div className="civitai-tag-cloud">{sortTags(starred, sort).map(tagButton)}</div>
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

        {multi && (
          <button
            type="button"
            className="generate-button civitai-tag-apply"
            disabled={!changed}
            onClick={() => onApply(included, excluded)}
          >
            Uygula
            {included.length + excluded.length > 0
              ? ` · ${included.length} etiket${excluded.length ? `, ${excluded.length} hariç` : ''}`
              : ''}
          </button>
        )}
      </div>
    </div>
  )
}

// The feed's tag row: "🏷 Etiket" (opens the picker), the active filter
// (tap a chip to drop it), then starred tags not in use for one-tap adding.
// Recently used tags are no longer listed — only starred ones.
export function CivitaiTagBar({
  kind,
  multi,
  included,
  excluded,
  onChange,
}: {
  kind: 'image' | 'model'
  multi: boolean
  included: CivitaiTag[]
  excluded: CivitaiTag[]
  onChange: (included: CivitaiTag[], excluded: CivitaiTag[]) => void
}) {
  const [open, setOpen] = useState(false)
  // Read each render (a tiny localStorage read): starring in the picker
  // shows up here once it closes.
  const starred = open ? [] : loadStarredCivitaiTags(kind).filter((t) => !has(included, t) && !has(excluded, t))
  const active = included.length + excluded.length > 0

  return (
    <>
      <div className="chip-row">
        <button type="button" className="chip civitai-tag-open" onClick={() => setOpen(true)}>
          🏷 {active ? 'Düzenle' : 'Etiket'}
        </button>
        {included.map((t) => (
          <button
            key={`+${t.name}`}
            type="button"
            className="chip chip-active"
            aria-label={`${t.name} etiketini kaldır`}
            onClick={() => onChange(without(included, t), excluded)}
          >
            {t.name} ✕
          </button>
        ))}
        {excluded.map((t) => (
          <button
            key={`-${t.name}`}
            type="button"
            className="chip chip-exclude"
            aria-label={`${t.name} hariç tutmayı kaldır`}
            onClick={() => onChange(included, without(excluded, t))}
          >
            − {t.name} ✕
          </button>
        ))}
        {starred.map((t) => (
          <button
            key={t.name}
            type="button"
            className="chip"
            onClick={() => onChange(multi ? [...included, plain(t)] : [plain(t)], excluded)}
          >
            <span className="civitai-tag-star">★</span>
            {t.name}
          </button>
        ))}
      </div>
      {open && (
        <CivitaiTagPicker
          kind={kind}
          multi={multi}
          included={included}
          excluded={excluded}
          onClose={() => setOpen(false)}
          onApply={(inc, exc) => {
            setOpen(false)
            onChange(inc, exc)
          }}
        />
      )}
    </>
  )
}
