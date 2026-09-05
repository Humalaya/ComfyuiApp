import { useEffect, useState } from 'react'
import { outputFileUrl, type OutputFile } from '../api/outputsClient'

interface Props {
  source: string
  item: OutputFile | null
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

// Plain modal/popup overlay — deliberately does NOT call the browser
// Fullscreen API. Requesting fullscreen (on the video, or on a wrapping
// element) turned out to be an unreliable source of a stuck gray frame on
// some mobile browsers. A fixed, full-viewport-covering overlay already
// gives the media practically the whole screen without touching that API,
// and it's far more predictable across devices.
export function FullscreenViewer({ source, item, hasPrev, hasNext, onPrev, onNext, onClose }: Props) {
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setLoadError(false)
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

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="popup-content" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="popup-close" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
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
          <img src={outputFileUrl(source, item.name)} alt={item.name} className="popup-media" onError={() => setLoadError(true)} />
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
          />
        )}
      </div>
    </div>
  )
}
