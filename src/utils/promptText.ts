// Shared by every Create tab's LoraList instance (video/SDXL/Krea2) — "→
// Prompta Gönder" on a Civitai trigger-words result appends them to the
// current prompt rather than replacing it, since trigger words are meant to
// sit alongside whatever the user already typed, not overwrite it.
export function appendTriggerWords(prompt: string, words: string): string {
  const trimmedWords = words.trim()
  if (!trimmedWords) return prompt
  // Already present (e.g. the button was pressed twice, or the words were
  // typed in by hand already) — don't pile on a duplicate.
  if (prompt.includes(trimmedWords)) return prompt
  const trimmedPrompt = prompt.trim()
  return trimmedPrompt ? `${trimmedPrompt}, ${trimmedWords}` : trimmedWords
}
