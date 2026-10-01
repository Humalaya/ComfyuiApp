import { useEffect, useRef, useState } from 'react'
import {
  civitaiFullUrl,
  civitaiPageUrl,
  civitaiThumbUrl,
  fetchCivitaiGeneration,
  fetchCivitaiPage,
  type CivitaiGeneration,
  type CivitaiItem,
  type CivitaiPeriod,
  type CivitaiQuery,
  type CivitaiSort,
} from '../api/civitaiBrowser'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useSwipe } from '../hooks/useSwipe'
import { civitaiToImport, type ImportKind } from '../workflow/civitaiImport'
import type { ImportPayload } from './Gallery'
import { useBackHandler } from '../native/backButton'

interface Props {
  onSendToCreate: (payload: ImportPayload) => void
}

// Civitai "baseModel" names, as the API spells them.
const BASE_MODELS: Record<'image' | 'video', { label: string; value: string }[]> = {
  image: [
    { label: 'Tümü', value: '' },
    { label: 'Illustrious', value: 'Illustrious' },
    { label: 'Pony', value: 'Pony' },
    { label: 'NoobAI', value: 'NoobAI' },
    { label: 'SDXL', value: 'SDXL 1.0' },
    { label: 'Krea 2', value: 'Krea 2' },
  ],
  video: [
    { label: 'Tümü', value: '' },
    { label: 'MiniMax H3', value: 'MiniMax H3' },
  ],
}

const PERIODS: { label: string; value: CivitaiPeriod }[] = [
  { label: 'Gün', value: 'Day' },
  { label: 'Hafta', value: 'Week' },
  { label: 'Ay', value: 'Month' },
  { label: 'Yıl', value: 'Year' },
  { label: 'Tüm zamanlar', value: 'AllTime' },
]

const SEND_TARGETS: { kind: ImportKind; label: string }[] = [
  { kind: 'sdxl', label: 'SDXL' },
  { kind: 'krea2', label: 'Krea2' },
  { kind: 'video', label: 'Video' },
]

const QUERY_KEY = 'civitai-query'
const DEFAULT_QUERY: CivitaiQuery = { type: 'image', sort: 'Most Reactions', period: 'Week', baseModels: '', withMeta: true, nsfwOnly: false }

// The filters are remembered per device — reopening the view shouldn't reset
// NSFW / model choices every time.
function loadQuery(): CivitaiQuery {
  try {
    const saved = JSON.parse(localStorage.getItem(QUERY_KEY) ?? 'null') as Partial<CivitaiQuery> | null
    return { ...DEFAULT_QUERY, ...saved }
  } catch {
    return DEFAULT_QUERY
  }
}

function formatCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function chip(active: boolean) {
  return active ? 'chip chip-active' : 'chip'
}

function seg(active: boolean) {
  return active ? 'seg-btn seg-btn-active' : 'seg-btn'
}

// Browse Civitai's public image/video feed (sorted by newest or most
// reactions) and send a post's generation metadata to one of the Create
// tabs. Everything goes through the PC's output-server (see
// server/index.js's /api/civitai/*) so the API key stays on the PC.
export function CivitaiBrowser({ onSendToCreate }: Props) {
  const [query, setQuery] = useState<CivitaiQuery>(loadQuery)
  const [items, setItems] = useState<CivitaiItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  // Guards against an older, slower page landing on top of a newer query.
  const requestId = useRef(0)

  async function load(q: CivitaiQuery, from: string | null) {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const page = await fetchCivitaiPage(q, from)
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
    try {
      localStorage.setItem(QUERY_KEY, JSON.stringify(query))
    } catch {
      // private mode / storage full — filters just won't be remembered
    }
    setItems([])
    setCursor(null)
    load(query, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function update(patch: Partial<CivitaiQuery>) {
    setQuery((q) => {
      const next = { ...q, ...patch }
      // Each media type has its own base-model list.
      if (patch.type && patch.type !== q.type) next.baseModels = ''
      return next
    })
  }

  return (
    <div className="civitai-browser">
      <div className="seg seg-accent">
        <button type="button" className={seg(query.type === 'image')} onClick={() => update({ type: 'image' })}>
          Görseller
        </button>
        <button type="button" className={seg(query.type === 'video')} onClick={() => update({ type: 'video' })}>
          Videolar
        </button>
      </div>

      <div className="civitai-toolbar">
        <div className="seg">
          <button type="button" className={seg(query.sort === 'Most Reactions')} onClick={() => update({ sort: 'Most Reactions' as CivitaiSort })}>
            Popüler
          </button>
          <button type="button" className={seg(query.sort === 'Newest')} onClick={() => update({ sort: 'Newest' as CivitaiSort })}>
            Yeni
          </button>
        </div>
        <button
          type="button"
          className={query.withMeta ? 'toggle-pill toggle-pill-on' : 'toggle-pill'}
          aria-pressed={query.withMeta}
          onClick={() => update({ withMeta: !query.withMeta })}
        >
          Prompt'lu
        </button>
        <button
          type="button"
          className={query.nsfwOnly ? 'toggle-pill toggle-pill-danger toggle-pill-on' : 'toggle-pill toggle-pill-danger'}
          aria-pressed={query.nsfwOnly}
          onClick={() => update({ nsfwOnly: !query.nsfwOnly })}
        >
          NSFW
        </button>
      </div>

      {query.sort === 'Most Reactions' && (
        <div className="chip-row">
          {PERIODS.map((p) => (
            <button key={p.value} type="button" className={chip(query.period === p.value)} onClick={() => update({ period: p.value })}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="chip-row">
        {BASE_MODELS[query.type].map((b) => (
          <button key={b.label} type="button" className={chip(query.baseModels === b.value)} onClick={() => update({ baseModels: b.value })}>
            {b.label}
          </button>
        ))}
      </div>

      {error && (
        // Civitai's API throws the odd transient 503 — retry the same page.
        <div className="status-warning">
          {error}
          <button type="button" className="secondary-button" onClick={() => load(query, items.length > 0 ? cursor : null)}>
            Tekrar dene
          </button>
        </div>
      )}

      <div className="civitai-grid">
        {items.map((item, i) => (
          <button key={item.id} type="button" className="civitai-tile" onClick={() => setViewerIndex(i)}>
            <img src={civitaiThumbUrl(item)} alt="" loading="lazy" />
            {item.type === 'video' && <span className="civitai-tile-play">▶</span>}
            <span className="civitai-tile-stats">♥ {formatCount(item.reactions)}</span>
          </button>
        ))}
      </div>

      {!loading && !error && items.length === 0 && <div className="empty-state">Sonuç yok.</div>}
      {loading && <div className="spinner" aria-label="Yükleniyor" />}
      {!loading && cursor && (
        <button type="button" className="secondary-button more-button" onClick={() => load(query, cursor)}>
          Daha fazla
        </button>
      )}

      {viewerIndex !== null && items[viewerIndex] && (
        <CivitaiViewer
          items={items}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onSend={(payload) => {
            setViewerIndex(null)
            onSendToCreate(payload)
          }}
        />
      )}
    </div>
  )
}

interface ViewerProps {
  items: CivitaiItem[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
  onSend: (payload: ImportPayload) => void
}

function CivitaiViewer({ items, index, onIndexChange, onClose, onSend }: ViewerProps) {
  const item = items[index]
  const hasPrev = index > 0
  const hasNext = index < items.length - 1
  const swipe = useSwipe(
    () => hasNext && onIndexChange(index + 1),
    () => hasPrev && onIndexChange(index - 1),
  )
  const objectInfo = useObjectInfo()
  // Civitai's generator data, fetched per opened item — the feed carries no
  // metadata, so this is the prompt, settings and checkpoint/LoRAs shown.
  const [generation, setGeneration] = useState<Record<number, CivitaiGeneration | 'loading' | 'error'>>({})
  const [sendOpen, setSendOpen] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  useBackHandler(true, onClose)
  // After the viewer's own handler — back closes the send sheet first.
  useBackHandler(sendOpen, () => setSendOpen(false))

  useEffect(() => {
    setSendOpen(false)
    setPromptExpanded(false)
    if (generation[item.id]) return
    setGeneration((g) => ({ ...g, [item.id]: 'loading' }))
    fetchCivitaiGeneration(item.id)
      .then((gen) => setGeneration((g) => ({ ...g, [item.id]: gen })))
      .catch(() => setGeneration((g) => ({ ...g, [item.id]: 'error' })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1)
      else if (e.key === 'ArrowRight' && hasNext) onIndexChange(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, hasPrev, hasNext, onClose, onIndexChange])

  const genEntry = generation[item.id]
  const gen = genEntry && genEntry !== 'loading' && genEntry !== 'error' ? genEntry : null
  const prompt = gen?.prompt || ''
  const negative = gen?.negativePrompt || ''
  const details: [string, string | number][] = (
    [
      ['Seed', gen?.seed],
      ['Adım', gen?.steps],
      ['CFG', gen?.cfgScale],
      ['Sampler', gen?.sampler],
      ['Scheduler', gen?.scheduler],
      ['Boyut', `${item.width}×${item.height}`],
    ] as [string, string | number | null | undefined][]
  ).filter((d): d is [string, string | number] => d[1] != null && d[1] !== '')
  // Resources already name the checkpoint; the bare model name is only a fallback.
  const resources = gen?.resources.length ? gen.resources : gen?.model ? [{ name: gen.model, type: 'Checkpoint', baseModel: null, strength: null }] : []

  const comfyLists = { samplerNames: objectInfo.samplerNames, schedulerNames: objectInfo.schedulerNames }

  return (
    <div className="popup-overlay civitai-viewer-overlay" onClick={onClose}>
      <div className="civitai-viewer" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="popup-close" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
        <div className="civitai-viewer-media" {...swipe}>
          {item.type === 'video' ? (
            <video key={item.id} src={civitaiFullUrl(item)} poster={civitaiThumbUrl(item)} controls autoPlay loop playsInline />
          ) : (
            <img key={item.id} src={civitaiFullUrl(item)} alt="" />
          )}
          {hasPrev && (
            <button type="button" className="popup-nav popup-nav-prev" onClick={() => onIndexChange(index - 1)} aria-label="Önceki">
              ‹
            </button>
          )}
          {hasNext && (
            <button type="button" className="popup-nav popup-nav-next" onClick={() => onIndexChange(index + 1)} aria-label="Sonraki">
              ›
            </button>
          )}
        </div>

        <div className="civitai-viewer-info">
          <div className="civitai-viewer-byline">
            <span className="civitai-viewer-user">{item.username ?? 'anonim'}</span>
            <span>{new Date(item.createdAt).toLocaleDateString('tr-TR')}</span>
            <span>♥ {formatCount(item.reactions)}</span>
            {item.baseModel && <span className="civitai-viewer-base">{item.baseModel}</span>}
          </div>

          {prompt && (
            <button
              type="button"
              className={promptExpanded ? 'civitai-prompt civitai-prompt-open' : 'civitai-prompt'}
              onClick={() => setPromptExpanded((x) => !x)}
            >
              <span className="civitai-prompt-text">{prompt}</span>
            </button>
          )}
          {negative && (
            <div className="civitai-negative">
              <span className="civitai-section-label">Negatif</span>
              {negative}
            </div>
          )}
          {details.length > 0 && (
            <div className="civitai-details">
              {details.map(([k, v]) => (
                <span key={k} className="civitai-detail">
                  <span className="civitai-detail-key">{k}</span>
                  {v}
                </span>
              ))}
            </div>
          )}
          {resources.length > 0 && (
            <div className="civitai-resources">
              {resources.map((r, i) => {
                const isLora = r.type === 'LORA' || r.type === 'LoCon'
                return (
                  <span key={i} className={isLora ? 'civitai-resource civitai-resource-lora' : 'civitai-resource'}>
                    {r.name}
                    {isLora && r.strength != null && <span className="civitai-resource-strength">{r.strength}</span>}
                  </span>
                )
              })}
            </div>
          )}

          <div className="civitai-actions">
            <button type="button" className="generate-button" disabled={!prompt} onClick={() => setSendOpen(true)}>
              Metadata gönder
            </button>
            <a className="secondary-button civitai-open-link" href={civitaiPageUrl(item)} target="_blank" rel="noreferrer" aria-label="Civitai'de aç">
              ↗
            </a>
          </div>
        </div>

        {sendOpen && (
          <div className="popup-overlay media-action-overlay" onClick={() => setSendOpen(false)}>
            <div className="media-action-menu civitai-send-menu" onClick={(e) => e.stopPropagation()}>
              {SEND_TARGETS.map((t) => {
                const result = civitaiToImport(t.kind, gen, comfyLists)
                return (
                  <button key={t.kind} type="button" className="secondary-button" disabled={!result} onClick={() => result && onSend(result.payload)}>
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
