import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './keepAlive'

// Bridges to SaveMediaPlugin.java (android/app/src/main/java/...) — Android's
// WebView (unlike the Chrome *browser app*) has no built-in "save image" or
// "share image" on long-press, so Galeri's long-press menu (see
// FullscreenViewer.tsx) needs actual native code to make either one work.
interface SaveMediaOptions {
  url: string
  filename: string
  mimeType: string
}

interface SaveMediaPlugin {
  save(options: SaveMediaOptions): Promise<{ uri: string }>
  share(options: SaveMediaOptions): Promise<void>
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
