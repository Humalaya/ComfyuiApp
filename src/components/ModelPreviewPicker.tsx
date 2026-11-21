import { useEffect, useRef, useState } from 'react'
import { civitaiThumbUrl, fetchCivitaiPage, type CivitaiItem } from '../api/civitaiBrowser'
import { setModelPreviewBlob, setModelPreviewFrom, type LocalModel } from '../api/modelsClient'
import { listOutputs, listSources, outputThumbnailUrl, type OutputListing, type OutputSource } from '../api/outputsClient'
import { useBackHandler } from '../native/backButton'
import { readClipboardImage } from '../native/clipboardImage'

interface Props {
  model: LocalModel
  onDone: () => void
  onClose: () => void
}

type Mode = 'menu' | 'gallery' | 'civitai'

// "Resim ekle" for a model: the picture saved next to it as <name>.jpg —
// what the LoRA picker (rgthree) shows as its thumbnail. From the phone,
// the clipboard, a Galeri output, or one of the model's own Civitai images.
export function ModelPreviewPicker({ model, onDone, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('menu')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  useBackHandler(true, () => (mode === 'menu' ? onClose() : setMode('menu')))

  async function run(task: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await task()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fileName = model.path.split('/').pop()

  return (
    <div role="dialog" aria-modal="true" className="popup-overlay media-action-overlay" onClick={() => !busy && onClose()}>
      <div className="model-preview-picker" onClick={(e) => e.stopPropagation()}>
        <div className="lora-picker-header">
          {mode !== 'menu' && (
            <button type="button" className="icon-button" onClick={() => setMode('menu')} aria-label="Geri">
              ‹
            </button>
          )}
          <span className="model-preview-picker-title">Resim: {fileName}</span>
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat" disabled={busy}>
            ✕
          </button>
        </div>

        {error && <div className="field-error">{error}</div>}
        {busy && <div className="spinner" aria-label="Kaydediliyor" />}

        {mode === 'menu' && (
          <div className="model-preview-options">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}>
              📱 Telefondan seç
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => run(async () => setModelPreviewBlob(model, await readClipboardImage()))}
            >
              📋 Panodan yapıştır
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setMode('gallery')}>
              🖼️ Galeriden
            </button>
            {model.civitai && (
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setMode('civitai')}>
                🌐 Civitai görsellerinden
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) run(() => setModelPreviewBlob(model, f))
              }}
            />
          </div>
        )}

        {mode === 'gallery' && (
          <GalleryPick disabled={busy} onPick={(source, name) => run(() => setModelPreviewFrom(model, { source, name }))} />
        )}
        {mode === 'civitai' && model.civitai && (
          <CivitaiPick
            versionId={model.civitai.versionId}
            disabled={busy}
            onPick={(item) => run(() => setModelPreviewFrom(model, { url: item.url }))}
          />
        )}
      </div>
    </div>
  )
}

function GalleryPick({ disabled, onPick }: { disabled: boolean; onPick: (source: string, name: string) => void }) {
  const [sources, setSources] = useState<OutputSource[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState<OutputListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSources()
      .then((s) => {
        const ok = s.filter((x) => x.configured)
        setSources(ok)
        setSource(ok.find((x) => x.id === 'sdxl')?.id ?? ok[0]?.id ?? null)
      })
      .catch((e) => setError((e as Error).message))
  }, [])

  useEffect(() => {
    if (!source) return
    setListing(null)
    setError(null)
    listOutputs(source, dir)
      .then(setListing)
      .catch((e) => setError((e as Error).message))
  }, [source, dir])

  const images = listing?.files.filter((f) => f.type === 'image') ?? []

  return (
    <div className="model-preview-pick">
      <div className="seg">
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === source ? 'seg-btn seg-btn-active' : 'seg-btn'}
            onClick={() => {
              setSource(s.id)
              setDir('')
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      {dir && (
        <button type="button" className="model-preview-up" onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}>
          ‹ {dir}
        </button>
      )}
      {error && <div className="field-error">{error}</div>}
      {!listing && !error && <div className="spinner" />}
      {listing && listing.folders.length > 0 && (
        <div className="chip-row chip-row-flush model-preview-folders">
          {listing.folders.map((f) => (
            <button key={f} type="button" className="chip" onClick={() => setDir(f)}>
              📁 {f.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      {listing && images.length === 0 && listing.folders.length === 0 && <div className="empty-state">Görsel yok.</div>}
      <div className="model-preview-grid">
        {images.map((f) => (
          <button
            key={f.name}
            type="button"
            className="model-preview-tile"
            disabled={disabled}
            onClick={() => source && onPick(source, f.name)}
          >
            <img src={outputThumbnailUrl(source!, f.name)} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  )
}

function CivitaiPick({ versionId, disabled, onPick }: { versionId: number; disabled: boolean; onPick: (item: CivitaiItem) => void }) {
  const [items, setItems] = useState<CivitaiItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCivitaiPage(
      {
        type: 'image',
        sort: 'Most Reactions',
        period: 'AllTime',
        baseModels: [],
        withMeta: false,
        nsfwOnly: false,
        modelVersion: { id: versionId, name: '' },
      },
      null,
    )
      .then((p) => setItems(p.items.filter((i) => i.type === 'image')))
      .catch((e) => setError((e as Error).message))
  }, [versionId])

  return (
    <div className="model-preview-pick">
      {error && <div className="field-error">{error}</div>}
      {!items && !error && <div className="spinner" />}
      {items && items.length === 0 && <div className="empty-state">Bu sürümle paylaşılmış görsel yok.</div>}
      <div className="model-preview-grid">
        {items?.map((it) => (
          <button key={it.id} type="button" className="model-preview-tile" disabled={disabled} onClick={() => onPick(it)}>
            <img src={civitaiThumbUrl(it)} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  )
}
