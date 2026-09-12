import { useState, type ReactNode } from 'react'

interface Props {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}

// Generic collapsible wrapper — used for each tab's "Gelişmiş Ayarlar"
// (sampler/scheduler/denoise), which don't need to be visible by default but
// shouldn't cost a whole separate screen either. Closed by default so these
// rarely-touched controls don't push the common fields further down the page.
export function CollapsibleSection({ title, children, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="field">
      <button type="button" className="collapsible-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="collapsible-toggle-label">{title}</span>
        <span className={`collapsible-toggle-chevron ${open ? 'collapsible-toggle-chevron-open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <div className="collapsible-content">{children}</div>}
    </div>
  )
}
