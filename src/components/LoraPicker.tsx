import { useMemo, useState } from 'react'
import { loraThumbnailUrl } from '../api/comfyClient'
import { HelpTip } from './HelpTip'
import { isLoraCompatible, loraDisplayName, loraFolder, type LoraFamily, type LoraTab } from '../api/loraMeta'
import { useBackHandler } from '../native/backButton'

interface Props {
  options: string[]
  tab: LoraTab
  families: Record<string, LoraFamily | null>
  // Already in this tab's list — shown ticked and not selectable again.
  alreadyAdded: string[]
  // How many empty slots the workflow still has — selection stops there.
  freeSlots: number
  onConfirm: (names: string[]) => void
  onClose: () => void
}

// Multi-select LoRA picker: a thumbnail grid, filtered by default to the
// LoRAs trained for this tab's model family (see loraMeta.ts), with folder
// chips and search. Tap to tick, "N LoRA ekle" to add them all at once —
// picking three LoRAs no longer means opening this three times.
export function LoraPicker({ options, tab, families, alreadyAdded, freeSlots, onConfirm, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('')
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  useBackHandler(true, onClose)

  const added = useMemo(() => new Set(alreadyAdded), [alreadyAdded])
  const pool = useMemo(
    () => (showIncompatible ? options : options.filter((o) => isLoraCompatible(o, tab, families))),
    [options, tab, families, showIncompatible],
  )
  const hiddenCount = options.length - pool.length

  const folders = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of pool) counts.set(loraFolder(o), (counts.get(loraFolder(o)) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [pool])

  const q = query.trim().toLowerCase()
  const visible = pool.filter((o) => (!folder || loraFolder(o) === folder) && (!q || o.toLowerCase().includes(q)))

  const full = selected.length >= freeSlots

  function toggle(name: string) {
    setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : s.length >= freeSlots ? s : [...s, name]))
  }

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="lora-picker" onClick={(e) => e.stopPropagation()}>
        <div className="lora-picker-header">
          <input
            type="search"
            className="lora-picker-search"
            placeholder="LoRA ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>

        {folders.length > 1 && (
          <div className="chip-row chip-row-flush">
            <button type="button" className={folder === '' ? 'chip chip-active' : 'chip'} onClick={() => setFolder('')}>
              Tümü {pool.length}
            </button>
            {folders.map(([f, n]) => (
              <button
                key={f}
                type="button"
                className={folder === f ? 'chip chip-active' : 'chip'}
                onClick={() => setFolder(folder === f ? '' : f)}
              >
                {f || '(kök)'} {n}
              </button>
            ))}
          </div>
        )}

        <div className="lora-picker-grid">
          {visible.length === 0 && <div className="empty-state">Eşleşme yok</div>}
          {visible.map((name) => {
            const isAdded = added.has(name)
            const isSelected = selected.includes(name)
            return (
              <button
                key={name}
                type="button"
                title={name}
                disabled={isAdded || (full && !isSelected)}
                className={['lora-tile', isSelected ? 'lora-tile-selected' : '', isAdded ? 'lora-tile-added' : ''].filter(Boolean).join(' ')}
                onClick={() => toggle(name)}
              >
                <span className="lora-tile-thumb">
                  <img
                    src={loraThumbnailUrl(name)}
                    alt=""
                    loading="lazy"
                    // rgthree answers 200 with a JSON body (not a 404) when a
                    // LoRA has no preview file — onError is the only signal.
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                  {(isSelected || isAdded) && <span className="lora-tile-check">{isAdded ? 'Ekli' : '✓'}</span>}
                </span>
                <span className="lora-tile-name">{loraDisplayName(name)}</span>
              </button>
            )
          })}
        </div>

        <div className="lora-picker-options">
          <button
            type="button"
            className={showIncompatible ? 'toggle-pill toggle-pill-on' : 'toggle-pill'}
            aria-pressed={showIncompatible}
            onClick={() => setShowIncompatible(!showIncompatible)}
          >
            Uyumsuzlar{hiddenCount > 0 ? ` · ${hiddenCount}` : ''}
          </button>
          <HelpTip>
            Bu sekmenin modeliyle uyumsuz LoRA'lar (ör. SDXL'de Krea2/video LoRA'ları) varsayılan olarak gizlenir; bu düğme onları da
            gösterir. Aynı anda en fazla boş slot sayısı ({freeSlots}) kadar LoRA seçilebilir.
          </HelpTip>
        </div>

        <div className="lora-picker-footer">
          <button type="button" className="generate-button" disabled={selected.length === 0} onClick={() => onConfirm(selected)}>
            {selected.length > 0 ? `${selected.length} LoRA ekle` : freeSlots === 0 ? 'Bütün slotlar dolu' : 'LoRA seç'}
          </button>
        </div>
      </div>
    </div>
  )
}
