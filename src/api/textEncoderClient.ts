import { useEffect, useState } from 'react'

// Each image text encoder's architecture, read on the PC from the file
// header (server/textEncoders.js) — Krea2 needs Qwen3-VL-4B, Edit (Qwen)
// Qwen3-VL-8B; anything else loads but fails at sampling.
export type TextEncoderArch = string // 'qwen3vl_4b' | 'qwen3vl_8b' | 'qwen35_4b' | … | 'unknown'

const ARCH_LABEL: Record<string, string> = {
  qwen3vl_2b: 'Qwen3-VL 2B',
  qwen3vl_4b: 'Qwen3-VL 4B',
  qwen3vl_8b: 'Qwen3-VL 8B',
  qwen35_08b: 'Qwen3.5 0.8B',
  qwen35_2b: 'Qwen3.5 2B',
  qwen35_4b: 'Qwen3.5 4B',
  qwen35_9b: 'Qwen3.5 9B',
  qwen35_27b: 'Qwen3.5 27B',
}

export const archLabel = (arch: string | undefined) => (arch ? (ARCH_LABEL[arch] ?? 'bilinmeyen mimari') : '')

// name → arch; {} until loaded (or if the PC can't say). Refetched with
// the ComfyUI lists (`refreshKey`), so a newly added file shows up.
export function useTextEncoderArchs(refreshKey: unknown): Record<string, TextEncoderArch> {
  const [archs, setArchs] = useState<Record<string, TextEncoderArch>>({})
  useEffect(() => {
    let cancelled = false
    fetch('/api/text-encoders')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { name: string; arch: string }[]) => {
        if (!cancelled) setArchs(Object.fromEntries(list.map((e) => [e.name, e.arch])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshKey])
  return archs
}
