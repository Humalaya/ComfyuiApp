import { Capacitor, registerPlugin } from '@capacitor/core'

// Bridges to KeepAlivePlugin.java / KeepAliveService.java (android/app/src/main/java/...)
// — a plain Android foreground service that exists purely so the OS treats
// this app as actively working instead of an idle background tab, which is
// what stops the WebView's JS/WebSocket from being frozen the moment the
// screen locks. There's nothing to bridge to on the web — the plugin only
// exists in the native Android build, so every call here is a no-op there.
interface KeepAliveStartOptions {
  // Lets the native service poll ComfyUI's /history directly and post the
  // result notification itself — the WebView's own JS polling silently
  // stops while the app is backgrounded (Chromium throttles/freezes a
  // hidden WebView's timers regardless of this foreground service keeping
  // the process alive), so without this the user never gets notified until
  // they reopen the app.
  comfyBaseUrl?: string
  promptId?: string
  videoNodeId?: string
}

interface KeepAlivePlugin {
  start(options?: KeepAliveStartOptions): Promise<void>
  stop(): Promise<void>
}

const KeepAlive = registerPlugin<KeepAlivePlugin>('KeepAlive')

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

export async function startKeepAlive(options?: KeepAliveStartOptions): Promise<void> {
  if (!isNativeApp()) return
  try {
    await KeepAlive.start(options)
  } catch {
    // Best-effort: a plugin/permission failure shouldn't block generation,
    // it just means the app may get suspended on lock like a browser tab would.
  }
}

export async function stopKeepAlive(): Promise<void> {
  if (!isNativeApp()) return
  try {
    await KeepAlive.stop()
  } catch {
    // ignore
  }
}
