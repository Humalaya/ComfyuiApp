import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  children: ReactNode
}

// A small "?" that opens the explanation in a card, instead of a hint line
// permanently under every control. Portaled to <body> so the sticky header
// and the tabs' display:none wrappers can't clip or hide the overlay.
export function HelpTip({ children }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="help-tip"
        aria-label="Açıklama"
        onClick={(e) => {
          // Often sits inside a <label> or a clickable row — don't let the
          // tap also activate that.
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div className="popup-overlay help-overlay" onClick={() => setOpen(false)}>
            <div className="help-card">{children}</div>
          </div>,
          document.body,
        )}
    </>
  )
}
