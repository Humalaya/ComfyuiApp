import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useOutputBrowser, useOutputSources } from '../hooks/useOutputBrowser'
import { outputDownloadUrl, outputFileUrl, outputThumbnailUrl, type OutputFile } from '../api/outputsClient'
import { extractA1111PositivePrompt, extractShareableMetadataText, readPngTextChunks } from '../utils/pngMetadata'
import { extractSettingsFromPrompt } from '../workflow/pngImport'
import { uploadImage, type ComfyWorkflow } from '../api/comfyClient'
import type { GenerationSettings } from '../workflow/fieldMap'
import { FullscreenViewer } from './FullscreenViewer'
import { MetadataModal } from './MetadataModal'

const PAGE_SIZE = 60

interface MetadataState {
  title: string
  text: string
  settingsToSend: Partial<GenerationSettings> | null
  imageBlob: Blob | null
}

interface Props {
  onSendToCreate: (settings: Partial<GenerationSettings>) => void
}

function formatDate(mtimeMs: number): string {
  return new Date(mtimeMs).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function folderLabel(fullPath: string): string {
  return fullPath.slice(fullPath.lastIndexOf('/') + 1)
}

export function Gallery({ onSendToCreate }: Props) {
  const { sources, loading: sourcesLoading } = useOutputSources()
  const [source, setSource] = useState('comfyui')
  const [currentPath, setCurrentPath] = useState('')
  const { folders, items, loading, error, refresh } = useOutputBrowser(source, currentPath)
  // An index into `items` rather than the item itself — that's what makes
  // "next"/"previous" a one-line index +/- 1 instead of having to search the
  // list every time. `items` already holds the whole folder's listing (see
  // useOutputBrowser.ts), not just the paginated slice rendered as tiles, so
  // navigating past what's currently on screen still works.
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const activeItem = activeIndex !== null ? (items[activeIndex] ?? null) : null
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [metadata, setMetadata] = useState<MetadataState | null>(null)
  const [metadataLoadingName, setMetadataLoadingName] = useState<string | null>(null)
  const [sendingAction, setSendingAction] = useState<'settings' | 'image' | null>(null)
  // The subfolder path you just came *up* from, so it can be highlighted in
  // its parent's folder list — a plain "Geri" with no other cue made it easy
  // to lose track of which folder you were just in, especially in a source
  // with hundreds of same-looking dated folders (Forge).
  const [justLeftPath, setJustLeftPath] = useState<string | null>(null)

  // Restores scroll position on "Geri"/folder navigation instead of always
  // landing back at the top. Without this, going up a folder (often to a
  // *shorter* listing, or briefly an empty one while `loading`) collapses
  // the page height out from under the current scroll offset, so the
  // browser clamps scroll back to 0 — which reads as "it always jumps to the
  // top" even though nothing explicitly scrolled anywhere.
  const scrollPositions = useRef<Map<string, number>>(new Map())
  const pendingRestoreKey = useRef<string | null>(null)

  function pathKey(src: string, path: string): string {
    return `${src}::${path}`
  }

  function saveScrollPosition() {
    scrollPositions.current.set(pathKey(source, currentPath), window.scrollY)
  }

  // Only actually restores once, right after the navigation that requested
  // it (via pendingRestoreKey) finishes loading its new content — a plain
  // "🔄 Yenile" on the same folder never sets pendingRestoreKey, so it's left
  // alone rather than yanking scroll back on every refresh.
  useEffect(() => {
    const key = pathKey(source, currentPath)
    if (!loading && pendingRestoreKey.current === key) {
      window.scrollTo(0, scrollPositions.current.get(key) ?? 0)
      pendingRestoreKey.current = null
    }
  }, [loading, source, currentPath])

  // Only switch to a source that's actually configured once we know the list.
  useEffect(() => {
    if (!sourcesLoading && sources.length > 0 && !sources.some((s) => s.id === source)) {
      setSource(sources[0].id)
    }
  }, [sourcesLoading, sources, source])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    setActiveIndex(null) // a different folder/source means `items` is about to point at something else entirely
  }, [source, currentPath])

  function switchSource(id: string) {
    saveScrollPosition()
    setJustLeftPath(null)
    pendingRestoreKey.current = pathKey(id, '')
    setSource(id)
    setCurrentPath('')
  }

  function openFolder(folder: string) {
    saveScrollPosition()
    setJustLeftPath(null)
    pendingRestoreKey.current = pathKey(source, folder)
    setCurrentPath(folder)
  }

  function goUp() {
    saveScrollPosition()
    setJustLeftPath(currentPath)
    setCurrentPath((p) => {
      const idx = p.lastIndexOf('/')
      const parent = idx === -1 ? '' : p.slice(0, idx)
      pendingRestoreKey.current = pathKey(source, parent)
      return parent
    })
  }

  async function handleMetadata(item: OutputFile, e: MouseEvent) {
    e.stopPropagation()
    setMetadataLoadingName(item.name)
    try {
      const res = await fetch(outputFileUrl(source, item.name))
      const blob = await res.blob()
      const chunks = await readPngTextChunks(blob)
      const text = extractShareableMetadataText(chunks)

      let settingsToSend: Partial<GenerationSettings> | null = null
      if (chunks.prompt) {
        // ComfyUI-style: the full API workflow JSON — reuse the exact same
        // class_type/title mapping as the "Import PNG" feature on the Create
        // screen, so a video-workflow PNG fills in everything it recognizes.
        try {
          const workflow = JSON.parse(chunks.prompt) as ComfyWorkflow
          settingsToSend = extractSettingsFromPrompt(workflow).settings
        } catch {
          // malformed JSON — leave settingsToSend null, metadata text is still shown
        }
      } else if (chunks.parameters) {
        // A1111/Forge: no node graph to map onto this app's workflow, but the
        // positive prompt text alone is still worth carrying over.
        const prompt = extractA1111PositivePrompt(chunks.parameters)
        if (prompt) settingsToSend = { prompt }
      }

      setMetadata({ title: item.name, text: text ?? 'Bu PNG içinde tanınan bir metadata bulunamadı.', settingsToSend, imageBlob: blob })
    } catch (err) {
      setMetadata({ title: item.name, text: `Metadata okunamadı: ${(err as Error).message}`, settingsToSend: null, imageBlob: null })
    } finally {
      setMetadataLoadingName(null)
    }
  }

  async function uploadCurrentImage(): Promise<GenerationSettings['inputImage']> {
    if (!metadata?.imageBlob) return null
    const uploaded = await uploadImage(metadata.imageBlob, folderLabel(metadata.title))
    return { filename: uploaded.name, subfolder: uploaded.subfolder, type: uploaded.type }
  }

  // Sends the recognized settings *together with* this exact PNG as the
  // input image — not whatever stale reference image the historical
  // metadata might point to. Reusing a past output as the next starting
  // frame is the whole point of sending settings from the gallery.
  async function handleSendSettings() {
    if (!metadata?.settingsToSend) return
    setSendingAction('settings')
    try {
      const inputImage = await uploadCurrentImage()
      onSendToCreate({ ...metadata.settingsToSend, ...(inputImage ? { inputImage } : null) })
      setMetadata(null)
    } catch (err) {
      alert(`Gönderilemedi: ${(err as Error).message}`)
    } finally {
      setSendingAction(null)
    }
  }

  // Uploads this exact PNG to ComfyUI's input folder and sets it as the
  // Create screen's input image — independent of whatever settings/prompt
  // metadata it may or may not carry. Mainly useful for Forge-sourced images,
  // which have no node graph this workflow can map settings from, but are
  // still perfectly usable as an image-to-video starting frame.
  async function handleSendImageOnly() {
    if (!metadata?.imageBlob) return
    setSendingAction('image')
    try {
      const inputImage = await uploadCurrentImage()
      onSendToCreate({ inputImage })
      setMetadata(null)
    } catch (err) {
      alert(`Görsel gönderilemedi: ${(err as Error).message}`)
    } finally {
      setSendingAction(null)
    }
  }

  const visibleFiles = items.slice(0, visibleCount)

  return (
    <div className="gallery">
      {sources.length > 1 && (
        <div className="source-tabs">
          {sources.map((s) => (
            <button key={s.id} className={s.id === source ? 'source-tab source-tab-active' : 'source-tab'} onClick={() => switchSource(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {currentPath && (
        <div className="breadcrumb">
          <button type="button" className="secondary-button" onClick={goUp}>
            ⬅ Geri
          </button>
          <span className="breadcrumb-path">{currentPath}</span>
        </div>
      )}

      <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
        {loading ? 'Yükleniyor…' : '🔄 Yenile'}
      </button>

      {error && <div className="field-error">{error}</div>}
      {!loading && !error && folders.length === 0 && items.length === 0 && (
        <div className="empty-state">Bu klasörde henüz dosya yok.</div>
      )}

      {folders.length > 0 && (
        <div className="folder-list">
          {folders.map((folder) => (
            <button
              key={folder}
              type="button"
              className={folder === justLeftPath ? 'folder-tile folder-tile-recent' : 'folder-tile'}
              onClick={() => openFolder(folder)}
            >
              📁 {folderLabel(folder)}
            </button>
          ))}
        </div>
      )}

      <div className="gallery-grid">
        {visibleFiles.map((item) => (
          <div key={item.name} className="gallery-tile" onClick={() => setActiveIndex(items.indexOf(item))}>
            <div className="gallery-thumb-wrap">
              {item.type === 'image' ? (
                <img className="gallery-thumb" src={outputThumbnailUrl(source, item.name)} alt={item.name} loading="lazy" />
              ) : (
                // Deliberately no <video src> here: with hundreds/thousands of
                // outputs in the folder, giving every grid tile a real video
                // source made the phone's browser fire off a full video load
                // per tile, which piled up dozens of backend faststart-remuxes
                // at once and starved whichever video the user actually
                // tapped. A static placeholder costs nothing.
                <div className="gallery-video-placeholder">▶</div>
              )}
            </div>
            <div className="gallery-meta">
              <span className="gallery-name" title={item.name}>
                {folderLabel(item.name)}
              </span>
              <span className="gallery-sub">
                {formatDate(item.mtimeMs)} · {formatSize(item.size)}
              </span>
            </div>
            <div className="gallery-actions">
              <a
                className="gallery-download"
                href={outputDownloadUrl(source, item.name)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`${item.name} indir`}
              >
                ⬇ İndir
              </a>
              {item.ext === '.png' && (
                <button
                  type="button"
                  className="gallery-metadata-button"
                  onClick={(e) => handleMetadata(item, e)}
                  disabled={metadataLoadingName === item.name}
                >
                  {metadataLoadingName === item.name ? '…' : '📋 Metadata'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {visibleCount < items.length && (
        <button type="button" className="secondary-button" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
          Daha Fazla Yükle ({items.length - visibleCount} kaldı)
        </button>
      )}

      <FullscreenViewer
        source={source}
        item={activeItem}
        hasPrev={activeIndex !== null && activeIndex > 0}
        hasNext={activeIndex !== null && activeIndex < items.length - 1}
        onPrev={() => setActiveIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
        onNext={() => setActiveIndex((i) => (i !== null && i < items.length - 1 ? i + 1 : i))}
        onClose={() => setActiveIndex(null)}
      />
      <MetadataModal
        title={metadata?.title ?? null}
        text={metadata?.text ?? null}
        onClose={() => setMetadata(null)}
        onSendToCreate={metadata?.settingsToSend ? handleSendSettings : undefined}
        sendingSettings={sendingAction === 'settings'}
        onSendImageOnly={metadata?.imageBlob ? handleSendImageOnly : undefined}
        sendingImage={sendingAction === 'image'}
      />
    </div>
  )
}
