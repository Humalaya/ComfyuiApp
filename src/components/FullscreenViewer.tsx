import { useEffect, useState } from 'react'
import { outputFileUrl, outputMimeType, type OutputFile } from '../api/outputsClient'
import { canSaveMediaNatively, saveMediaToDevice, shareMediaFromDevice } from '../native/saveMedia'

interface Props {
  source: string
  item: OutputFile | null
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  // Opens Galeri's metadata popup for the current item — only ever provided
  // for .png files (see Gallery.tsx). Previously this lived only as a small
  // button on the grid tile; also surfacing it here means it's reachable
  // from wherever you're actually looking at the file, not just the grid.
  onMetadata?: () => void
}

// item.name can carry a subfolder prefix (e.g. "2026-09-07/mm_00001.mp4") —
// only the actual filename is fit to save/share as, or to show as a title.
function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

// Plain modal/popup overlay — deliberately does NOT call the browser
// Fullscreen API. Requesting fullscreen (on the video, or on a wrapping
// element) turned out to be an unreliable source of a stuck gray frame on
// some mobile browsers. A fixed, full-viewport-covering overlay already
// gives the media practically the whole screen without touching that API,
// and it's far more predictable across devices.
export function FullscreenViewer({ source, item, hasPrev, hasNext, onPrev, onNext, onClose, onMetadata }: Props) {
  const [loadError, setLoadError] = useState(false)
  // Long-press ("uzun basma") menu — only relevant inside the native app.
  // Android's WebView (unlike the Chrome *browser app*) has no built-in
  // "save/share image" on long-press of its own, so this is what stands in
  // for it there (see saveMedia.ts/SaveMediaPlugin.java). A real mobile
  // browser tab already gets that for free from the browser itself, so this
  // never intercepts long-press there — doing so would only break the
  // browser's own working save behavior for no benefit.
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<'save' | 'share' | null>(null)

  useEffect(() => {
    setLoadError(false)
    setActionMenuOpen(false)
    if (!item) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [item, onClose, onPrev, onNext])

  if (!item) return null

  function onContextMenu(e: React.MouseEvent) {
    if (!canSaveMediaNatively()) return // let the phone browser's own long-press menu do its thing
    e.preventDefault()
    setActionMenuOpen(true)
  }

  async function handleSave() {
    if (!item) return
    setPendingAction('save')
    try {
      const url = new URL(outputFileUrl(source, item.name), window.location.href).href
      await saveMediaToDevice(url, baseName(item.name), outputMimeType(item.ext))
      setActionMenuOpen(false)
    } catch (err) {
      alert(`Kaydedilemedi: ${(err as Error).message}`)
    } finally {
      setPendingAction(null)
    }
  }

  async function handleShare() {
    if (!item) return
    setPendingAction('share')
    try {
      const url = new URL(outputFileUrl(source, item.name), window.location.href).href
      await shareMediaFromDevice(url, baseName(item.name), outputMimeType(item.ext))
      setActionMenuOpen(false)
    } catch (err) {
      alert(`Paylaşılamadı: ${(err as Error).message}`)
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="popup-content" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="popup-close" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
        {onMetadata && (
          <button type="button" className="popup-metadata-button" onClick={onMetadata} aria-label="Metadata">
            📋 Metadata
          </button>
        )}
        {hasPrev && (
          <button type="button" className="popup-nav popup-nav-prev" onClick={onPrev} aria-label="Önceki">
            ‹
          </button>
        )}
        {hasNext && (
          <button type="button" className="popup-nav popup-nav-next" onClick={onNext} aria-label="Sonraki">
            ›
          </button>
        )}
        {loadError && <div className="fullscreen-error">Dosya yüklenemedi.</div>}
        {item.type === 'image' ? (
          <img
            src={outputFileUrl(source, item.name)}
            alt={item.name}
            className="popup-media"
            onError={() => setLoadError(true)}
            onContextMenu={onContextMenu}
          />
        ) : (
          // key={item.name} forces a fresh <video> element per item instead
          // of React reusing/patching the existing one — without it, video
          // playback (loop, autoplay-on-new-src) didn't reliably restart when
          // navigating straight from one video to another.
          <video
            key={item.name}
            src={outputFileUrl(source, item.name)}
            className="popup-media"
            controls
            autoPlay
            loop
            playsInline
            onError={() => setLoadError(true)}
            onContextMenu={onContextMenu}
          />
        )}
      </div>

      {actionMenuOpen && (
        // Stops propagation on the backdrop itself (not just the menu box) —
        // this whole thing is a sibling *inside* the main popup-overlay
        // above, so an un-stopped click here would bubble up to that
        // overlay's own onClick={onClose} and close the entire fullscreen
        // viewer instead of just this small menu.
        <div
          className="popup-overlay media-action-overlay"
          onClick={(e) => {
            e.stopPropagation()
            setActionMenuOpen(false)
          }}
        >
          <div className="media-action-menu" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="secondary-button" onClick={handleSave} disabled={!!pendingAction}>
              {pendingAction === 'save' ? 'Kaydediliyor…' : '💾 Kaydet'}
            </button>
            <button type="button" className="secondary-button" onClick={handleShare} disabled={!!pendingAction}>
              {pendingAction === 'share' ? 'Hazırlanıyor…' : '📤 Paylaş'}
            </button>
            <button type="button" className="secondary-button" onClick={() => setActionMenuOpen(false)} disabled={!!pendingAction}>
              Vazgeç
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
