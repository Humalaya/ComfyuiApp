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
function normalizeTag(tag: string): string {
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
