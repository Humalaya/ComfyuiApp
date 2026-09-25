import { useRef, useState } from 'react'
import { NumberField } from './NumberField'
import { LoraPicker } from './LoraPicker'
import { loraThumbnailUrl } from '../api/comfyClient'
import { fetchCivitaiLoraInfo, type CivitaiLoraInfo } from '../api/civitaiClient'
import type { LoraSlot } from '../workflow/fieldMap'

interface Props {
  loras: LoraSlot[]
  loraNames: string[]
  onChange: (index: number, slot: LoraSlot) => void
  // "→ Prompta Gönder" on a Civitai trigger-words result calls this with
  // those words (already joined, e.g. "trigger1, trigger2") — the caller
  // owns the actual prompt field, this component never reads or writes it
  // directly (LoraList is shared by three Create tabs with unrelated
  // settings shapes, each with its own prompt field).
  onSendToPrompt: (words: string) => void
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
export function LoraList({ loras, loraNames, onChange, onSendToPrompt }: Props) {
  const [open, setOpen] = useState(false)
  // Index of the card whose picker is currently open — only one at a time.
  const [pickerIndex, setPickerIndex] = useState<number | null>(null)
  // Slots whose thumbnail request didn't decode as an image (rgthree
  // responds 200 with a JSON body when there's no preview file, not a real
  // 404 — an <img> can't tell ahead of time, only onError catches it).
  const [failedThumbs, setFailedThumbs] = useState<Set<number>>(new Set())
  // Civitai lookup result per slot — 'loading' while in flight. Triggered
  // two ways: automatically the moment a slot's *local* thumbnail actually
  // fails (see markThumbFailed), or manually via each card's own "Civitai"
  // button — the automatic path alone turned out to essentially never fire
  // for loras that already have a local rgthree preview (most of them, in
  // practice), which meant there was no way at all to see a lora's trigger
  // words unless its local thumbnail happened to be missing. The button
  // fixes that: it works (and is worth pressing) regardless of whether the
  // thumbnail is already showing something.
  const [civitaiInfo, setCivitaiInfo] = useState<Record<number, CivitaiLoraInfo | 'loading'>>({})
  // Which indices have already been auto-requested — a ref (not derived from
  // civitaiInfo's keys) so a still-in-flight *automatic* request isn't fired
  // twice. The manual button ignores this and can always re-fetch.
  const requestedCivitai = useRef<Set<number>>(new Set())

  function fetchCivitai(index: number) {
    const loraName = loras[index]?.lora
    if (!loraName) return
    requestedCivitai.current.add(index)
    setCivitaiInfo((prev) => ({ ...prev, [index]: 'loading' }))
    fetchCivitaiLoraInfo(loraName).then((info) => setCivitaiInfo((prev) => ({ ...prev, [index]: info })))
  }

  function markThumbFailed(index: number) {
    setFailedThumbs((s) => (s.has(index) ? s : new Set(s).add(index)))
    if (requestedCivitai.current.has(index)) return
    fetchCivitai(index)
  }

  // A slot changing to a different lora invalidates whatever was cached for
  // its *previous* one — both the "local thumbnail failed" flag and any
  // Civitai result, so the new lora gets its own fresh attempt instead of
  // inheriting the old one's.
  function forgetCachedThumb(index: number) {
    setFailedThumbs((s) => {
      if (!s.has(index)) return s
      const next = new Set(s)
      next.delete(index)
      return next
    })
    requestedCivitai.current.delete(index)
    setCivitaiInfo((prev) => {
      if (!(index in prev)) return prev
      const next = { ...prev }
      delete next[index]
      return next
    })
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
          {loras.map((slot, i) => {
            const civitaiEntry = civitaiInfo[i]
            const civitaiLoading = civitaiEntry === 'loading'
            const civitai = civitaiEntry && civitaiEntry !== 'loading' ? civitaiEntry : undefined
            // Local rgthree preview first; only once *that* has failed (and
            // only then) does a Civitai image get shown, if one was found —
            // pressing the button below when a local preview already loaded
            // fine still fetches trigger words/model name, it just doesn't
            // replace a thumbnail that already works.
            const civitaiImage = failedThumbs.has(i) ? civitai?.imageUrl : null
            const triggerWordsText =
              civitai?.triggerWords && civitai.triggerWords.length > 0 ? civitai.triggerWords.join(', ') : null

            return (
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
                  {slot.lora &&
                    (!failedThumbs.has(i) ? (
                      <img
                        src={loraThumbnailUrl(slot.lora)}
                        alt=""
                        className="lora-thumb-img"
                        loading="lazy"
                        onError={() => markThumbFailed(i)}
                      />
                    ) : (
                      civitaiImage && (
                        <img
                          src={civitaiImage}
                          alt=""
                          className="lora-thumb-img"
                          loading="lazy"
                          // Civitai returned a URL but it didn't actually load
                          // (dead link, network hiccup) — fall back to the
                          // blank box rather than a broken-image icon.
                          onError={() => setCivitaiInfo((prev) => ({ ...prev, [i]: { ...civitai, imageUrl: null } as CivitaiLoraInfo }))}
                        />
                      )
                    ))}
                </button>

                {/* Explicit, always-available trigger — the automatic fetch
                    above only ever fires when the *local* thumbnail fails,
                    which turned out to essentially never happen for loras
                    that already have one (most of them). This is the only
                    way to see trigger words for those. */}
                {slot.lora && (
                  <button type="button" className="lora-civitai-button" onClick={() => fetchCivitai(i)} disabled={civitaiLoading}>
                    {civitaiLoading ? 'Getiriliyor…' : civitai ? '🔄 Civitai' : "🌐 Civitai'den Getir"}
                  </button>
                )}

                {civitai && !civitai.found && <div className="lora-trigger-words">Civitai'de bulunamadı.</div>}

                {triggerWordsText && (
                  <>
                    <div className="lora-trigger-words" title="Civitai tetik kelimeleri">
                      {triggerWordsText}
                    </div>
                    <button type="button" className="lora-trigger-send-button" onClick={() => onSendToPrompt(triggerWordsText)}>
                      → Prompta Gönder
                    </button>
                  </>
                )}

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
            )
          })}
        </div>
      )}

      {pickerIndex !== null && (
        <LoraPicker
          value={loras[pickerIndex].lora}
          options={loraNames}
          onSelect={(name) => {
            forgetCachedThumb(pickerIndex)
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
