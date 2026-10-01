import { useEffect } from 'react'
import { useSwipe } from '../hooks/useSwipe'

export interface ViewerItem {
  url: string
  kind: 'image' | 'video'
}

interface Props {
  items: ViewerItem[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}

// Reuses Gallery's popup-* overlay styling (see FullscreenViewer.tsx) but
// works over a plain url/kind list instead of Gallery's OutputFile/source —
// generation results live at ComfyUI /view urls, not the output-server's own
// scheme, so the two aren't naturally the same shape. Opening this never
// touches the generation hooks — it's a pure display layer sitting on top of
// whatever's already in `items`, so a job already running keeps running
// underneath exactly as it would with the viewer closed.
export function GenerationFullscreenViewer({ items, index, onIndexChange, onClose }: Props) {
  const item = items[index] ?? null
  const hasPrev = index > 0
  const hasNext = index < items.length - 1
  const swipe = useSwipe(
    () => hasNext && onIndexChange(index + 1),
    () => hasPrev && onIndexChange(index - 1),
  )

  useEffect(() => {
    if (!item) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1)
      else if (e.key === 'ArrowRight' && hasNext) onIndexChange(index + 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [item, index, hasPrev, hasNext, onClose, onIndexChange])

  if (!item) return null

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="popup-content" onClick={(e) => e.stopPropagation()} {...swipe}>
        <button type="button" className="popup-close" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
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
        {item.kind === 'image' ? (
          <img key={item.url} src={item.url} alt="Üretim sonucu" className="popup-media" />
        ) : (
          // muted: this can be opened right after a generation that finished
          // while the phone was backgrounded/locked — autoplaying WITH sound
          // the instant the viewer opens would mean audio blasting out
          // unexpectedly, same reasoning as ResultCarousel/StatusPanel.
          <video key={item.url} src={item.url} className="popup-media" controls autoPlay muted loop playsInline />
        )}
      </div>
    </div>
  )
}
