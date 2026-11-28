// Mode markers from MiniMax's own prompt guides (huggingface.co/MiniMaxAI/
// MiniMax-H3/tree/main/docs), toggled from the video tab's prompt box.
//
// img2vid (base guide §2.1, "I2VA"): this exact line first, then a blank
// line. An older variant without "<Picture 1>" (this app's template default
// had it that way) is recognized too, so toggling off removes it.
export const IMG2VID_LINE = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
const IMG2VID_RE = /^\s*For the target video, at 0\.00 seconds into the target video,[^\n]*?is fully referenced\.[ \t]*\n*/

// ref2vid (ref guide §3): a task-type prefix at the start of the `summary:`
// field — "[reference generation]", optionally with "+ audio reference" etc.
export const REF2VID_TAG = '[reference generation]'
const REF2VID_RE = /\[reference generation[^\]\n]*\][ \t]*/

export function hasImg2Vid(prompt: string): boolean {
  return IMG2VID_RE.test(prompt)
}

export function hasRef2Vid(prompt: string): boolean {
  return REF2VID_RE.test(prompt)
}

function withoutImg2Vid(prompt: string): string {
  return prompt.replace(IMG2VID_RE, '')
}

function withoutRef2Vid(prompt: string): string {
  return prompt.replace(REF2VID_RE, '')
}

// The two modes exclude each other — turning one on drops the other.
export function toggleImg2Vid(prompt: string): string {
  if (hasImg2Vid(prompt)) return withoutImg2Vid(prompt)
  const rest = withoutRef2Vid(prompt).replace(/^\s+/, '')
  return rest ? `${IMG2VID_LINE}\n\n${rest}` : `${IMG2VID_LINE}\n\n`
}

export function toggleRef2Vid(prompt: string): string {
  if (hasRef2Vid(prompt)) return withoutRef2Vid(prompt)
  const rest = withoutImg2Vid(prompt)
  // Into the summary field if the prompt has one, else at the very start.
  const m = /summary:[ \t]*\n?/.exec(rest)
  if (m) return rest.slice(0, m.index + m[0].length) + `${REF2VID_TAG} ` + rest.slice(m.index + m[0].length)
  return `${REF2VID_TAG} ${rest.replace(/^\s+/, '')}`
}

// --- Keyframe alignment line for generated prompts (✨ prompt generator) ---
//
// MiniMax's base guide (§2.1) opens a keyframe prompt with an exact
// instruction line that depends on which frames are wired, the final shot's
// index and the duration to two decimals. The LLM is told not to write it
// (an exact sentence with computed numbers is what models get subtly
// wrong); this adds the official wording.
export type VideoTask = 'T2VA' | 'I2VA' | 'FL2VA' | 'L2VA'

export function videoTask(firstFrame: boolean, lastFrame: boolean): VideoTask {
  if (firstFrame && lastFrame) return 'FL2VA'
  if (firstFrame) return 'I2VA'
  if (lastFrame) return 'L2VA'
  return 'T2VA'
}

// Any alignment line at the start (ours or one the model wrote anyway).
const ALIGNMENT_RE =
  /^\s*(For the target video, at 0\.00 seconds into the target video,|How the reference pictures align with the target video)[^\n]*\n*/

// What the workflow really renders for a requested length (template.json
// node 131): max(5, round(s·24)) frames, rounded up onto MiniMax's 17k+5
// frame grid, at the model's native 24 fps — e.g. 5 s → 124 frames → 5.17 s.
// The alignment line's S.SS must be this effective duration.
export function effectiveVideoSeconds(seconds: number): number {
  const base = Math.max(5, Math.round(seconds * 24))
  const pad = (((5 - (base % 17)) % 17) + 17) % 17 // Python-style modulo, as in the expression
  return (base + pad) / 24
}

export function applyVideoAlignment(prompt: string, task: VideoTask, seconds: number): string {
  const body = prompt.replace(ALIGNMENT_RE, '').replace(/^\s+/, '')
  const shots = [...body.matchAll(/\[Shot (\d+)\]/g)].map((m) => Number(m[1]))
  const last = shots.length ? Math.max(...shots) : 1
  const s = effectiveVideoSeconds(seconds).toFixed(2)
  const line =
    task === 'I2VA'
      ? IMG2VID_LINE
      : task === 'FL2VA'
        ? `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${last}) aligns with the ${s}-second mark of the target video.`
        : task === 'L2VA'
          ? `How the reference pictures align with the target video — <Picture 1> (from [Shot ${last}]) aligns with the ${s}-second mark of the target video.`
          : null
  return line ? `${line}\n\n${body}` : body
}
