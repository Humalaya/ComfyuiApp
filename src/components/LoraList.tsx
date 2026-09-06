import { useState } from 'react'
import { NumberField } from './NumberField'
import { LoraPicker } from './LoraPicker'
import { loraThumbnailUrl } from '../api/comfyClient'
import type { LoraSlot } from '../workflow/fieldMap'

interface Props {
  loras: LoraSlot[]
  loraNames: string[]
  onChange: (index: number, slot: LoraSlot) => void
}

// Grid of visual cards (thumbnail + name + weight) instead of the earlier
// vertical list of rows — tapping a card's thumbnail toggles it on/off
// directly (no separate switch), the name button above it opens the
// searchable picker to change which LoRA occupies that slot, and the weight
// control sits below the thumbnail. Cards without a preview image still
// reserve the exact same thumbnail box size so the grid stays aligned.
//
// With up to 22 slots (Krea2), rendering the full grid open by default made
// every tab absurdly tall. Collapsed behind a single toggle — like the old
// "Gelişmiş Ayarlar" section — the summary line still shows how many are
// active so nothing gets hidden silently.
export function LoraList({ loras, loraNames, onChange }: Props) {
  const [open, setOpen] = useState(false)
  // Index of the card whose picker is currently open — only one at a time.
  const [pickerIndex, setPickerIndex] = useState<number | null>(null)
  // Slots whose thumbnail request didn't decode as an image (rgthree
  // responds 200 with a JSON body when there's no preview file, not a real
  // 404 — an <img> can't tell ahead of time, only onError catches it).
  const [failedThumbs, setFailedThumbs] = useState<Set<number>>(new Set())

  function markThumbFailed(index: number) {
    setFailedThumbs((s) => (s.has(index) ? s : new Set(s).add(index)))
  }

  const activeCount = loras.filter((l) => l.on && l.lora).length

  return (
    <div className="field">
      <button type="button" className="lora-list-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="lora-list-toggle-label">LoRA'lar</span>
        <span className="lora-list-toggle-summary">{activeCount > 0 ? `${activeCount} aktif` : 'kapalı'}</span>
        <span className={`lora-list-toggle-chevron ${open ? 'lora-list-toggle-chevron-open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="lora-grid">
          {loras.map((slot, i) => (
            <div key={i} className={`lora-card ${slot.on ? 'lora-card-on' : ''}`}>
              {loraNames.length > 0 ? (
                <button type="button" className="lora-select" onClick={() => setPickerIndex(i)}>
                  <span className="lora-select-label" title={slot.lora}>
                    {slot.lora || 'LoRA seç…'}
                  </span>
                </button>
              ) : (
                <span className="lora-name" title={slot.lora}>
                  {slot.lora}
                </span>
              )}

              <button
                type="button"
                className={`lora-thumb ${slot.on ? 'lora-thumb-on' : ''}`}
                onClick={() => slot.lora && onChange(i, { ...slot, on: !slot.on })}
                disabled={!slot.lora}
                aria-pressed={slot.on}
                aria-label={slot.on ? 'Kapat' : 'Aç'}
              >
                {slot.lora && !failedThumbs.has(i) && (
                  <img
                    src={loraThumbnailUrl(slot.lora)}
                    alt=""
                    className="lora-thumb-img"
                    loading="lazy"
                    onError={() => markThumbFailed(i)}
                  />
                )}
              </button>

              <div className="lora-weight-row">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={slot.strength}
                  disabled={!slot.on}
                  onChange={(e) => onChange(i, { ...slot, strength: Number(e.target.value) })}
                  className="lora-strength"
                />
                <NumberField
                  min={0}
                  max={2}
                  step={0.05}
                  value={slot.strength}
                  disabled={!slot.on}
                  onChange={(v) => onChange(i, { ...slot, strength: v })}
                  className="lora-strength-value"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {pickerIndex !== null && (
        <LoraPicker
          value={loras[pickerIndex].lora}
          options={loraNames}
          onSelect={(name) => {
            setFailedThumbs((s) => {
              if (!s.has(pickerIndex)) return s
              const next = new Set(s)
              next.delete(pickerIndex)
              return next
            })
            // Picking a real LoRA turns the slot on — clearing it back to
            // "— Seçili değil —" turns it back off, since an enabled slot
            // with nothing selected doesn't mean anything to buildWorkflow.
            onChange(pickerIndex, { ...loras[pickerIndex], lora: name, on: name !== '' })
          }}
          onClose={() => setPickerIndex(null)}
        />
      )}
    </div>
  )
}
