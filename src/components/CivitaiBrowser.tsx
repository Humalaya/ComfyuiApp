import { useEffect, useRef, useState } from 'react'
import {
  civitaiFullUrl,
  civitaiPageUrl,
  civitaiThumbUrl,
  fetchCivitaiGeneration,
  fetchCivitaiImageTags,
  fetchCivitaiPage,
  sendCivitaiImageToInput,
  type CivitaiGeneration,
  type CivitaiItem,
  type CivitaiQuery,
  type CivitaiSort,
  type CivitaiTag,
} from '../api/civitaiBrowser'
import { CivitaiTagBar } from './CivitaiTagPicker'
import { CivitaiModelFeed } from './CivitaiModelFeed'
import { BASE_MODELS, formatCount, PERIODS, rememberCivitaiTag } from './civitaiShared'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useSwipe } from '../hooks/useSwipe'
import { civitaiToImport, type ImportKind } from '../workflow/civitaiImport'
import type { ImportPayload } from './Gallery'
import { useBackHandler } from '../native/backButton'
import { CivitaiModelPage, type ModelRef } from './CivitaiModelPage'
import { CivitaiLoraSend, type PostLora } from './CivitaiLoraSend'

interface Props {
  onSendToCreate: (payload: ImportPayload) => void
  // Opens the Modeller view (from a model page's "PC'de" link).
  onOpenModels: () => void
  // A model page to open from elsewhere (Modeller's "Civitai sayfası");
  // a new object each time.
  modelRequest?: ModelRef | null
}

const SEND_TARGETS: { kind: ImportKind; label: string }[] = [
  { kind: 'sdxl', label: 'SDXL' },
  { kind: 'krea2', label: 'Krea2' },
  { kind: 'video', label: 'Video' },
]

const QUERY_KEY = 'civitai-query'
const DEFAULT_QUERY: CivitaiQuery = {
  type: 'image',
  sort: 'Most Reactions',
  period: 'Week',
  baseModels: [],
  withMeta: true,
  nsfwOnly: false,
  modelVersion: null,
  modelSort: 'Most Downloaded',
  modelTypes: [],
  tag: null,
}

// The filters are remembered per device — reopening the view shouldn't reset
// NSFW / model choices every time.
function loadQuery(): CivitaiQuery {
  try {
    const saved = JSON.parse(localStorage.getItem(QUERY_KEY) ?? 'null') as Partial<CivitaiQuery> | null
    const query = { ...DEFAULT_QUERY, ...saved }
    // Saved before multi-select, as a single string ('' = all).
    const raw: unknown = query.baseModels
    query.baseModels = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : typeof raw === 'string' && raw ? [raw] : []
    const mv = query.modelVersion as unknown as {
      id?: unknown
      name?: unknown
    } | null
    query.modelVersion = mv && typeof mv.id === 'number' && typeof mv.name === 'string' ? { id: mv.id, name: mv.name } : null
    if (!['image', 'video', 'models'].includes(query.type)) query.type = 'image'
    if (!['Most Downloaded', 'Highest Rated', 'Newest'].includes(query.modelSort)) query.modelSort = 'Most Downloaded'
    const tag = query.tag as unknown as { id?: unknown; name?: unknown } | null
    query.tag = tag && typeof tag.id === 'number' && typeof tag.name === 'string' ? { id: tag.id, name: tag.name } : null
    query.modelTypes = Array.isArray(query.modelTypes) ? query.modelTypes.filter((v) => typeof v === 'string') : []
    return query
  } catch {
    return DEFAULT_QUERY
  }
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
export function CivitaiBrowser({ onSendToCreate, onOpenModels, modelRequest }: Props) {
  const [query, setQuery] = useState<CivitaiQuery>(loadQuery)
  const [items, setItems] = useState<CivitaiItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  // A tapped model (resource chip) — its page covers the feed.
  const [modelPage, setModelPage] = useState<ModelRef | null>(null)
  useEffect(() => {
    if (modelRequest) setModelPage(modelRequest)
  }, [modelRequest])
  // Guards against an older, slower page landing on top of a newer query.
  const requestId = useRef(0)

  async function load(q: CivitaiQuery, from: string | null) {
    const id = ++requestId.current
    if (q.type === 'models') return // CivitaiModelFeed loads its own list
    setLoading(true)
    setError(null)
    try {
      const page = await fetchCivitaiPage({ ...q, type: q.type as 'image' | 'video' }, from)
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
      if (patch.type && patch.type !== q.type) {
        next.baseModels = []
        next.modelVersion = null
        // Posts and models have separate tag lists (videos share images').
        if (!('tag' in patch) && (patch.type === 'models' || q.type === 'models')) next.tag = null
      }
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
        <button type="button" className={seg(query.type === 'models')} onClick={() => update({ type: 'models' })}>
          Modeller
        </button>
      </div>

      {query.type === 'models' ? (
        <CivitaiModelFeed query={query} update={update} onOpen={(ref) => setModelPage(ref)} />
      ) : (
        <>
          <div className="civitai-toolbar">
            <div className="seg">
              <button
                type="button"
                className={seg(query.sort === 'Most Reactions')}
                onClick={() => update({ sort: 'Most Reactions' as CivitaiSort })}
              >
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
          {query.modelVersion ? (
            <div className="civitai-model-filter">
              <span className="civitai-model-filter-label">Model</span>
              <span className="civitai-model-filter-name">{query.modelVersion.name}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => update({ modelVersion: null })}
                aria-label="Model filtresini kaldır"
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="chip-row">
              <button type="button" className={chip(query.baseModels.length === 0)} onClick={() => update({ baseModels: [] })}>
                Tümü
              </button>
              {BASE_MODELS[query.type === 'video' ? 'video' : 'image'].map((b) => (
                <button
                  key={b.label}
                  type="button"
                  className={chip(query.baseModels.includes(b.value))}
                  onClick={() =>
                    update({
                      baseModels: query.baseModels.includes(b.value)
                        ? query.baseModels.filter((v) => v !== b.value)
                        : [...query.baseModels, b.value],
                    })
                  }
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}

          <CivitaiTagBar kind="image" tag={query.tag} onChange={(tag) => update({ tag })} />

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

          {!loading && !error && items.length === 0 && (
            <div className="empty-state">{query.tag ? `"${query.tag.name}" etiketiyle bu filtrelerde post yok.` : 'Sonuç yok.'}</div>
          )}
          {loading && <div className="spinner" aria-label="Yükleniyor" />}
          {!loading && cursor && (
            <button type="button" className="secondary-button more-button" onClick={() => load(query, cursor)}>
              Daha fazla
            </button>
          )}
        </>
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
          onPickModel={(modelVersion, type) => {
            setViewerIndex(null)
            setModelPage({ versionId: modelVersion.id, type })
          }}
          onPickTag={(tag) => {
            setViewerIndex(null)
            rememberCivitaiTag('image', tag)
            update({ tag })
          }}
        />
      )}

      {modelPage && (
        <CivitaiModelPage
          model={modelPage}
          onClose={() => setModelPage(null)}
          onOpenModel={setModelPage}
          onSendToCreate={(payload) => {
            setModelPage(null)
            onSendToCreate(payload)
          }}
          onOpenModels={onOpenModels}
          onPickTag={(tag, type) => {
            setModelPage(null)
            rememberCivitaiTag('image', tag)
            update({ type, tag })
          }}
          onPickModelTag={(name) => {
            setModelPage(null)
            const tag = { id: 0, name } // Modeller filters by name
            rememberCivitaiTag('model', tag)
            update({ type: 'models', tag })
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
  onPickModel: (modelVersion: { id: number; name: string }, type: 'image' | 'video') => void
  // A tapped tag of the post — shows that tag's posts.
  onPickTag?: (tag: CivitaiTag, type: 'image' | 'video') => void
}

const TAGS_SHOWN = 12

export function CivitaiViewer({ items, index, onIndexChange, onClose, onSend, onPickModel, onPickTag }: ViewerProps) {
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
  // "Resmi gönder": the picture itself as an input image, not its settings.
  const [imageSendOpen, setImageSendOpen] = useState(false)
  const [imageSending, setImageSending] = useState<'video' | 'anime2real' | null>(null)
  // "LoRA gönder": the post's LoRAs that are on this PC, into a Create tab.
  const [loraSendOpen, setLoraSendOpen] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  // The post's tags, fetched per opened item like the generation data.
  const [tags, setTags] = useState<Record<number, CivitaiTag[] | 'loading' | 'error'>>({})
  const [tagsExpanded, setTagsExpanded] = useState(false)
  useBackHandler(true, onClose)
  // After the viewer's own handler — back closes the send sheet first.
  useBackHandler(sendOpen, () => setSendOpen(false))
  useBackHandler(imageSendOpen, () => setImageSendOpen(false))

  useEffect(() => {
    setSendOpen(false)
    setImageSendOpen(false)
    setLoraSendOpen(false)
    setPromptExpanded(false)
    setTagsExpanded(false)
    if (onPickTag && !tags[item.id]) {
      setTags((t) => ({ ...t, [item.id]: 'loading' }))
      fetchCivitaiImageTags(item.id)
        .then((list) => setTags((t) => ({ ...t, [item.id]: list })))
        .catch(() => setTags((t) => ({ ...t, [item.id]: 'error' })))
    }
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
  const resources = gen?.resources.length
    ? gen.resources
    : gen?.model
      ? [
          {
            versionId: null,
            name: gen.model,
            type: 'Checkpoint',
            baseModel: null,
            strength: null,
          },
        ]
      : []

  // Every resource with a version, not only LORA-typed ones: Civitai lists
  // some LoRAs under a checkpoint-typed model — whether it's a LoRA here is
  // decided by matching it against the PC's LoRA files.
  const postLoras: PostLora[] = resources.flatMap((r) =>
    r.versionId != null
      ? [{ versionId: r.versionId, name: r.name, strength: r.strength, isLora: r.type === 'LORA' || r.type === 'LoCon' }]
      : [],
  )
  const showLoraSend = postLoras.some((l) => l.isLora) || postLoras.length > 1

  const comfyLists = {
    samplerNames: objectInfo.samplerNames,
    schedulerNames: objectInfo.schedulerNames,
  }

  return (
    <div role="dialog" aria-modal="true" className="popup-overlay civitai-viewer-overlay" onClick={onClose}>
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
                  <button
                    key={i}
                    type="button"
                    className={isLora ? 'civitai-resource civitai-resource-lora' : 'civitai-resource'}
                    disabled={r.versionId == null}
                    onClick={() => r.versionId != null && onPickModel({ id: r.versionId, name: r.name }, item.type)}
                  >
                    {r.name}
                    {isLora && r.strength != null && <span className="civitai-resource-strength">{r.strength}</span>}
                    {r.versionId != null && <span className="civitai-resource-go">›</span>}
                  </button>
                )
              })}
            </div>
          )}

          {onPickTag && Array.isArray(tags[item.id]) && (tags[item.id] as CivitaiTag[]).length > 0 && (
            <div className="civitai-post-tags">
              <span className="civitai-section-label">Etiketler</span>
              <div className="civitai-tag-cloud">
                {(tagsExpanded ? (tags[item.id] as CivitaiTag[]) : (tags[item.id] as CivitaiTag[]).slice(0, TAGS_SHOWN)).map((t) => (
                  <button key={t.id} type="button" className="chip" onClick={() => onPickTag(t, item.type)}>
                    {t.name}
                  </button>
                ))}
                {!tagsExpanded && (tags[item.id] as CivitaiTag[]).length > TAGS_SHOWN && (
                  <button type="button" className="chip chip-more" onClick={() => setTagsExpanded(true)}>
                    +{(tags[item.id] as CivitaiTag[]).length - TAGS_SHOWN}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="civitai-actions">
            <button type="button" className="generate-button" disabled={!prompt} onClick={() => setSendOpen(true)}>
              Metadata gönder
            </button>
            {showLoraSend && (
              <button type="button" className="secondary-button civitai-lora-send-button" onClick={() => setLoraSendOpen(true)}>
                LoRA gönder
              </button>
            )}
            {item.type === 'image' && (
              <button type="button" className="secondary-button civitai-image-send" onClick={() => setImageSendOpen(true)}>
                Resmi gönder
              </button>
            )}
            <a
              className="secondary-button civitai-open-link"
              href={civitaiPageUrl(item)}
              target="_blank"
              rel="noreferrer"
              aria-label="Civitai'de aç"
            >
              ↗
            </a>
          </div>
        </div>

        {loraSendOpen && <CivitaiLoraSend loras={postLoras} onSend={onSend} onClose={() => setLoraSendOpen(false)} />}

        {imageSendOpen && (
          <div
            role="dialog"
            aria-modal="true"
            className="popup-overlay media-action-overlay"
            onClick={() => !imageSending && setImageSendOpen(false)}
          >
            <div className="media-action-menu civitai-send-menu" onClick={(e) => e.stopPropagation()}>
              {(
                [
                  { target: 'video', label: 'MiniMax (ilk kare)' },
                  { target: 'anime2real', label: 'Edit (Flux)' },
                ] as const
              ).map((t) => (
                <button
                  key={t.target}
                  type="button"
                  className="secondary-button"
                  disabled={imageSending !== null}
                  onClick={async () => {
                    setImageSending(t.target)
                    try {
                      const inputImage = await sendCivitaiImageToInput(item)
                      onSend(
                        t.target === 'video'
                          ? {
                              kind: 'video',
                              settings: { inputImage, inputImageEnabled: true },
                            }
                          : { kind: 'anime2real', settings: { inputImage } },
                      )
                    } catch (err) {
                      alert(`Gönderilemedi: ${(err as Error).message}`)
                    } finally {
                      setImageSending(null)
                    }
                  }}
                >
                  {imageSending === t.target ? 'Gönderiliyor…' : t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {sendOpen && (
          <div role="dialog" aria-modal="true" className="popup-overlay media-action-overlay" onClick={() => setSendOpen(false)}>
            <div className="media-action-menu civitai-send-menu" onClick={(e) => e.stopPropagation()}>
              {SEND_TARGETS.map((t) => {
                const result = civitaiToImport(t.kind, gen, comfyLists)
                return (
                  <button
                    key={t.kind}
                    type="button"
                    className="secondary-button"
                    disabled={!result}
                    onClick={() => result && onSend(result.payload)}
                  >
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
