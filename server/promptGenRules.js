// The ✨ prompt generator's request shaping — what gets sent to the LLM for a
// tab, a length choice and the app's context line. Pure (no I/O), so the
// route in promptgen.js and offline prompt tests build exactly the same
// messages.

export const PROMPT_TARGETS = new Set(['sdxl', 'krea2', 'krea2edit', 'anime2real', 'video'])

// The app's Kısa / Orta / Uzun / Go nuts choice (promptGenPresets.ts). The
// tab's system text carries no length rule of its own: this line, appended
// to it, decides how long the answer is and how much the model may add
// beyond the request. 'nuts' has no limit at all (and no max_tokens).
export const PROMPT_LENGTHS = new Set(['short', 'medium', 'long', 'nuts'])

const IMAGE_RULES = {
  sdxl: {
    short:
      'Length: short — only the essential tags for what the user asked, roughly 10 to 20 tags in total. Add nothing beyond the request.',
    medium:
      'Length: medium — roughly 20 to 35 tags in total: the request plus the few tags that make the scene coherent (expression, background, lighting, framing).',
    long: 'Length: long and detailed — roughly 40 to 70 tags in total: add supporting detail tags that fit the request (expression, pose details, clothing details, background elements, lighting, atmosphere). Appearance the user left open (hair, eyes, outfit) you may choose yourself — never for a named character, whose look comes from their tag.',
    nuts: 'Length: no limit — as rich and detailed as you find useful, adding every fitting detail tag, including appearance the user left open (never for a named character). Stop when the prompt is complete.',
  },
  krea2: {
    short: 'Length: short — roughly 30 to 60 words: the request with only its essential visual details.',
    medium: 'Length: medium — roughly 80 to 140 words.',
    long: 'Length: long and richly detailed — roughly 160 to 260 words: materials, textures, lighting, background and camera in depth. Appearance the user left open (hair, eyes, outfit) you may choose yourself.',
    nuts: 'Length: no limit — as long and detailed as you find useful, including appearance the user left open. Stop when the prompt is complete.',
  },
}

// Video detail scales with the clip: words per second of the effective
// duration the app sends in its context line ("duration: 5.17 seconds").
const VIDEO_WORDS_PER_SECOND = { short: [8, 12], medium: [16, 25], long: [26, 40] }
const VIDEO_MIN_WORDS = { short: 40, medium: 80, long: 140 }
const VIDEO_AUDIO_SENTENCES = {
  short: 'overall_soundscape 1 to 2 sentences, non_diegetic_music 1 sentence',
  medium: 'overall_soundscape 2 to 3 sentences, non_diegetic_music 1 to 2 sentences',
  long: 'overall_soundscape 3 to 4 sentences, non_diegetic_music 2 to 3 sentences',
}
const VIDEO_LENGTH_NAME = { short: 'short', medium: 'medium', long: 'long and richly detailed' }

function videoRule(length, context) {
  if (length === 'nuts')
    return 'Length: no limit — make every field as rich and detailed as you find useful. Stop when the prompt is complete.'
  const m = /duration:\s*([\d.]+)/i.exec(context || '')
  const seconds = m ? Number(m[1]) : 5
  const [lo, hi] = VIDEO_WORDS_PER_SECOND[length]
  const round10 = (n) => Math.max(10, Math.round(n / 10) * 10)
  const min = Math.max(VIDEO_MIN_WORDS[length], round10(lo * seconds))
  const max = Math.max(min + 20, round10(hi * seconds))
  return `Length: ${VIDEO_LENGTH_NAME[length]} — integrated_multimodal_description about ${min} to ${max} words for this ${seconds.toFixed(1)}-second video; ${VIDEO_AUDIO_SENTENCES[length]}.`
}

export function lengthRule(target, length, context) {
  if (target === 'video') return videoRule(length, context)
  return IMAGE_RULES[target]?.[length] ?? null
}

// Answer tokens for the dedicated prompt model; a thinking model gets
// THINKING_EXTRA on top (its reasoning counts against max_tokens).
const LENGTH_TOKENS = {
  short: { image: 400, video: 800 },
  medium: { image: 800, video: 1600 },
  long: { image: 1600, video: 3200 },
}
const DEFAULT_TOKENS = { image: 600, video: 1500 } // targets without a length choice
const THINKING_EXTRA = 5000

export function maxTokensFor(target, length, thinking) {
  const hasLength = target === 'video' || !!IMAGE_RULES[target]
  if (hasLength && length === 'nuts') return undefined
  const kind = target === 'video' ? 'video' : 'image'
  const base = (hasLength && LENGTH_TOKENS[length]?.[kind]) || DEFAULT_TOKENS[kind]
  return thinking ? base + THINKING_EXTRA : base
}

// Generous caps — only against a runaway request body, not a limit anyone
// writing a system text or a prompt would reach.
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// → { messages, length } or { error } for a bad request.
export function buildPromptGenMessages({ target, system, request, context, length, previous, feedback }) {
  if (!PROMPT_TARGETS.has(target)) return { error: 'Geçersiz sekme.' }
  const len = PROMPT_LENGTHS.has(length) ? length : 'medium'
  const sys = clip(system, 50000)
  const ask = clip(request, 20000)
  if (!sys || !ask) return { error: 'İstek boş.' }
  const ctx = clip(context, 1000)
  const rule = lengthRule(target, len, ctx)
  const messages = [
    { role: 'system', content: rule ? `${sys}\n\n${rule}` : sys },
    { role: 'user', content: ctx ? `${ask}\n\n(${ctx})` : ask },
  ]
  const prev = clip(previous, 100000)
  const fb = clip(feedback, 20000)
  if (prev && fb) {
    messages.push({ role: 'assistant', content: prev })
    messages.push({
      role: 'user',
      content: `Revise the prompt above: ${fb}\nKeep everything else that wasn't asked to change. Output only the full revised prompt.`,
    })
  }
  return { messages, length: len }
}
