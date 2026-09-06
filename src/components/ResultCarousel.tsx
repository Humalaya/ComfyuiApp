import { useRef, useState } from 'react'

interface Props {
  urls: string[]
  kind: 'image' | 'video'
  // Tapping the big media area calls this with the tapped item's index
  // (within `urls`) instead of doing nothing — the caller opens a
  // GenerationFullscreenViewer at that position over its own, longer running
  // history list (see App.tsx/ImageGenerateTab.tsx/Krea2GenerateTab.tsx),
  // which is a superset of `urls` in the same order (this batch's own files
  // always sit at the front of that history the moment they're clickable).
  // Optional so ResultCarousel stays usable standalone.
  onOpen?: (index: number) => void
}

// A batch job (Batch Size > 1) saves several files, but only ever handing
// the first one to the caller silently threw the rest away from the app's
// UI — they were still safe on disk/in Galeri, just invisible right where
// the user is actually looking the moment a generation finishes. This shows
// the selected file large, with the rest as a thumbnail strip underneath
// (only rendered at all once there's more than one) — tap a thumbnail, or
// swipe left/right on the large one, to switch which is selected.
//
// Selection intentionally resets to the first item whenever a *new* batch
// replaces this one, not just when the index goes stale — callers do this by
// passing `key={result.promptId}` (see StatusPanel.tsx/ImageGenerateTab.tsx/
// Krea2GenerateTab.tsx), which remounts this component fresh instead of
// needing an effect to notice the urls prop changed.
export function ResultCarousel({ urls, kind, onOpen }: Props) {
  const [index, setIndex] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)

  const safeIndex = Math.min(index, Math.max(urls.length - 1, 0))
  const current = urls[safeIndex]
  if (!current) return null

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = e.changedTouches[0].clientY - (touchStartY.current ?? 0)
    touchStartX.current = null
    touchStartY.current = null

    // Barely moved at all — a tap, not a swipe or a scroll. preventDefault
    // stops the browser's own synthetic click that would otherwise follow
    // and call onOpen a second time.
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      e.preventDefault()
      onOpen?.(safeIndex)
      return
    }

    if (urls.length < 2) return
    // Requires a clearly horizontal, deliberate drag — otherwise a vertical
    // page scroll that merely started on top of the image would get
    // mistaken for a swipe.
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return
    setIndex((i) => Math.max(0, Math.min(urls.length - 1, dx < 0 ? i + 1 : i - 1)))
  }

  return (
    <div className="result-carousel">
      <div
        className={`result-carousel-main ${onOpen ? 'result-carousel-main-clickable' : ''}`}
        onClick={() => onOpen?.(safeIndex)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {kind === 'video' ? (
          // muted is required for autoPlay to be allowed unmuted-by-default
          // at all, but it matters even more here specifically: this can
          // mount while the app is backgrounded (a generation that finished
          // while the phone was locked/away, now recovered), so autoplaying
          // WITH sound would mean audio blasting out of a phone the user
          // isn't even looking at.
          <video key={current} className="result-video" src={current} controls autoPlay muted loop playsInline />
        ) : (
          <img key={current} src={current} alt="Üretim sonucu" className="result-video" />
        )}
      </div>

      {urls.length > 1 && (
        <div className="result-carousel-strip">
          {urls.map((u, i) => (
            <button
              type="button"
              key={u}
              className={`result-carousel-thumb ${i === safeIndex ? 'result-carousel-thumb-active' : ''}`}
              onClick={() => setIndex(i)}
              aria-label={`${i + 1}. sonucu göster`}
              aria-pressed={i === safeIndex}
            >
              {kind === 'video' ? (
                <video src={u} className="result-carousel-thumb-media" muted preload="metadata" />
              ) : (
                <img src={u} alt="" className="result-carousel-thumb-media" loading="lazy" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
