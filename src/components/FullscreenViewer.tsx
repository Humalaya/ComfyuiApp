import { useEffect, useState } from 'react'
import { outputFileUrl, type OutputFile } from '../api/outputsClient'

interface Props {
  source: string
  item: OutputFile | null
  onClose: () => void
}

// Plain modal/popup overlay — deliberately does NOT call the browser
// Fullscreen API. Requesting fullscreen (on the video, or on a wrapping
// element) turned out to be an unreliable source of a stuck gray frame on
// some mobile browsers. A fixed, full-viewport-covering overlay already
// gives the media practically the whole screen without touching that API,
// and it's far more predictable across devices.
export function FullscreenViewer({ source, item, onClose }: Props) {
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setLoadError(false)
    if (!item) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [item, onClose])

  if (!item) return null

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="popup-content" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="popup-close" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
        {loadError && <div className="fullscreen-error">Dosya yüklenemedi.</div>}
        {item.type === 'image' ? (
          <img src={outputFileUrl(source, item.name)} alt={item.name} className="popup-media" onError={() => setLoadError(true)} />
        ) : (
          <video src={outputFileUrl(source, item.name)} className="popup-media" controls autoPlay playsInline onError={() => setLoadError(true)} />
        )}
      </div>
    </div>
  )
}
