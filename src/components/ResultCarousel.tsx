import { useRef, useState } from 'react'

interface Props {
  urls: string[]
  kind: 'image' | 'video'
  // Tapping a thumbnail (compact mode) or the big media area (normal mode)
  // calls this with that item's url instead of doing nothing — the caller
  // opens a GenerationFullscreenViewer at that url (see App.tsx/
  // ImageGenerateTab.tsx/Krea2GenerateTab.tsx). Optional so ResultCarousel
  // stays usable standalone.
  onOpen?: (url: string) => void
  // No big preview, just the small thumbnail strip — every tap opens
  // GenerationFullscreenViewer directly instead of promoting a thumbnail to
  // a (nonexistent) big slot. Used in the running/queued status panel, which
  // has no room for a full-size preview since the live progress/preview
  // already occupies that space; the "✓ Üretim Tamamlandı" card uses the
  // normal (non-compact) mode instead, which still has that room.
  compact?: boolean
}

// Shows every file across the whole session's history (not just the current
// job's own batch) as a thumbnail strip — a batch job (Batch Size > 1) saves
// several files, and previous jobs' files are just as reachable, all in one
// place instead of only ever showing the single most recent file. In normal
// mode the selected file is also shown large above the strip (tap it, or
// swipe left/right, to switch which is selected); in compact mode there's no
// large slot, so a tap opens the fullscreen viewer immediately instead.
//
// Selection intentionally resets to the first item whenever a *new* batch
// replaces this one, not just when the index goes stale — callers do this by
// passing `key={result.promptId}` (see StatusPanel.tsx/ImageGenerateTab.tsx/
// Krea2GenerateTab.tsx) on the non-compact usage, which remounts this
// component fresh instead of needing an effect to notice the urls prop
// changed. Compact mode has no selection state to reset in the first place.
export function ResultCarousel({ urls, kind, onOpen, compact = false }: Props) {
  const [index, setIndex] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)

  if (urls.length === 0) return null

  if (compact) {
    return (
      <div className="result-carousel-strip result-carousel-strip-compact">
        {urls.map((u) => (
          <button
            type="button"
            key={u}
            className="result-carousel-thumb result-carousel-thumb-compact"
            onClick={() => onOpen?.(u)}
            aria-label="Büyüt"
          >
            {kind === 'video' ? (
              <video src={u} className="result-carousel-thumb-media" muted preload="metadata" />
            ) : (
              <img src={u} alt="" className="result-carousel-thumb-media" loading="lazy" />
            )}
          </button>
        ))}
      </div>
    )
  }

  const safeIndex = Math.min(index, urls.length - 1)
  const current = urls[safeIndex]

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
      onOpen?.(current)
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
        onClick={() => onOpen?.(current)}
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
