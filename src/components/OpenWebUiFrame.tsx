import { useMemo } from 'react'

// OpenWebUI runs on this same PC on port 3000 (binds 0.0.0.0). The host is
// taken from wherever the panel itself was loaded from — the LAN IP at home,
// the Tailscale IP when away — so one build embeds it correctly in both
// places with no config. OpenWebUI sends no X-Frame-Options / frame-ancestors
// so it embeds fine; if the panel is ever served over HTTPS this would hit
// mixed-content blocking (OpenWebUI here is plain http), hence the explicit
// "open in a browser tab" escape hatch.
const OPENWEBUI_PORT = 3000

export function OpenWebUiFrame() {
  const src = useMemo(() => {
    const { protocol, hostname } = window.location
    return `${protocol}//${hostname}:${OPENWEBUI_PORT}/`
  }, [])

  return (
    <div className="owui-wrap">
      <iframe className="owui-frame" src={src} title="OpenWebUI" allow="clipboard-write; microphone" />
      <a className="owui-external" href={src} target="_blank" rel="noreferrer">
        Tarayıcıda aç ↗
      </a>
    </div>
  )
}
