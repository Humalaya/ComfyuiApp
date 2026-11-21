import { useId } from 'react'
import { HelpTip } from './HelpTip'
import { NumberField } from './NumberField'

interface Props {
  seed: number
  fixed: boolean
  onSeedChange: (seed: number) => void
  onFixedChange: (fixed: boolean) => void
}

export function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000_000)
}

// Seed input + reroll + "Sabit" toggle, shared by all three Create tabs.
export function SeedField({ seed, fixed, onSeedChange, onFixedChange }: Props) {
  // Used on all three Create tabs at once (all stay mounted) — a unique id each.
  const id = useId()
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Seed
        <HelpTip>
          <b>Sabit</b> açıkken her üretimde bu seed kullanılır. Kapalıyken her üretimde yeni bir rastgele seed seçilir. 🎲 hemen yeni bir
          seed çeker.
        </HelpTip>
      </label>
      <div className="seed-row">
        <NumberField id={id} value={seed} onChange={onSeedChange} />
        <button type="button" className="icon-button" onClick={() => onSeedChange(randomSeed())} aria-label="Rastgele seed">
          🎲
        </button>
        <button
          type="button"
          className={fixed ? 'toggle-pill toggle-pill-on' : 'toggle-pill'}
          aria-pressed={fixed}
          onClick={() => onFixedChange(!fixed)}
        >
          Sabit
        </button>
      </div>
    </div>
  )
}
