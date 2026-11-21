import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteModel,
  formatBytes,
  listModels,
  lockedBy,
  modelPreviewUrl,
  modelsInUse,
  moveModel,
  removeDownload,
  type LocalModel,
  type ModelDownload,
  type ModelListing,
} from '../api/modelsClient'
import { useModelDownloads } from '../hooks/useModelDownloads'
import { useBackHandler } from '../native/backButton'
import type { ModelRef } from './CivitaiModelPage'
import { DiskUsage } from './DiskUsage'
import { HelpTip } from './HelpTip'
import { ModelPreviewPicker } from './ModelPreviewPicker'

interface Props {
  active: boolean
  onOpenCivitaiModel: (ref: ModelRef) => void
}

function fileName(p: string) {
  return p.split('/').pop() ?? p
}

// "Modeller": what Civitai downloads landed in ~/Downloads/civitai, and
// everything in ComfyUI's models/ — move a model where it belongs, delete
// it for good, or give it a picture (the LoRA picker's thumbnail). Models
// a tab is using (its template default, or what's selected in it now) are
// locked.
export function ModelsView({ active, onOpenCivitaiModel }: Props) {
  const [listing, setListing] = useState<ModelListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [menuFor, setMenuFor] = useState<LocalModel | null>(null)
  const [moving, setMoving] = useState<LocalModel | null>(null)
  const [deleting, setDeleting] = useState<LocalModel | null>(null)
  const [picturing, setPicturing] = useState<LocalModel | null>(null)
  const [diskKey, setDiskKey] = useState(0)
  const [inUse, setInUse] = useState<Record<string, string[]>>({})

  const reload = useCallback(() => {
    setError(null)
    setInUse(modelsInUse())
    listModels()
      .then(setListing)
      .catch((e) => setError((e as Error).message))
    setDiskKey((k) => k + 1)
  }, [])

  useEffect(() => {
    if (active) reload()
  }, [active, reload])

  const { downloads, refresh: refreshDownloads } = useModelDownloads(active, reload)
  useBackHandler(menuFor !== null, () => setMenuFor(null))

  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const map = new Map<string, LocalModel[]>()
    for (const m of listing?.models ?? []) {
      if (q && !m.path.toLowerCase().includes(q)) continue
      const top = m.path.split('/')[0]
      map.set(top, [...(map.get(top) ?? []), m])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [listing, q])

  const downloaded = (listing?.downloads ?? []).filter((m) => !q || m.path.toLowerCase().includes(q))
  const jobs = downloads.filter((d) => d.status !== 'done' || Date.now() - d.startedAt < 6 * 3600_000)

  function toggleGroup(g: string) {
    setOpenGroups((s) => {
      const n = new Set(s)
      if (n.has(g)) n.delete(g)
      else n.add(g)
      return n
    })
  }

  function row(m: LocalModel) {
    const locked = lockedBy(m, inUse)
    const preview = modelPreviewUrl(m)
    const parts = m.path.split('/')
    const sub = m.area === 'models' ? parts.slice(1, -1).join('/') : ''
    return (
      <button key={`${m.area}:${m.path}`} type="button" className="model-row" onClick={() => setMenuFor(m)}>
        <span className="model-row-thumb">
          {preview ? <img src={preview} alt="" loading="lazy" /> : <span aria-hidden="true">📦</span>}
        </span>
        <span className="model-row-main">
          <span className="model-row-name">{fileName(m.path)}</span>
          <span className="model-row-sub">
            {sub && <span className="model-row-dir">{sub}</span>}
            <span>{formatBytes(m.size)}</span>
            {locked && <span className="model-row-lock">🔒 {locked.join(', ')}</span>}
          </span>
        </span>
        <span className="model-row-more" aria-hidden="true">
          ⋯
        </span>
      </button>
    )
  }

  const menuLocked = menuFor ? lockedBy(menuFor, inUse) : null

  return (
    <div className="models-view">
      <DiskUsage refreshKey={diskKey} active={active} />

      <div className="search-row">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Model ara…" aria-label="Model ara" />
        <button type="button" className="icon-button" onClick={reload} aria-label="Yenile">
          ↻
        </button>
        <HelpTip>
          Civitai'den indirdiklerin önce İndirilenler'e ({listing?.downloadDir ?? '~/Downloads/civitai'}) iner; oradan "Taşı" ile
          ComfyUI'nin models klasöründe istediğin yere koy. 🔒 olanlar bir sekmenin kullandığı modeller (şablonu ya da o sekmede şu an
          seçili olan) — taşınamaz / silinemez. Silme kalıcıdır, çöp kutusuna gitmez. Resim, LoRA seçicideki küçük resim olur.
        </HelpTip>
      </div>

      {error && (
        <div className="status-warning">
          {error}
          <button type="button" className="secondary-button" onClick={reload}>
            Tekrar dene
          </button>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="models-section">
          <div className="models-section-title">İndirmeler</div>
          {jobs.map((d) => (
            <DownloadRow key={d.id} job={d} onRemove={() => removeDownload(d.id).then(refreshDownloads)} />
          ))}
        </div>
      )}

      <div className="models-section">
        <div className="models-section-title">
          İndirilenler <span className="models-section-count">{downloaded.length}</span>
        </div>
        {listing && downloaded.length === 0 && <div className="field-hint">Taşınmayı bekleyen model yok.</div>}
        {downloaded.map(row)}
      </div>

      <div className="models-section">
        <div className="models-section-title">models</div>
        {!listing && !error && <div className="spinner" />}
        <div className="tag-sheet-sections">
          {groups.map(([g, items]) => {
            const open = q !== '' || openGroups.has(g)
            const bytes = items.reduce((n, m) => n + m.size, 0)
            return (
              <div key={g} className="tag-sheet-section">
                <button type="button" className="tag-sheet-section-head" onClick={() => toggleGroup(g)} aria-expanded={open}>
                  <span className="tag-sheet-section-title">{g}</span>
                  <span className="tag-sheet-section-count">
                    {items.length} · {formatBytes(bytes)}
                  </span>
                  <span className={open ? 'collapsible-toggle-chevron collapsible-toggle-chevron-open' : 'collapsible-toggle-chevron'}>
                    ▾
                  </span>
                </button>
                {open && <div className="models-group">{items.map(row)}</div>}
              </div>
            )
          })}
        </div>
      </div>

      {menuFor && (
        <div role="dialog" aria-modal="true" className="popup-overlay media-action-overlay" onClick={() => setMenuFor(null)}>
          <div className="media-action-menu" onClick={(e) => e.stopPropagation()}>
            <div className="model-menu-title">{fileName(menuFor.path)}</div>
            <div className="model-menu-sub">
              {menuFor.area === 'models' ? `models/${menuFor.path}` : `İndirilenler/${menuFor.path}`} · {formatBytes(menuFor.size)}
            </div>
            {menuLocked && <div className="model-menu-lock">🔒 {menuLocked.join(', ')} sekmesi kullanıyor — taşınamaz, silinemez.</div>}
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setPicturing(menuFor)
                setMenuFor(null)
              }}
            >
              🖼️ {menuFor.preview ? 'Resmi değiştir' : 'Resim ekle'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!!menuLocked}
              onClick={() => {
                setMoving(menuFor)
                setMenuFor(null)
              }}
            >
              📁 Taşı
            </button>
            {menuFor.civitai && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  onOpenCivitaiModel({ versionId: menuFor.civitai!.versionId })
                  setMenuFor(null)
                }}
              >
                🌐 Civitai sayfası
              </button>
            )}
            <button
              type="button"
              className="secondary-button danger-button"
              disabled={!!menuLocked}
              onClick={() => {
                setDeleting(menuFor)
                setMenuFor(null)
              }}
            >
              🗑 Sil
            </button>
          </div>
        </div>
      )}

      {moving && listing && <MoveDialog model={moving} folders={listing.folders} onClose={() => setMoving(null)} onDone={reload} />}
      {deleting && <DeleteDialog model={deleting} onClose={() => setDeleting(null)} onDone={reload} />}
      {picturing && (
        <ModelPreviewPicker
          model={picturing}
          onClose={() => setPicturing(null)}
          onDone={() => {
            setPicturing(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

function DownloadRow({ job, onRemove }: { job: ModelDownload; onRemove: () => void }) {
  const pct = job.bytes > 0 ? Math.min(100, (job.received / job.bytes) * 100) : 0
  const eta = job.speed > 0 ? Math.round((job.bytes - job.received) / job.speed) : null
  return (
    <div className="download-row">
      <div className="download-row-head">
        <span className="download-row-name">{job.name}</span>
        <button
          type="button"
          className="icon-button"
          onClick={onRemove}
          aria-label={job.status === 'downloading' ? 'İptal' : 'Listeden kaldır'}
        >
          ✕
        </button>
      </div>
      <div className="download-row-sub">
        {job.modelName}
        {job.versionName && ` — ${job.versionName}`}
      </div>
      {job.status === 'downloading' && (
        <div className="download-progress">
          <div className="download-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="download-progress-text">
            {formatBytes(job.received)} / {formatBytes(job.bytes)} · {formatBytes(job.speed)}/s
            {eta !== null && ` · ${eta >= 60 ? `${Math.round(eta / 60)} dk` : `${eta} sn`}`}
          </span>
        </div>
      )}
      {job.status === 'downloading' && job.note && <div className="download-note">{job.note}</div>}
      {job.status === 'done' && <div className="download-done">✓ İndi — İndirilenler'de, taşımayı unutma</div>}
      {job.status === 'error' && <div className="field-error">{job.error}</div>}
      {job.status === 'canceled' && <div className="field-hint">İptal edildi</div>}
    </div>
  )
}

function MoveDialog({
  model,
  folders,
  onClose,
  onDone,
}: {
  model: LocalModel
  folders: string[]
  onClose: () => void
  onDone: () => void
}) {
  const current = model.area === 'models' ? model.path.split('/').slice(0, -1).join('/') : null
  const [target, setTarget] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackHandler(true, onClose)

  const f = filter.trim().toLowerCase()
  const shown = folders.filter((d) => !f || d.toLowerCase().includes(f))
  const dest = target ? (newName.trim() ? `${target}/${newName.trim()}` : target) : null

  async function submit() {
    if (!dest) return
    setBusy(true)
    setError(null)
    try {
      await moveModel(model, dest)
      onDone()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="popup-overlay media-action-overlay" onClick={() => !busy && onClose()}>
      <div className="model-move" onClick={(e) => e.stopPropagation()}>
        <div className="lora-picker-header">
          <span className="model-preview-picker-title">Taşı: {fileName(model.path)}</span>
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat" disabled={busy}>
            ✕
          </button>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Klasör ara… (ör. loras)"
          aria-label="Klasör ara"
        />
        <div className="model-move-list">
          {shown.map((d) => {
            const depth = d.split('/').length - 1
            return (
              <button
                key={d}
                type="button"
                className={d === target ? 'model-move-item model-move-item-active' : 'model-move-item'}
                style={{ paddingLeft: 10 + depth * 16 }}
                disabled={d === current}
                onClick={() => setTarget(d)}
              >
                📁 {depth === 0 ? d : d.split('/').pop()}
                {d === current && <span className="model-move-here"> (şu an burada)</span>}
              </button>
            )
          })}
        </div>
        {target && (
          <label className="model-move-new">
            <span>Yeni alt klasör (isteğe bağlı)</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value.replace(/[/\\]/g, ''))} placeholder="ör. Pony" />
          </label>
        )}
        {error && <div className="field-error">{error}</div>}
        <button type="button" className="generate-button" disabled={!dest || busy} onClick={submit}>
          {busy ? 'Taşınıyor…' : dest ? `models/${dest} klasörüne taşı` : 'Bir klasör seç'}
        </button>
      </div>
    </div>
  )
}

function DeleteDialog({ model, onClose, onDone }: { model: LocalModel; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackHandler(true, onClose)
  return (
    <div role="dialog" aria-modal="true" className="popup-overlay media-action-overlay" onClick={() => !busy && onClose()}>
      <div className="media-action-menu" onClick={(e) => e.stopPropagation()}>
        <div className="model-menu-title">Kalıcı olarak silinsin mi?</div>
        <div className="model-menu-sub">
          {fileName(model.path)} · {formatBytes(model.size)}
        </div>
        <div className="field-hint">Çöp kutusuna gitmez, geri alınamaz. Yanındaki resim ve .json da silinir.</div>
        {error && <div className="field-error">{error}</div>}
        <button
          type="button"
          className="secondary-button danger-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await deleteModel(model)
              onDone()
              onClose()
            } catch (e) {
              setError((e as Error).message)
              setBusy(false)
            }
          }}
        >
          {busy ? 'Siliniyor…' : `🗑 Sil (${formatBytes(model.size)})`}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
          Vazgeç
        </button>
      </div>
    </div>
  )
}
