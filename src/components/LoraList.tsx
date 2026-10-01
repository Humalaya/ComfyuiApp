import { useState } from 'react'
import { NumberField } from './NumberField'
import { LoraPicker } from './LoraPicker'
import { loraThumbnailUrl } from '../api/comfyClient'
import { fetchCivitaiLoraInfo, type CivitaiLoraInfo } from '../api/civitaiClient'
import { loraDisplayName, loraFolder, useLoraFamilies, type LoraTab } from '../api/loraMeta'
import type { LoraSlot } from '../workflow/fieldMap'

interface Props {
  loras: LoraSlot[]
  loraNames: string[]
  // Which Create tab this list is on — decides which LoRAs the picker offers
  // by default (see loraMeta.ts).
  tab: LoraTab
  onChange: (index: number, slot: LoraSlot) => void
  // "→ Prompta Gönder" on a Civitai trigger-words result calls this with
  // those words (already joined, e.g. "trigger1, trigger2") — the caller
  // owns the actual prompt field, this component never reads or writes it
  // directly (LoraList is shared by three Create tabs with unrelated
  // settings shapes, each with its own prompt field).
  onSendToPrompt: (words: string) => void
}

const EMPTY_SLOT: LoraSlot = { on: false, lora: '', strength: 1 }

function formatStrength(n: number): string {
  return String(Math.round(n * 100) / 100)
}

// The workflow's LoRA loader has a fixed number of slots (10, or 22 on
// Krea2), but that's an implementation detail of the ComfyUI graph — this
// only ever shows the slots that actually hold a LoRA, one compact row each
// (enabled ones first, disabled ones after and dimmed). "＋ LoRA ekle" opens
// a multi-select picker and drops each pick into the next empty slot;
// "Kaldır" empties a slot again. Weight, Civitai trigger words and removal
// live in a row's detail panel, opened by tapping the row — the on/off
// switch is the only thing a stray tap while scrolling can change.
export function LoraList({ loras, loraNames, tab, onChange, onSendToPrompt }: Props) {
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  // Local rgthree preview that turned out not to exist (rgthree answers 200
  // with a JSON body, so only <img onError> can tell) — keyed by LoRA name.
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set())
  // Civitai lookup per LoRA name ('loading' while in flight). Fetched
  // automatically the first time a row's detail panel is opened — the server
  // caches results on disk, so reopening is instant.
  const [civitai, setCivitai] = useState<Record<string, CivitaiLoraInfo | 'loading'>>({})

  const used = loras
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot.lora)
    .sort((a, b) => Number(b.slot.on) - Number(a.slot.on) || a.index - b.index)
  const onCount = used.filter(({ slot }) => slot.on).length
  const freeSlots = loras.length - used.length

  const families = useLoraFamilies()

  function loadCivitai(name: string, force = false) {
    if (!force && civitai[name]) return
    setCivitai((c) => ({ ...c, [name]: 'loading' }))
    fetchCivitaiLoraInfo(name).then((info) => setCivitai((c) => ({ ...c, [name]: info })))
  }

  function toggleExpanded(index: number) {
    const next = expanded === index ? null : index
    setExpanded(next)
    if (next !== null) loadCivitai(loras[next].lora)
  }

  function addLoras(names: string[]) {
    const empty = loras.map((slot, index) => (slot.lora ? -1 : index)).filter((i) => i !== -1)
    names.slice(0, empty.length).forEach((name, i) => onChange(empty[i], { on: true, lora: name, strength: 1 }))
    setPickerOpen(false)
    setOpen(true)
  }

  function remove(index: number) {
    onChange(index, EMPTY_SLOT)
    setExpanded(null)
  }

  const summary =
    used.length === 0
      ? 'yok'
      : used
          .filter(({ slot }) => slot.on)
          .map(({ slot }) => loraDisplayName(slot.lora))
          .join(', ') || `${used.length} kapalı`

  return (
    <div className="field">
      <button type="button" className="lora-list-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="lora-list-toggle-label">LoRA'lar</span>
        <span className="lora-list-toggle-count">{onCount > 0 ? `${onCount} açık` : ''}</span>
        <span className="lora-list-toggle-summary">{summary}</span>
        <span className={`lora-list-toggle-chevron ${open ? 'lora-list-toggle-chevron-open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="lora-rows">
          {used.map(({ slot, index }) => {
            const name = slot.lora
            const info = civitai[name]
            const civ = info && info !== 'loading' ? info : undefined
            const thumbFailed = failedThumbs.has(name)
            const thumbSrc = thumbFailed ? civ?.imageUrl : loraThumbnailUrl(name)
            const triggerWords = civ?.triggerWords?.filter((w) => w.trim()) ?? []
            const isOpen = expanded === index

            return (
              <div key={index} className={`lora-row ${slot.on ? '' : 'lora-row-off'} ${isOpen ? 'lora-row-open' : ''}`}>
                <div className="lora-row-head">
                  <button type="button" className="lora-row-body" onClick={() => toggleExpanded(index)} aria-expanded={isOpen}>
                    <span className="lora-row-thumb">
                      {thumbSrc && (
                        <img
                          src={thumbSrc}
                          alt=""
                          loading="lazy"
                          onError={() => {
                            if (!thumbFailed) setFailedThumbs((s) => new Set(s).add(name))
                          }}
                        />
                      )}
                    </span>
                    <span className="lora-row-text">
                      <span className="lora-row-name">{loraDisplayName(name)}</span>
                      <span className="lora-row-folder">{loraFolder(name)}</span>
                    </span>
                    <span className="lora-row-strength">×{formatStrength(slot.strength)}</span>
                  </button>
                  <button
                    type="button"
                    className={slot.on ? 'switch switch-on' : 'switch'}
                    aria-pressed={slot.on}
                    aria-label={slot.on ? 'Kapat' : 'Aç'}
                    onClick={() => onChange(index, { ...slot, on: !slot.on })}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                {isOpen && (
                  <div className="lora-row-detail">
                    <div className="lora-row-fullname">{name}</div>
                    <div className="lora-weight-row">
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={slot.strength}
                        onChange={(e) => onChange(index, { ...slot, strength: Number(e.target.value) })}
                        className="lora-strength"
                      />
                      <NumberField
                        min={0}
                        max={2}
                        step={0.05}
                        value={slot.strength}
                        onChange={(v) => onChange(index, { ...slot, strength: v })}
                        className="lora-strength-value"
                      />
                    </div>

                    {info === 'loading' && <div className="lora-trigger-words">Civitai'den bilgi alınıyor…</div>}
                    {civ && !civ.found && <div className="lora-trigger-words">Civitai'de bulunamadı.</div>}
                    {/* One button per Civitai trigger-word entry — many LoRAs list
                        several variants (outfit A / outfit B / …), each its own
                        full tag list; sending them all at once just piled every
                        variant into the prompt. Tapping one sends only that one. */}
                    {triggerWords.length > 0 && (
                      <div className="lora-trigger-list">
                        <span className="lora-trigger-words">
                          {triggerWords.length > 1 ? `Tetik kelimeleri — ${triggerWords.length} varyant, dokunduğun prompta eklenir` : 'Tetik kelimesi — dokununca prompta eklenir'}
                        </span>
                        {triggerWords.map((words, i) => (
                          <button key={i} type="button" className="lora-trigger-item" onClick={() => onSendToPrompt(words)}>
                            <span className="lora-trigger-item-text">{words}</span>
                            <span className="lora-trigger-item-send">→</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {civ?.found && triggerWords.length === 0 && <div className="lora-trigger-words">Bu LoRA'nın tetik kelimesi yok.</div>}

                    <div className="lora-row-actions">
                      <button type="button" className="lora-civitai-button" onClick={() => loadCivitai(name, true)} disabled={info === 'loading'}>
                        🔄 Civitai'yi yenile
                      </button>
                      <button type="button" className="lora-remove-button" onClick={() => remove(index)}>
                        Kaldır
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {used.length === 0 && <div className="field-hint">Henüz LoRA eklenmedi.</div>}

          {loraNames.length > 0 && (
            <button type="button" className="lora-add-button" onClick={() => setPickerOpen(true)} disabled={freeSlots === 0}>
              ＋ LoRA ekle{freeSlots === 0 ? ' (bütün slotlar dolu)' : ''}
            </button>
          )}
        </div>
      )}

      {pickerOpen && (
        <LoraPicker
          options={loraNames}
          tab={tab}
          families={families}
          alreadyAdded={used.map(({ slot }) => slot.lora)}
          freeSlots={freeSlots}
          onConfirm={addLoras}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
