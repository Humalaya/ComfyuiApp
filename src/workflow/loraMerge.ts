import type { LoraSlot } from './fieldMap'

// A LoRA to switch on in a tab's list ("LoRA gönder" from a Civitai post).
export interface LoraAdd {
  lora: string
  strength: number
}

// Adds LoRAs to a tab's fixed slot list without touching the rest: one that's
// already there is switched on at the given strength, a new one goes into the
// first empty slot. Returns the new list and how many didn't fit (no slot).
export function mergeLoras(slots: LoraSlot[], add: LoraAdd[]): { loras: LoraSlot[]; skipped: number } {
  const loras = slots.map((s) => ({ ...s }))
  let skipped = 0
  for (const a of add) {
    const existing = loras.find((s) => s.lora === a.lora)
    if (existing) {
      existing.on = true
      existing.strength = a.strength
      continue
    }
    const empty = loras.find((s) => !s.lora)
    if (empty) Object.assign(empty, { on: true, lora: a.lora, strength: a.strength })
    else skipped++
  }
  return { loras, skipped }
}
