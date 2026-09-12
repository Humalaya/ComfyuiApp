import { useEffect, useRef, useState } from 'react'
import { useOutputBrowser, useOutputSources } from '../hooks/useOutputBrowser'
import { outputFileUrl, outputThumbnailUrl, type OutputFile } from '../api/outputsClient'
import { extractA1111PositivePrompt, extractShareableMetadataText, parseComfyWorkflowJson, readPngTextChunks } from '../utils/pngMetadata'
import { extractSettingsFromPrompt } from '../workflow/pngImport'
import { extractImageSettingsFromPrompt } from '../workflow/imagePngImport'
import { extractKrea2SettingsFromPrompt } from '../workflow/krea2PngImport'
import { uploadImage, type ComfyWorkflow } from '../api/comfyClient'
import type { GenerationSettings } from '../workflow/fieldMap'
import type { ImageGenerationSettings } from '../workflow/imageFieldMap'
import type { Krea2GenerationSettings } from '../workflow/krea2FieldMap'
import { FullscreenViewer } from './FullscreenViewer'
import { MetadataModal } from './MetadataModal'

const PAGE_SIZE = 60

// Which of the three Create tabs a recognized settings payload targets — a
// Gallery source maps 1:1 onto one of these (see KIND_BY_SOURCE below), since
// each source is already rooted at exactly one generation type's own output
// folder. Keeping this a real discriminated union (kind travels together
// with its matching settings shape) rather than a loose kind+settings pair
// is what lets App.tsx route each one to the right tab/state without a cast.
export type ImportPayload =
  | { kind: 'video'; settings: Partial<GenerationSettings> }
  | { kind: 'sdxl'; settings: Partial<ImageGenerationSettings> }
  | { kind: 'krea2'; settings: Partial<Krea2GenerationSettings> }

// Gallery source id -> which Create tab its metadata should populate. Kept
// as its own map (rather than just reusing the source id as the kind
// directly) since the ids don't quite line up: the Krea Gallery source is
// 'krea' but the Create tab/settings shape is 'krea2' (see krea2FieldMap.ts
// for why the "2" — Krea2/FLUX — is part of that name but not the folder).
const KIND_BY_SOURCE: Record<string, ImportPayload['kind']> = {
  video: 'video',
  sdxl: 'sdxl',
  krea: 'krea2',
}

interface MetadataState {
  title: string
  text: string
  // null when nothing recognized — the metadata text itself may still be
  // worth showing (e.g. a Forge/A1111 PNG's "parameters" text with no node
  // graph to map settings from).
  payload: ImportPayload | null
  imageBlob: Blob | null
}

interface Props {
  onSendToCreate: (payload: ImportPayload) => void
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
  // 'video' first/default — matches the tab order (Video, Krea, SDXL) and
  // this app's own "video generation" starting point. The effect below
  // corrects this to whatever the server actually reports if 'video' isn't
  // among the configured sources.
  const [source, setSource] = useState('video')
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
  // with hundreds of same-looking dated folders.
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

  // No click-event param — callers that need to stop it bubbling into a
  // wrapping tile's own onClick (the grid) do that themselves; the fullscreen
  // viewer's button isn't nested inside anything it'd need to stop.
  async function loadMetadata(item: OutputFile) {
    setMetadataLoadingName(item.name)
    // Which Create tab this PNG's settings (if any are recognized) target —
    // decided by which Gallery source it came from, since each source is
    // already rooted at exactly one generation type's own folder.
    const kind = KIND_BY_SOURCE[source] ?? 'video'
    try {
      const res = await fetch(outputFileUrl(source, item.name))
      const blob = await res.blob()
      const chunks = await readPngTextChunks(blob)
      const text = extractShareableMetadataText(chunks)

      let payload: ImportPayload | null = null
      if (chunks.prompt) {
        // ComfyUI-style: the full API workflow JSON — reuse the exact same
        // class_type/title mapping as the "Import PNG" feature on each
        // Create tab, so a PNG from that workflow family fills in everything
        // it recognizes. Each family has its own extractor since the three
        // workflows share almost no node identities with each other.
        try {
          const workflow = parseComfyWorkflowJson(chunks.prompt) as ComfyWorkflow
          if (kind === 'video') payload = { kind, settings: extractSettingsFromPrompt(workflow).settings }
          else if (kind === 'sdxl') payload = { kind, settings: extractImageSettingsFromPrompt(workflow).settings }
          else payload = { kind, settings: extractKrea2SettingsFromPrompt(workflow).settings }
        } catch {
          // malformed JSON — leave payload null, metadata text is still shown
        }
      } else if (chunks.parameters) {
        // A1111/Forge: no node graph to map onto any of this app's three
        // workflows, but the positive prompt text alone is still worth
        // carrying over — `prompt` is a field on all three settings shapes.
        const prompt = extractA1111PositivePrompt(chunks.parameters)
        if (prompt) payload = { kind, settings: { prompt } } as ImportPayload
      }

      setMetadata({ title: item.name, text: text ?? 'Bu PNG içinde tanınan bir metadata bulunamadı.', payload, imageBlob: blob })
    } catch (err) {
      setMetadata({ title: item.name, text: `Metadata okunamadı: ${(err as Error).message}`, payload: null, imageBlob: null })
    } finally {
      setMetadataLoadingName(null)
    }
  }

  async function uploadCurrentImage(): Promise<GenerationSettings['inputImage']> {
    if (!metadata?.imageBlob) return null
    const uploaded = await uploadImage(metadata.imageBlob, folderLabel(metadata.title))
    return { filename: uploaded.name, subfolder: uploaded.subfolder, type: uploaded.type }
  }

  // Sends the recognized settings to whichever Create tab they target. Only
  // the video tab has an inputImage concept at all (SDXL/Krea2 are pure
  // Text2Img, no image input) — for that one, this exact PNG is attached as
  // the input image too, rather than whatever stale reference image the
  // historical metadata might point to; reusing a past output as the next
  // starting frame is the whole point of sending settings from the gallery.
  async function handleSendSettings() {
    if (!metadata?.payload) return
    setSendingAction('settings')
    try {
      if (metadata.payload.kind === 'video') {
        const inputImage = await uploadCurrentImage()
        // inputImageEnabled has to be flipped on here too, not just
        // inputImage itself — buildWorkflow() only wires first_frame into the
        // workflow when *both* are set (see fieldMap.ts), so without this the
        // image lands in settings/state but a generate() right after still
        // silently runs as txt2vid, using none of what was just "sent".
        onSendToCreate({
          kind: 'video',
          settings: { ...metadata.payload.settings, ...(inputImage ? { inputImage, inputImageEnabled: true } : null) },
        })
      } else {
        onSendToCreate(metadata.payload)
      }
      setMetadata(null)
    } catch (err) {
      alert(`Gönderilemedi: ${(err as Error).message}`)
    } finally {
      setSendingAction(null)
    }
  }

  // Uploads this exact PNG to ComfyUI's input folder and sets it as the
  // *video* tab's input image — independent of whatever settings/prompt
  // metadata it may or may not carry, and independent of which source it
  // came from (SDXL/Krea2 images make perfectly good video starting frames
  // too, they just have no settings of their own to carry over the same way
  // an image-to-video PNG's would). Always targets 'video' since that's the
  // only one of the three Create tabs with an image-input concept at all.
  async function handleSendImageOnly() {
    if (!metadata?.imageBlob) return
    setSendingAction('image')
    try {
      const inputImage = await uploadCurrentImage()
      // Same reasoning as handleSendSettings above — enabling the toggle is
      // what actually makes buildWorkflow() use this image at all.
      onSendToCreate({ kind: 'video', settings: { inputImage, inputImageEnabled: true } })
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

      <span className="field-hint">Kaydetmek/paylaşmak için bir dosyaya dokunup büyütün, sonra üzerine uzun basın.</span>

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
              {item.ext === '.png' && (
                <button
                  type="button"
                  className="gallery-metadata-button"
                  onClick={(e) => {
                    e.stopPropagation()
                    loadMetadata(item)
                  }}
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
        onMetadata={activeItem?.ext === '.png' ? () => loadMetadata(activeItem) : undefined}
      />
      <MetadataModal
        title={metadata?.title ?? null}
        text={metadata?.text ?? null}
        onClose={() => setMetadata(null)}
        onSendToCreate={metadata?.payload ? handleSendSettings : undefined}
        // Only the video tab gets this exact PNG attached as its input image
        // too (see handleSendSettings) — the button text should say so only
        // when that's actually what's about to happen.
        sendSettingsLabel={metadata?.payload?.kind === 'video' ? '📝 Ayarları + Resmi Gönder' : '📝 Ayarları Gönder'}
        sendingSettings={sendingAction === 'settings'}
        onSendImageOnly={metadata?.imageBlob ? handleSendImageOnly : undefined}
        sendingImage={sendingAction === 'image'}
      />
    </div>
  )
}
