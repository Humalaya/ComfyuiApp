import { useEffect, useState } from 'react'
import { matchCivitaiLoras, type CivitaiLoraMatch } from '../api/civitaiClient'
import { isLoraCompatible, loraDisplayName, useLoraFamilies, type LoraTab } from '../api/loraMeta'
import { useBackHandler } from '../native/backButton'
import type { ImportPayload } from './Gallery'

export interface PostLora {
  versionId: number
  name: string
  strength: number | null
  // Typed LORA / LoCon on Civitai. Other resources (the checkpoint, or a
  // LoRA Civitai files under a checkpoint-typed model) show up only when they
  // match a LoRA file on this PC.
  isLora: boolean
}

interface Props {
  loras: PostLora[]
  onSend: (payload: ImportPayload) => void
  onClose: () => void
}

// Where a matched LoRA can go — the tab's own LoRA family (loraMeta.ts).
const TARGETS: { kind: 'sdxl' | 'krea2' | 'video'; family: LoraTab; label: string }[] = [
  { kind: 'sdxl', family: 'sdxl', label: 'SDXL' },
  { kind: 'krea2', family: 'krea2', label: 'Krea2' },
  { kind: 'video', family: 'video', label: 'Video' },
]

function strengthOf(l: PostLora): number {
  const s = l.strength ?? 1
  return Number.isFinite(s) ? Math.min(2, Math.max(-2, s)) : 1
}

// Civitai viewer → "LoRA gönder": the post's LoRAs, which of them are on
// this PC (matched by Civitai version through the files' hashes), and a
// button per Create tab that can use them. Only LoRAs found here are sent —
// switched on in that tab's list at the post's strength; the tab's other
// LoRAs stay as they are.
export function CivitaiLoraSend({ loras, onSend, onClose }: Props) {
  useBackHandler(true, onClose)
  const families = useLoraFamilies()
  const [matches, setMatches] = useState<Record<number, CivitaiLoraMatch> | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Keyed by the version ids — the viewer rebuilds `loras` every render.
  const versionKey = loras.map((l) => l.versionId).join(',')
  useEffect(() => {
    let cancelled = false
    matchCivitaiLoras(versionKey.split(',').map(Number))
      .then((list) => !cancelled && setMatches(Object.fromEntries(list.map((m) => [m.versionId, m]))))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [versionKey])

  const found = matches
    ? loras.flatMap((l) => (matches[l.versionId]?.lora ? [{ post: l, local: matches[l.versionId].lora as string }] : []))
    : []

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="LoRA gönder"
      className="popup-overlay media-action-overlay"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="media-action-menu civitai-lora-send" onClick={(e) => e.stopPropagation()}>
        <div className="gallery-lock-title">LoRA gönder</div>
        {error && <div className="field-error">{error}</div>}
        {!matches && !error && (
          <div className="civitai-lora-send-wait">
            <span className="spinner spinner-small" /> LoRA'ların PC'de aranıyor…
          </div>
        )}
        <ul className="civitai-lora-send-list">
          {loras
            .filter((l) => l.isLora || matches?.[l.versionId]?.lora)
            .map((l) => {
              const m = matches?.[l.versionId]
              return (
                <li key={l.versionId} className={m && !m.lora ? 'civitai-lora-send-missing' : undefined}>
                  <span className="civitai-lora-send-name">
                    {l.name} <span className="civitai-resource-strength">×{strengthOf(l)}</span>
                  </span>
                  <span className="civitai-lora-send-status">
                    {!m
                      ? '…'
                      : m.match === 'exact'
                        ? `✓ ${loraDisplayName(m.lora!)}`
                        : m.match === 'model'
                          ? `≈ farklı sürüm: ${loraDisplayName(m.lora!)}`
                          : '✗ sende yok'}
                  </span>
                </li>
              )
            })}
        </ul>
        {matches && found.length === 0 && <div className="field-hint">Bu gönderideki LoRA'ların hiçbiri PC'de yok.</div>}
        {TARGETS.map((t) => {
          const usable = found.filter((f) => isLoraCompatible(f.local, t.family, families))
          if (usable.length === 0) return null
          return (
            <button
              key={t.kind}
              type="button"
              className="secondary-button"
              onClick={() =>
                onSend({
                  kind: t.kind,
                  settings: {},
                  addLoras: usable.map((f) => ({ lora: f.local, strength: strengthOf(f.post) })),
                } as ImportPayload)
              }
            >
              {t.label} sekmesine gönder · {usable.length}
            </button>
          )
        })}
        <button type="button" className="secondary-button" onClick={onClose}>
          Kapat
        </button>
      </div>
    </div>
  )
}
