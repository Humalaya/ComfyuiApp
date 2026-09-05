// navigator.share is commonly gated behind a secure context (https or
// localhost) — same trap we already hit with crypto.randomUUID(). This app
// is served over plain http on a LAN IP, so it can be silently unavailable;
// canShare() lets callers hide the button entirely rather than offering
// something that will just silently do nothing.

export function canShare(): boolean {
  return typeof navigator.share === 'function'
}

export async function shareText(title: string, text: string): Promise<boolean> {
  if (!canShare()) return false
  try {
    await navigator.share({ title, text })
    return true
  } catch {
    return false // user cancelled or share failed — not an error to surface
  }
}
