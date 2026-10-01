import { useEffect } from 'react'

export type UretView = 'image' | 'video' | 'civitai' | 'openwebui'

interface Props {
  open: boolean
  current: UretView
  onSelect: (view: UretView) => void
  onClose: () => void
}

const ITEMS: { id: UretView; label: string; icon: string }[] = [
  { id: 'image', label: 'Görsel', icon: '🖼️' },
  { id: 'video', label: 'Video', icon: '🎬' },
  { id: 'civitai', label: 'Civitai', icon: '🌐' },
  { id: 'openwebui', label: 'OpenWebUI', icon: '💬' },
]

// Left slide-in "çekmece" for switching between the views behind the
// "Üret" nav button. Kept always-mounted (visibility is CSS-only) so the
// open/close slide can animate; a backdrop tap or Escape closes it, picking
// an item closes it via onSelect -> App.goToUret.
export function UretDrawer({ open, current, onSelect, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div
      className={open ? 'drawer-overlay drawer-overlay-open' : 'drawer-overlay'}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()} role="menu" aria-label="Üret">
        <div className="drawer-title">Üret</div>
        {ITEMS.map((it) => (
          <button
            key={it.id}
            type="button"
            role="menuitemradio"
            aria-checked={current === it.id}
            className={current === it.id ? 'drawer-item drawer-item-active' : 'drawer-item'}
            onClick={() => onSelect(it.id)}
          >
            <span className="drawer-item-icon" aria-hidden="true">
              {it.icon}
            </span>
            {it.label}
          </button>
        ))}
      </div>
    </div>
  )
}
