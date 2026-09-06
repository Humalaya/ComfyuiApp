import { useState } from 'react'
import { loraThumbnailUrl } from '../api/comfyClient'

interface Props {
  value: string
  options: string[]
  onSelect: (name: string) => void
  onClose: () => void
}

// A searchable full-list picker instead of a plain <select> — with dozens of
// similarly-named .safetensors files, a native dropdown meant scrolling
// through a long, un-searchable, truncated list every single time. This
// opens as a popup (same overlay pattern as FullscreenViewer/MetadataModal)
// with a search box that filters as you type.
export function LoraPicker({ value, options, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const filtered = query.trim() ? options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase())) : options

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="lora-picker" onClick={(e) => e.stopPropagation()}>
        <div className="lora-picker-header">
          <input
            type="text"
            className="lora-picker-search"
            placeholder="LoRA ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>
        <div className="lora-picker-list">
          <button
            type="button"
            className={value === '' ? 'lora-picker-item lora-picker-item-active' : 'lora-picker-item'}
            onClick={() => {
              onSelect('')
              onClose()
            }}
          >
            — Seçili değil —
          </button>
          {filtered.length === 0 && <div className="empty-state">Eşleşme yok</div>}
          {filtered.map((name) => (
            <button
              key={name}
              type="button"
              className={name === value ? 'lora-picker-item lora-picker-item-active' : 'lora-picker-item'}
              onClick={() => {
                onSelect(name)
                onClose()
              }}
            >
              <span className="lora-picker-item-thumb">
                <img
                  src={loraThumbnailUrl(name)}
                  alt=""
                  loading="lazy"
                  // rgthree responds 200 with a JSON body (not a real 404)
                  // when there's no preview file — onError is the only way
                  // to notice that, and hiding (not removing) the <img>
                  // keeps the thumbnail box the same reserved size either way.
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden'
                  }}
                />
              </span>
              <span className="lora-picker-item-label">{name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
