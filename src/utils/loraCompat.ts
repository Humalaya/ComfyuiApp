// The LoRA list's "Uyum" score: how well the switched-on LoRAs fit the
// selected model and each other. A heuristic, not a measurement — it flags
// the things that reliably go wrong: a LoRA made for another base model
// (Pony on Illustrious, SDXL on Krea2), several bases mixed, and too much
// total weight.

// Base-model groups that matter for compatibility. Civitai's baseModel
// names ("Illustrious", "Pony", "SDXL 1.0", "Krea 2", "MiniMax H3"…) map
// onto these; anything else is its own group under its own name.
export type BaseGroup = 'illustrious' | 'pony' | 'sdxl' | 'sd1' | 'krea2' | 'video' | string

const GROUP_LABEL: Record<string, string> = {
  illustrious: 'Illustrious',
  pony: 'Pony',
  sdxl: 'SDXL',
  sd1: 'SD 1.5',
  krea2: 'Krea2',
  video: 'MiniMax H3',
}

export function groupLabel(g: BaseGroup): string {
  return GROUP_LABEL[g] ?? g
}

export function groupOfCivitaiBase(base: string | null | undefined): BaseGroup | null {
  if (!base) return null
  const b = base.toLowerCase()
  if (b.includes('illustrious') || b.includes('noobai')) return 'illustrious'
  if (b.includes('pony')) return 'pony'
  if (b.startsWith('sdxl')) return 'sdxl'
  if (b.startsWith('sd 1') || b.startsWith('sd 2')) return 'sd1'
  if (b.includes('krea')) return 'krea2'
  if (b.includes('minimax')) return 'video'
  if (b === 'other') return null
  return base
}

// A checkpoint name's group when Civitai doesn't know it (or hasn't
// answered yet): most SDXL checkpoints say which family they are.
export function groupOfCheckpointName(name: string): BaseGroup {
  const n = name.toLowerCase()
  if (n.includes('pony')) return 'pony'
  if (n.includes('illustrious') || n.includes('noob') || /(^|[/_-])wai/.test(n)) return 'illustrious'
  return 'sdxl'
}

// 1 = made for each other; in between = works, weaker or with side effects;
// 0 = doesn't work at all (different architecture).
function pairFit(a: BaseGroup, b: BaseGroup): number {
  if (a === b) return 1
  const pair = new Set([a, b])
  if (pair.has('sdxl') && (pair.has('illustrious') || pair.has('pony'))) return 0.75
  if (pair.has('illustrious') && pair.has('pony')) return 0.45
  return 0
}

export interface CompatLora {
  name: string // display name
  strength: number
  group: BaseGroup | null // null = unknown
}

export interface CompatResult {
  score: number // 0–100
  level: 'good' | 'warn' | 'bad'
  reasons: { kind: 'bad' | 'warn' | 'info'; text: string }[]
}

const STRENGTH_SOFT_LIMIT = 2.5 // total |weight| before it starts to cost
const SINGLE_STRENGTH_LIMIT = 1.5
const COUNT_SOFT_LIMIT = 6

export function loraCompat(loras: CompatLora[], model: BaseGroup | null): CompatResult {
  const reasons: CompatResult['reasons'] = []
  let score = 100

  for (const l of loras) {
    if (!l.group || !model) continue
    const fit = pairFit(l.group, model)
    if (fit === 0) {
      score -= 45
      reasons.push({ kind: 'bad', text: `${l.name}: ${groupLabel(l.group)} LoRA'sı — ${groupLabel(model)} modelinde çalışmaz.` })
    } else if (fit < 1) {
      score -= Math.round((1 - fit) * 40)
      reasons.push({
        kind: 'warn',
        text: `${l.name}: ${groupLabel(l.group)} LoRA'sı, model ${groupLabel(model)} — kısmen uyumlu, etkisi zayıf ya da yan etkili olabilir.`,
      })
    }
  }

  const groups = [...new Set(loras.map((l) => l.group).filter((g): g is BaseGroup => !!g))]
  if (groups.length > 1) {
    score -= 8 * (groups.length - 1)
    reasons.push({
      kind: 'warn',
      text: `LoRA'lar farklı tabanlardan (${groups.map(groupLabel).join(', ')}) — birbirleriyle de tam uyuşmazlar.`,
    })
  }

  const total = loras.reduce((sum, l) => sum + Math.abs(l.strength), 0)
  if (total > STRENGTH_SOFT_LIMIT) {
    score -= Math.min(25, Math.round((total - STRENGTH_SOFT_LIMIT) * 10))
    reasons.push({
      kind: 'warn',
      text: `Toplam güç ${total.toFixed(1)} — yüksek; LoRA'lar birbirini ezebilir, görüntü bozulabilir. Bazılarını 0.5–0.8'e indirmeyi dene.`,
    })
  }
  for (const l of loras) {
    if (Math.abs(l.strength) > SINGLE_STRENGTH_LIMIT) {
      score -= 8
      reasons.push({ kind: 'warn', text: `${l.name}: güç ×${l.strength} — çok yüksek, genelde 0.6–1.2 arası iyi çalışır.` })
    }
  }

  if (loras.length > COUNT_SOFT_LIMIT) {
    score -= 4 * (loras.length - COUNT_SOFT_LIMIT)
    reasons.push({ kind: 'warn', text: `${loras.length} LoRA açık — çok fazla; etkileri birbirine karışır.` })
  }

  const unknown = loras.filter((l) => !l.group).length
  if (unknown > 0) {
    reasons.push({ kind: 'info', text: `${unknown} LoRA'nın taban modeli bilinmiyor (Civitai'de bulunamadı) — puana katılmadı.` })
  }
  if (!model) reasons.push({ kind: 'info', text: "Modelin tabanı bilinmiyor — sadece LoRA'lar birbirine göre değerlendirildi." })

  score = Math.max(0, Math.min(100, score))
  if (reasons.every((r) => r.kind === 'info')) reasons.unshift({ kind: 'info', text: 'Sorun görünmüyor.' })
  return { score, level: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad', reasons }
}
