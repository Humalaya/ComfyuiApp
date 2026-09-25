import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './keepAlive'

// Bridges to SaveMediaPlugin.java (android/app/src/main/java/...) — Android's
// WebView (unlike the Chrome *browser app*) has no built-in "save image",
// "share image" or "copy image" on long-press, so Galeri's long-press menu
// (see FullscreenViewer.tsx) needs actual native code to make any of them
// work.
interface SaveMediaOptions {
  url: string
  filename: string
  mimeType: string
}

interface CopyMediaOptions {
  url: string
  filename: string
}

interface SaveMediaPlugin {
  save(options: SaveMediaOptions): Promise<{ uri: string }>
  share(options: SaveMediaOptions): Promise<void>
  // No mimeType — the clipboard entry is a content:// URI, so whatever reads
  // it back resolves the type from the file itself via the ContentResolver.
  copy(options: CopyMediaOptions): Promise<void>
}

const SaveMedia = registerPlugin<SaveMediaPlugin>('SaveMedia')

// Only meaningful inside the native app — a normal mobile browser tab
// already gets long-press-to-save for free from the browser itself, and
// there's no plugin to bridge to there anyway.
export function canSaveMediaNatively(): boolean {
  return isNativeApp()
}

export async function saveMediaToDevice(url: string, filename: string, mimeType: string): Promise<void> {
  await SaveMedia.save({ url, filename, mimeType })
}

export async function shareMediaFromDevice(url: string, filename: string, mimeType: string): Promise<void> {
  await SaveMedia.share({ url, filename, mimeType })
}

// Copies the actual picture onto the system clipboard (as a content:// URI,
// not just its filename/URL as text) — pasting into WhatsApp, Gmail, etc.
// then drops in the real image, same as copying a photo out of the system
// Gallery app would.
export async function copyMediaToClipboard(url: string, filename: string): Promise<void> {
  await SaveMedia.copy({ url, filename })
}
