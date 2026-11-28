import { useCallback, useEffect, useRef, useState } from 'react'
import {
  civitaiThumbUrl,
  fetchCivitaiPage,
  type CivitaiItem,
  type CivitaiPeriod,
  type CivitaiSort,
  type CivitaiTag,
} from '../api/civitaiBrowser'
import {
  fetchCivitaiModel,
  formatBytes,
  removeDownload,
  startDownload,
  type CivitaiModel,
  type CivitaiModelFile,
  type CivitaiModelVersion,
} from '../api/modelsClient'
import { useModelDownloads } from '../hooks/useModelDownloads'
import { useBackHandler } from '../native/backButton'
import { CivitaiViewer } from './CivitaiBrowser'
import { formatCount, PERIODS } from './civitaiShared'
import { DiskUsage } from './DiskUsage'
import type { ImportPayload } from './Gallery'

export interface ModelRef {
  versionId?: number
  modelId?: number
  type?: 'image' | 'video'
}

interface Props {
  model: ModelRef
  onClose: () => void
  onOpenModel: (ref: ModelRef) => void
  onSendToCreate: (payload: ImportPayload) => void
  onOpenModels: () => void
  // A post's tag tapped in the viewer — the feed shows that tag's posts.
  onPickTag?: (tag: CivitaiTag, type: 'image' | 'video') => void
  // One of the model's own tags tapped — Modeller filtered by it.
  onPickModelTag?: (name: string) => void
  // A poster's name tapped in the viewer — their posts.
  onPickUser?: (username: string) => void
}

const VIDEO_BASES = /video|wan|ltx|minimax|hunyuan|seedance|mochi|cogvideo/i

// A Civitai model's own page, opened from a resource chip in the viewer (or
// a downloaded model's "Civitai sayfası"): what it is, every version with
// its files — downloadable to the PC — and the images made with the chosen
// version, sortable like the main feed.
export function CivitaiModelPage({
  model: ref,
  onClose,
  onOpenModel,
  onSendToCreate,
  onOpenModels,
  onPickTag,
  onPickModelTag,
  onPickUser,
}: Props) {
  const [model, setModel] = useState<CivitaiModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [versionId, setVersionId] = useState<number | null>(ref.versionId ?? null)
  const [diskKey, setDiskKey] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  useBackHandler(true, onClose)

  const load = useCallback(() => {
    fetchCivitaiModel(ref)
      .then((m) => {
        setModel(m)
        setVersionId((v) => (v && m.versions.some((x) => x.id === v) ? v : (m.versions[0]?.id ?? null)))
      })
      .catch((e) => setError((e as Error).message))
  }, [ref])

  useEffect(() => {
    setModel(null)
    setError(null)
    setVersionId(ref.versionId ?? null)
    scroller.current?.scrollTo(0, 0)
    load()
  }, [ref, load])

  const { downloads, refresh: refreshDownloads } = useModelDownloads(true, () => {
    load()
    setDiskKey((k) => k + 1)
  })

  const version = model?.versions.find((v) => v.id === versionId) ?? model?.versions[0] ?? null

  return (
    <div className="civitai-model-page" ref={scroller}>
      <div className="civitai-model-head">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Geri">
          ‹
        </button>
        <span className="civitai-model-title">{model?.name ?? 'Model'}</span>
        {model && (
          <a
            className="icon-button"
            href={`https://civitai.com/models/${model.id}${version ? `?modelVersionId=${version.id}` : ''}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Civitai'de aç"
          >
            ↗
          </a>
        )}
      </div>

      {error && <div className="status-warning">{error}</div>}
      {!model && !error && <div className="spinner" aria-label="Yükleniyor" />}

      {model && (
        <>
          <div className="civitai-model-meta">
            <span className="civitai-model-type">{model.type}</span>
            {model.creator && <span>{model.creator}</span>}
            <span>⬇ {formatCount(model.downloads)}</span>
            <span>👍 {formatCount(model.likes)}</span>
            {model.nsfw && <span className="civitai-model-nsfw">NSFW</span>}
          </div>

          {model.versions.length > 1 && (
            // One compact line however many versions there are (some have
            // 15+): a native picker, newest first, locked ones marked.
            <label className="civitai-version-select">
              <span className="civitai-version-select-label">Sürüm</span>
              <select value={version?.id ?? ''} onChange={(e) => setVersionId(Number(e.target.value))}>
                {model.versions.map((v, i) => (
                  <option key={v.id} value={v.id}>
                    {v.availability !== 'Public' ? '🔒 ' : ''}
                    {v.name}
                    {v.baseModel ? ` · ${v.baseModel}` : ''}
                    {i === 0 ? ' (en yeni)' : ''}
                  </option>
                ))}
              </select>
              <span className="civitai-version-select-count">{model.versions.length} sürüm</span>
            </label>
          )}

          {version && (
            <VersionCard
              version={version}
              downloads={downloads}
              onChanged={() => {
                refreshDownloads()
                load()
                setDiskKey((k) => k + 1)
              }}
              onOpenModels={onOpenModels}
            />
          )}

          <DiskUsage refreshKey={diskKey} />

          {(model.description || model.tags.length > 0) && (
            <Description text={model.description} tags={model.tags} onPickTag={onPickModelTag} />
          )}

          {version && (
            <VersionImages
              key={version.id}
              version={version}
              initialType={ref.type ?? (VIDEO_BASES.test(version.baseModel ?? '') ? 'video' : 'image')}
              onOpenModel={onOpenModel}
              onSendToCreate={onSendToCreate}
              onPickTag={onPickTag}
              onPickUser={onPickUser}
            />
          )}
        </>
      )}
    </div>
  )
}

function VersionCard({
  version,
  downloads,
  onChanged,
  onOpenModels,
}: {
  version: CivitaiModelVersion
  downloads: ReturnType<typeof useModelDownloads>['downloads']
  onChanged: () => void
  onOpenModels: () => void
}) {
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [starting, setStarting] = useState<number | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const locked = version.availability !== 'Public'

  async function download(f: CivitaiModelFile) {
    setStarting(f.id)
    setErrors((e) => ({ ...e, [f.id]: '' }))
    try {
      await startDownload(version.id, f.id)
      onChanged()
    } catch (err) {
      setErrors((e) => ({ ...e, [f.id]: (err as Error).message }))
    } finally {
      setStarting(null)
    }
  }

  // Model weights first; training data / configs last.
  const files = [...version.files].sort(
    (a, b) => Number(b.type === 'Model') - Number(a.type === 'Model') || Number(b.primary) - Number(a.primary),
  )

  return (
    <div className="civitai-version">
      <div className="civitai-version-top">
        {version.cover && <img className="civitai-version-cover" src={version.cover} alt="" />}
        <div className="civitai-version-info">
          <div className="civitai-version-name">{version.name}</div>
          <div className="civitai-version-sub">
            {version.baseModel && <span className="civitai-viewer-base">{version.baseModel}</span>}
            {version.publishedAt && <span>{new Date(version.publishedAt).toLocaleDateString('tr-TR')}</span>}
            <span>⬇ {formatCount(version.downloads)}</span>
          </div>
          {locked && (
            <div className="civitai-version-locked">
              🔒 {version.availability === 'EarlyAccess' ? 'Erken erişim' : version.availability} — indirme reddedilebilir. Eski sürümler
              çoğu zaman serbest.
            </div>
          )}
        </div>
      </div>

      {version.trainedWords.length > 0 && (
        <div className="civitai-version-words">
          <span className="civitai-section-label">Tetik kelimeler</span>
          {version.trainedWords.map((w) => (
            <button
              key={w}
              type="button"
              className={copied === w ? 'tag-chip tag-chip-active' : 'tag-chip'}
              onClick={() => {
                navigator.clipboard?.writeText(w).catch(() => {})
                setCopied(w)
                window.setTimeout(() => setCopied((c) => (c === w ? null : c)), 1200)
              }}
            >
              {copied === w ? 'Kopyalandı' : w}
            </button>
          ))}
        </div>
      )}

      <div className="civitai-files">
        {files.map((f) => {
          const job = downloads.find((d) => d.fileId === f.id && (d.status === 'downloading' || d.id === f.jobId)) ?? null
          const pct = job && job.bytes > 0 ? Math.min(100, (job.received / job.bytes) * 100) : 0
          return (
            <div key={f.id} className="civitai-file">
              <div className="civitai-file-name">{f.name}</div>
              <div className="civitai-file-sub">
                {[f.type, f.format, f.fp, f.size].filter(Boolean).join(' · ')} · {formatBytes(f.bytes)}
              </div>
              {job?.status === 'downloading' ? (
                <div className="download-progress">
                  <div className="download-bar">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <span className="download-progress-text">
                    %{Math.floor(pct)} · {formatBytes(job.speed)}/s
                  </span>
                  <button type="button" className="icon-button" onClick={() => removeDownload(job.id).then(onChanged)} aria-label="İptal">
                    ✕
                  </button>
                </div>
              ) : f.local ? (
                <button type="button" className="civitai-file-local" onClick={onOpenModels}>
                  ✓ PC'de: {f.local} ›
                </button>
              ) : !f.allowed ? (
                <div className="civitai-file-blocked">Bu format indirilmez ({f.format ?? 'bilinmiyor'}) — sadece .safetensors / .gguf</div>
              ) : (
                <button
                  type="button"
                  className="secondary-button civitai-file-download"
                  disabled={starting !== null}
                  onClick={() => download(f)}
                >
                  {starting === f.id ? 'Başlatılıyor…' : `⬇ PC'ye indir (${formatBytes(f.bytes)})`}
                </button>
              )}
              {job?.status === 'downloading' && job.note && <div className="download-note">{job.note}</div>}
              {job?.status === 'error' && <div className="field-error">{job.error}</div>}
              {errors[f.id] && <div className="field-error">{errors[f.id]}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Description({ text, tags, onPickTag }: { text: string; tags: string[]; onPickTag?: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="civitai-model-desc">
      {text && (
        <button type="button" className={open ? 'civitai-prompt civitai-prompt-open' : 'civitai-prompt'} onClick={() => setOpen((o) => !o)}>
          <span className="civitai-prompt-text">{text}</span>
        </button>
      )}
      {tags.length > 0 && (
        <div className="civitai-model-tags">
          {tags.map((t) =>
            onPickTag ? (
              <button key={t} type="button" className="civitai-model-tag civitai-model-tag-link" onClick={() => onPickTag(t)}>
                {t}
              </button>
            ) : (
              <span key={t} className="civitai-model-tag">
                {t}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  )
}

function VersionImages({
  version,
  initialType,
  onOpenModel,
  onSendToCreate,
  onPickTag,
  onPickUser,
}: {
  version: CivitaiModelVersion
  initialType: 'image' | 'video'
  onOpenModel: (ref: ModelRef) => void
  onSendToCreate: (payload: ImportPayload) => void
  onPickTag?: (tag: CivitaiTag, type: 'image' | 'video') => void
  onPickUser?: (username: string) => void
}) {
  const [type, setType] = useState(initialType)
  const [sort, setSort] = useState<CivitaiSort>('Most Reactions')
  const [period, setPeriod] = useState<CivitaiPeriod>('AllTime')
  const [items, setItems] = useState<CivitaiItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const requestId = useRef(0)

  const load = useCallback(
    async (from: string | null) => {
      const id = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const page = await fetchCivitaiPage(
          { type, sort, period, baseModels: [], withMeta: false, nsfwOnly: false, modelVersion: { id: version.id, name: version.name } },
          from,
        )
        if (id !== requestId.current) return
        setItems((prev) => (from ? [...prev, ...page.items] : page.items))
        setCursor(page.nextCursor)
      } catch (e) {
        if (id === requestId.current) setError((e as Error).message)
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [type, sort, period, version.id, version.name],
  )

  useEffect(() => {
    setItems([])
    setCursor(null)
    load(null)
  }, [load])

  const seg = (a: boolean) => (a ? 'seg-btn seg-btn-active' : 'seg-btn')

  return (
    <div className="civitai-model-images">
      <div className="civitai-section-label">Bu sürümle üretilenler</div>
      <div className="civitai-toolbar">
        <div className="seg">
          <button type="button" className={seg(type === 'image')} onClick={() => setType('image')}>
            Görseller
          </button>
          <button type="button" className={seg(type === 'video')} onClick={() => setType('video')}>
            Videolar
          </button>
        </div>
        <div className="seg">
          <button type="button" className={seg(sort === 'Most Reactions')} onClick={() => setSort('Most Reactions')}>
            Popüler
          </button>
          <button type="button" className={seg(sort === 'Newest')} onClick={() => setSort('Newest')}>
            Yeni
          </button>
        </div>
      </div>
      {sort === 'Most Reactions' && (
        <div className="chip-row">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={period === p.value ? 'chip chip-active' : 'chip'}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="status-warning">
          {error}
          <button type="button" className="secondary-button" onClick={() => load(items.length > 0 ? cursor : null)}>
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
        <div className="empty-state">Bu sürümle paylaşılmış {type === 'video' ? 'video' : 'görsel'} yok.</div>
      )}
      {loading && <div className="spinner" aria-label="Yükleniyor" />}
      {!loading && cursor && (
        <button type="button" className="secondary-button more-button" onClick={() => load(cursor)}>
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
          onPickModel={(mv, t) => {
            setViewerIndex(null)
            onOpenModel({ versionId: mv.id, type: t })
          }}
          onPickTag={onPickTag}
          onPickUser={(name) => {
            setViewerIndex(null)
            onPickUser?.(name)
          }}
        />
      )}
    </div>
  )
}
