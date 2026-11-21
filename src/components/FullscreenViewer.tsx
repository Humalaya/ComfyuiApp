import { useEffect, useState } from 'react'
import { outputFileUrl, outputMimeType, type OutputFile } from '../api/outputsClient'
import { useSwipe } from '../hooks/useSwipe'
import { canSaveMediaNatively, copyMediaToClipboard, saveMediaToDevice, shareMediaFromDevice } from '../native/saveMedia'
import { useBackHandler } from '../native/backButton'
import { canUpscaleSource } from '../workflow/upscale'
import { UpscaleDialog } from './UpscaleDialog'

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
  // Moves the shown file to the PC's trash (after a confirmation here).
  onDelete?: () => Promise<void>
  // An upscaled copy was saved (🔍 Büyüt) — refresh the listing.
  onUpscaled?: () => void
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
export function FullscreenViewer({ source, item, hasPrev, hasNext, onPrev, onNext, onClose, onMetadata, onDelete, onUpscaled }: Props) {
  const [loadError, setLoadError] = useState(false)
  // Long-press ("uzun basma") menu — only relevant inside the native app.
  // Android's WebView (unlike the Chrome *browser app*) has no built-in
  // "save/share image" on long-press of its own, so this is what stands in
  // for it there (see saveMedia.ts/SaveMediaPlugin.java). A real mobile
  // browser tab already gets that for free from the browser itself, so this
  // never intercepts long-press there — doing so would only break the
  // browser's own working save behavior for no benefit.
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<'save' | 'copy' | 'share' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [upscaleOpen, setUpscaleOpen] = useState(false)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)

  // Per-file state resets only when the shown file changes — keyed by name,
  // not by the callbacks below: the parent passes fresh arrow functions on
  // every render, which used to close an open dialog at random.
  const itemName = item?.name ?? null
  useEffect(() => {
    setLoadError(false)
    setActionMenuOpen(false)
    setConfirmDelete(false)
    setDeleteError(null)
    setUpscaleOpen(false)
    setDims(null)
  }, [itemName, source])

  useEffect(() => {
    if (!item) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [item, onClose, onPrev, onNext])

  // Swipe left/right for next/previous — same gesture the generation-result
  // viewer already had; must run before the early return (hook order).
  const swipe = useSwipe(
    () => hasNext && onNext(),
    () => hasPrev && onPrev(),
  )
  useBackHandler(!!item, onClose)
  // Registered after the viewer's own handler, so back closes the long-press
  // menu first and only then the viewer.
  useBackHandler(actionMenuOpen, () => setActionMenuOpen(false))
  const canUpscale = !!onUpscaled && item?.type === 'image' && canUpscaleSource(source)

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

  // Images only (see the menu render below) — copies the picture itself
  // onto the clipboard so it can be pasted straight into WhatsApp, Gmail,
  // etc., instead of going through the share sheet for something this
  // quick. Videos keep "Paylaş" — pasting a video isn't a thing most apps
  // expect, unlike an image.
  async function handleCopy() {
    if (!item) return
    setPendingAction('copy')
    try {
      const url = new URL(outputFileUrl(source, item.name), window.location.href).href
      await copyMediaToClipboard(url, baseName(item.name))
      setActionMenuOpen(false)
    } catch (err) {
      alert(`Kopyalanamadı: ${(err as Error).message}`)
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
    <div role="dialog" aria-modal="true" className="popup-overlay" onClick={onClose}>
      <div className="popup-content" onClick={(e) => e.stopPropagation()} {...swipe}>
        <button type="button" className="popup-close" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
        {onMetadata && (
          <button type="button" className="popup-metadata-button" onClick={onMetadata} aria-label="Metadata">
            📋 Metadata
          </button>
        )}
        {onDelete && (
          <button type="button" className="popup-delete-button" onClick={() => setConfirmDelete(true)} aria-label="Sil">
            🗑
          </button>
        )}
        {canUpscale && (
          <button type="button" className="popup-upscale-button" onClick={() => setUpscaleOpen(true)} aria-label="Büyüt">
            🔍
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
            onLoad={(e) => setDims({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
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

      {upscaleOpen && onUpscaled && (
        <UpscaleDialog source={source} item={item} dims={dims} onClose={() => setUpscaleOpen(false)} onDone={onUpscaled} />
      )}

      {confirmDelete && onDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Silmeyi onayla"
          className="popup-overlay media-action-overlay"
          onClick={(e) => {
            e.stopPropagation()
            if (!deleting) setConfirmDelete(false)
          }}
        >
          <div className="media-action-menu" onClick={(e) => e.stopPropagation()}>
            <div className="delete-confirm-text">
              <b>{baseName(item.name)}</b> PC'nin çöp kutusuna taşınsın mı?
              <span className="field-hint">Çöp kutusundan geri yüklenebilir.</span>
            </div>
            {deleteError && <div className="field-error">{deleteError}</div>}
            <button
              type="button"
              className="generate-button generate-button-cancel"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true)
                setDeleteError(null)
                try {
                  await onDelete()
                  setConfirmDelete(false)
                } catch (err) {
                  setDeleteError((err as Error).message)
                } finally {
                  setDeleting(false)
                }
              }}
            >
              {deleting ? 'Taşınıyor…' : '🗑 Çöpe taşı'}
            </button>
            <button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Vazgeç
            </button>
          </div>
        </div>
      )}

      {actionMenuOpen && (
        // Stops propagation on the backdrop itself (not just the menu box) —
        // this whole thing is a sibling *inside* the main popup-overlay
        // above, so an un-stopped click here would bubble up to that
        // overlay's own onClick={onClose} and close the entire fullscreen
        // viewer instead of just this small menu.
        <div
          role="dialog"
          aria-modal="true"
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
            {item.type === 'image' ? (
              <button type="button" className="secondary-button" onClick={handleCopy} disabled={!!pendingAction}>
                {pendingAction === 'copy' ? 'Kopyalanıyor…' : '📋 Kopyala'}
              </button>
            ) : (
              <button type="button" className="secondary-button" onClick={handleShare} disabled={!!pendingAction}>
                {pendingAction === 'share' ? 'Hazırlanıyor…' : '📤 Paylaş'}
              </button>
            )}
            <button type="button" className="secondary-button" onClick={() => setActionMenuOpen(false)} disabled={!!pendingAction}>
              Vazgeç
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
