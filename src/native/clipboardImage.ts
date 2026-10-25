import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './keepAlive'

// Bridges to ClipboardImagePlugin.java — reads a picture off the phone's
// clipboard. In the app this has to go through native code: it's served over
// plain http, and browsers only allow clipboard image reads on https pages.
interface ClipboardImagePlugin {
  read(): Promise<{ data: string; mimeType: string }>
}

const ClipboardImage = registerPlugin<ClipboardImagePlugin>('ClipboardImage')

function base64ToBlob(data: string, mimeType: string): Blob {
  const bytes = atob(data)
  const buf = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i)
  return new Blob([buf], { type: mimeType })
}

export async function readClipboardImage(): Promise<Blob> {
  if (isNativeApp()) {
    const { data, mimeType } = await ClipboardImage.read()
    return base64ToBlob(data, mimeType)
  }
  // A desktop browser on an https/localhost page.
  if (navigator.clipboard?.read) {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) return item.getType(type)
    }
    throw new Error('Panoda görsel yok.')
  }
  throw new Error('Bu tarayıcı panodan görsel okumaya izin vermiyor — Ctrl+V ile yapıştır.')
}
