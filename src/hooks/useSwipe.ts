import { useRef } from 'react'

// Height of the native <video controls> bar — a horizontal drag that starts
// there is the user scrubbing the video, not asking for the next item.
const VIDEO_CONTROLS_PX = 56
// Minimum horizontal travel for a swipe; anything shorter is a tap.
const MIN_SWIPE_PX = 40

// Left/right swipe for the fullscreen viewers (Galeri, generation results,
// Civitai). Returns touch handlers to spread onto the element that should
// react — mostly-vertical drags are ignored so scrolling still works.
export function useSwipe(onSwipeLeft: () => void, onSwipeRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null)

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    const target = e.target as HTMLElement
    if (target instanceof HTMLVideoElement) {
      const rect = target.getBoundingClientRect()
      if (t.clientY > rect.bottom - VIDEO_CONTROLS_PX) {
        start.current = null
        return
      }
    }
    start.current = { x: t.clientX, y: t.clientY }
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (!start.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.current.x
    const dy = t.clientY - start.current.y
    start.current = null
    if (Math.abs(dx) < MIN_SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return
    if (dx < 0) onSwipeLeft()
    else onSwipeRight()
  }

  return { onTouchStart, onTouchEnd }
}
