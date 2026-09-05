import type { LoraSlot } from '../workflow/fieldMap'

interface Props {
  loras: LoraSlot[]
  loraNames: string[]
  onChange: (index: number, slot: LoraSlot) => void
}

export function LoraList({ loras, loraNames, onChange }: Props) {
  return (
    <div className="field">
      <label className="field-label">LoRA'lar</label>
      <div className="lora-list">
        {loras.map((slot, i) => (
          <div key={i} className={`lora-row ${slot.on ? 'lora-row-on' : ''}`}>
            <button
              type="button"
              className={`switch ${slot.on ? 'switch-on' : ''}`}
              aria-pressed={slot.on}
              onClick={() => onChange(i, { ...slot, on: !slot.on })}
            >
              <span className="switch-knob" />
            </button>

            {loraNames.length > 0 ? (
              <select
                className="lora-select"
                value={slot.lora}
                onChange={(e) => onChange(i, { ...slot, lora: e.target.value })}
              >
                {!loraNames.includes(slot.lora) && <option value={slot.lora}>{slot.lora}</option>}
                {loraNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="lora-name" title={slot.lora}>
                {slot.lora}
              </span>
            )}

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
            <span className="lora-strength-value">{slot.strength.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
