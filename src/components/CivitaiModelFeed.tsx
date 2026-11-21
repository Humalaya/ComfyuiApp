import { useEffect, useRef, useState } from 'react'
import { fetchCivitaiModels, type CivitaiModelItem, type CivitaiModelSort, type CivitaiQuery } from '../api/civitaiBrowser'
import { BASE_MODELS, formatCount, PERIODS } from './civitaiShared'
import type { ModelRef } from './CivitaiModelPage'
import { CivitaiTagBar } from './CivitaiTagPicker'

interface Props {
  query: CivitaiQuery
  update: (patch: Partial<CivitaiQuery>) => void
  onOpen: (ref: ModelRef) => void
}

const SORTS: { label: string; value: CivitaiModelSort }[] = [
  { label: 'Popüler', value: 'Most Downloaded' },
  { label: 'Beğenilen', value: 'Highest Rated' },
  { label: 'Yeni', value: 'Newest' },
]

const TYPES: { label: string; value: string }[] = [
  { label: 'Checkpoint', value: 'Checkpoint' },
  { label: 'LoRA', value: 'LORA' },
  { label: 'LoCon', value: 'LoCon' },
  { label: 'DoRA', value: 'DoRA' },
  { label: 'Embedding', value: 'TextualInversion' },
  { label: 'VAE', value: 'VAE' },
  { label: 'Upscaler', value: 'Upscaler' },
  { label: 'ControlNet', value: 'Controlnet' },
]

const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.value, t.label]))

// Every base model the other two tabs offer — image and video — since a
// model list covers both.
const ALL_BASES = [...BASE_MODELS.image, ...BASE_MODELS.video]

function toggle(list: string[], v: string) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

// The Civitai view's "Modeller" tab: Civitai's models themselves (not
// posts), searchable and filtered like the feed; a tap opens the model's
// page (versions, files to download, images made with it).
export function CivitaiModelFeed({ query, update, onOpen }: Props) {
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('') // what's actually searched (on submit)
  const [items, setItems] = useState<CivitaiModelItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  async function load(from: string | null) {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const page = await fetchCivitaiModels(query, search, from)
      if (id !== requestId.current) return
      setItems((prev) => (from ? [...prev, ...page.items] : page.items))
      setCursor(page.nextCursor)
    } catch (e) {
      if (id === requestId.current) setError((e as Error).message)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  useEffect(() => {
    setItems([])
    setCursor(null)
    load(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.modelSort, query.period, query.nsfwOnly, query.modelTypes.join(','), query.baseModels.join(','), query.tag?.name, search])

  const seg = (a: boolean) => (a ? 'seg-btn seg-btn-active' : 'seg-btn')
  const chip = (a: boolean) => (a ? 'chip chip-active' : 'chip')

  return (
    <>
      <form
        className="search-row civitai-model-search"
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(input.trim())
          ;(document.activeElement as HTMLElement | null)?.blur()
        }}
      >
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Model ara… (ör. realism, pony)"
          aria-label="Civitai'de model ara"
          enterKeyHint="search"
        />
        {search && (
          <button
            type="button"
            className="icon-button"
            aria-label="Aramayı temizle"
            onClick={() => {
              setInput('')
              setSearch('')
            }}
          >
            ✕
          </button>
        )}
        <button type="submit" className="icon-button civitai-search-go" aria-label="Ara">
          🔍
        </button>
      </form>

      <div className="civitai-toolbar">
        <div className="seg">
          {SORTS.map((s) => (
            <button key={s.value} type="button" className={seg(query.modelSort === s.value)} onClick={() => update({ modelSort: s.value })}>
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={query.nsfwOnly ? 'toggle-pill toggle-pill-danger toggle-pill-on' : 'toggle-pill toggle-pill-danger'}
          aria-pressed={query.nsfwOnly}
          onClick={() => update({ nsfwOnly: !query.nsfwOnly })}
        >
          NSFW
        </button>
      </div>

      {/* A search always covers all time (see server/models.js). */}
      {query.modelSort !== 'Newest' && !search && (
        <div className="chip-row">
          {PERIODS.map((p) => (
            <button key={p.value} type="button" className={chip(query.period === p.value)} onClick={() => update({ period: p.value })}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="chip-row">
        <button type="button" className={chip(query.modelTypes.length === 0)} onClick={() => update({ modelTypes: [] })}>
          Tüm türler
        </button>
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            className={chip(query.modelTypes.includes(t.value))}
            onClick={() => update({ modelTypes: toggle(query.modelTypes, t.value) })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="chip-row">
        <button type="button" className={chip(query.baseModels.length === 0)} onClick={() => update({ baseModels: [] })}>
          Tümü
        </button>
        {ALL_BASES.map((b) => (
          <button
            key={b.value}
            type="button"
            className={chip(query.baseModels.includes(b.value))}
            onClick={() => update({ baseModels: toggle(query.baseModels, b.value) })}
          >
            {b.label}
          </button>
        ))}
      </div>

      <CivitaiTagBar kind="model" tag={query.tag} onChange={(tag) => update({ tag })} />

      {error && (
        <div className="status-warning">
          {error}
          <button type="button" className="secondary-button" onClick={() => load(items.length > 0 ? cursor : null)}>
            Tekrar dene
          </button>
        </div>
      )}

      <div className="civitai-grid">
        {items.map((m) => (
          <button
            key={m.id}
            type="button"
            className="civitai-tile civitai-model-tile"
            onClick={() => onOpen(m.versionId ? { versionId: m.versionId } : { modelId: m.id })}
          >
            {m.cover ? <img src={m.cover} alt="" loading="lazy" /> : <span className="civitai-model-tile-empty">📦</span>}
            <span className="civitai-model-tile-badges">
              <span className="civitai-model-tile-type">{TYPE_LABEL[m.type] ?? m.type}</span>
              {m.baseModel && <span className="civitai-model-tile-base">{m.baseModel}</span>}
            </span>
            <span className="civitai-model-tile-info">
              <span className="civitai-model-tile-name">{m.name}</span>
              <span className="civitai-model-tile-stats">
                ⬇ {formatCount(m.downloads)} · 👍 {formatCount(m.likes)}
                {m.versions > 1 && ` · ${m.versions} sürüm`}
              </span>
            </span>
          </button>
        ))}
      </div>

      {!loading && !error && items.length === 0 && (
        <div className="empty-state">{search ? `"${search}" için model yok.` : 'Sonuç yok.'}</div>
      )}
      {loading && <div className="spinner" aria-label="Yükleniyor" />}
      {!loading && cursor && (
        <button type="button" className="secondary-button more-button" onClick={() => load(cursor)}>
          Daha fazla
        </button>
      )}
    </>
  )
}
