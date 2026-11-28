// Shared by every Create tab's LoraList instance (video/SDXL/Krea2) — "→
// Prompta Gönder" on a Civitai trigger-words result appends them to the
// current prompt rather than replacing it, since trigger words are meant to
// sit alongside whatever the user already typed, not overwrite it.
export function appendTriggerWords(prompt: string, words: string): string {
  const trimmedWords = words.trim().replace(/,\s*$/, '')
  if (!trimmedWords) return prompt
  // Already present (e.g. the button was pressed twice, or the words were
  // typed in by hand already) — don't pile on a duplicate. A single tag is
  // compared as a whole tag (so "sfv" isn't mistaken for already present
  // just because the prompt says "sfvi"); a multi-tag block as a substring.
  const alreadyThere = trimmedWords.includes(',') ? prompt.includes(trimmedWords) : hasPromptTag(prompt, trimmedWords)
  if (alreadyThere) return prompt
  // Strip a trailing comma first — prompts often end in one, and blindly
  // adding ", " after it produced ",, word".
  const trimmedPrompt = prompt.trim().replace(/,\s*$/, '')
  return trimmedPrompt ? `${trimmedPrompt}, ${trimmedWords}` : trimmedWords
}

// Single-tag helpers for the Danbooru tag cheat sheet (TagCheatSheet.tsx).
// Unlike appendTriggerWords' plain substring check, these compare whole
// comma-separated tags — "smile" must not count as already present just
// because the prompt contains "light smile". A tag is compared ignoring
// case, underscores vs spaces, and attention/weight wrapping, so
// "(Blue_Eyes:1.2)" and "blue eyes" are the same tag.
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^[([{]+/, '')
    .replace(/[)\]}]+$/, '')
    .replace(/:\s*[\d.]+$/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function hasPromptTag(prompt: string, tag: string): boolean {
  const target = normalizeTag(tag)
  return prompt.split(',').some((segment) => normalizeTag(segment) === target)
}

// Adds the tag if it isn't there yet, removes every occurrence of it if it
// is. Removal splits on commas and drops only the matching segments, so
// whatever else the user wrote (newlines, blank separator lines, weights on
// other tags) is left exactly as it was.
export function togglePromptTag(prompt: string, tag: string): string {
  if (!hasPromptTag(prompt, tag)) {
    // Not appendTriggerWords — its plain substring check would refuse to add
    // "smile" to a prompt that already says "light smile".
    const trimmedPrompt = prompt.trim().replace(/,\s*$/, '')
    return trimmedPrompt ? `${trimmedPrompt}, ${tag}` : tag
  }
  const target = normalizeTag(tag)
  return prompt
    .split(',')
    .filter((segment) => normalizeTag(segment) !== target)
    .join(',')
    .replace(/^\s*,?\s*/, '')
}

// Inserts a tag where the user last had the cursor in the prompt box,
// written as " tag," (the cheat sheet's format), and returns where the cursor
// should go next so consecutive taps line up one after another. A cursor
// in the middle of an existing tag is moved past that tag's comma first, so
// nothing gets split.
export function insertPromptTag(prompt: string, tag: string, cursor: number | null): { text: string; cursor: number } {
  let pos = cursor === null ? prompt.length : Math.max(0, Math.min(cursor, prompt.length))
  const prev = prompt.slice(0, pos).replace(/[ \t]+$/, '').slice(-1)
  if (prev && prev !== ',' && prev !== '\n') {
    const comma = prompt.indexOf(',', pos)
    pos = comma === -1 ? prompt.length : comma + 1
  }
  let before = prompt.slice(0, pos)
  const after = prompt.slice(pos)
  // Inserting after a last tag that has no comma yet ("…, portrait|").
  const last = before.replace(/\s+$/, '').slice(-1)
  if (last && last !== ',' && last !== '\n') before = before.replace(/\s+$/, '') + ','
  const lead = before === '' || /[ \n]$/.test(before) ? '' : ' '
  const piece = `${lead}${tag},`
  // Keep a space between the new comma and whatever tag follows it.
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  return { text: before + piece + trail + after, cursor: before.length + piece.length }
}

// Words of `before` that are gone from `after` and weren't named in the
// change request — shown under an edited prompt, so a detail the model
// dropped anyway doesn't go unnoticed. Tag prompts (SDXL) compare whole
// tags, prose compares words of 4+ letters.
export function droppedParts(before: string, after: string, request: string): string[] {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const afterText = ` ${norm(after)} `
  const asked = ` ${norm(request)} `
  const tagLike = (before.match(/,/g)?.length ?? 0) > before.split(/\s+/).length / 4
  const parts = tagLike ? before.split(/[,\n]+/) : before.split(/\s+/)
  const out = new Set<string>()
  for (const raw of parts) {
    const n = norm(raw)
    if (n.length < (tagLike ? 2 : 4)) continue
    if (afterText.includes(` ${n} `) || asked.includes(` ${n} `)) continue
    out.add(raw.trim().replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})]+$/gu, ''))
  }
  return [...out].filter(Boolean).slice(0, 20)
}
