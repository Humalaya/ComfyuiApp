import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}

// A plain <input type="number"> bound directly to a numeric value fights
// clearing the field: deleting the last digit makes the input's own text
// empty, Number('') is 0, that 0 gets committed and re-rendered right back
// into the input, so the field never actually looks empty — it snaps back to
// "0" on every keystroke of a delete. This keeps its own text draft instead,
// only committing (and reflecting back) a real number once one exists.
export function NumberField({ value, onChange, min, max, step }: Props) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)

  // Only follow external value changes (randomize-seed button, PNG import,
  // switching to a different gallery item, ...) while the user isn't
  // actively typing in this field — otherwise this would fight the draft on
  // every keystroke, since our own onChange below also changes `value`.
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        setDraft(String(value)) // left empty or mid-typed ("1.") — snap back to what's actually committed
      }}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        if (text === '' || text === '-' || text.endsWith('.')) return // incomplete — wait for more input instead of committing NaN/0
        const n = Number(text)
        if (!Number.isNaN(n)) onChange(n)
      }}
    />
  )
}
