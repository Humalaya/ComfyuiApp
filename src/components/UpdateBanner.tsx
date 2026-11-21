import { useEffect, useRef, useState } from 'react'

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/app-version', { cache: 'no-store' })
    return ((await res.json()) as { version: string | null }).version
  } catch {
    return null
  }
}

// The phone runs the built app (server/webapp.js); after `npm run deploy` it
// keeps running the old one until reloaded. This notices a new build — when
// the app comes back to the foreground, and once a minute — and offers the
// reload instead of doing it unasked (settings survive a reload, but an
// open pop-up or a half-typed field wouldn't).
export function UpdateBanner() {
  const loaded = useRef<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!import.meta.env.PROD) return // the dev server reloads on its own
    let stopped = false
    async function check() {
      const v = await fetchVersion()
      if (stopped || !v) return
      if (loaded.current === null) loaded.current = v
      else if (v !== loaded.current) setReady(true)
    }
    check()
    const timer = window.setInterval(check, 60_000)
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!ready) return null
  return (
    <div className="update-banner" role="status">
      <span>Uygulamanın yeni sürümü hazır.</span>
      <button type="button" className="generate-button update-banner-button" onClick={() => window.location.reload()}>
        Yenile
      </button>
      <button type="button" className="icon-button" aria-label="Sonra" onClick={() => setReady(false)}>
        ✕
      </button>
    </div>
  )
}
