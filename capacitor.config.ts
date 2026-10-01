import type { CapacitorConfig } from '@capacitor/cli';

// This wraps the *live* Vite dev server (same one you already open in a
// mobile browser) in a native Android shell — it does not bundle a static
// build of its own. That means editing the React app and refreshing behaves
// exactly like today; there's no separate "app build" step to keep in sync,
// only the one-time APK build below.
//
// The PC's Tailscale address, not its LAN one: the same app then works at
// home and away (Tailscale must be on on the phone). At home Tailscale
// still connects directly over the LAN, so nothing is slower. If the PC's
// Tailscale IP changes (`tailscale ip -4`), update it here, in
// public/offline.html, and rebuild the APK.
const DEV_SERVER_URL = 'http://100.78.9.7:5173';

const config: CapacitorConfig = {
  appId: 'com.emir.minimaxcontrol',
  appName: 'MiniMax Kontrol',
  webDir: 'dist',
  server: {
    url: DEV_SERVER_URL,
    cleartext: true, // plain http, not https — required or Android blocks the request
    // Bundled page (public/offline.html) shown when the PC can't be reached
    // — asleep or off. It can wake the PC over Wake-on-LAN.
    errorPath: 'offline.html',
  },
  android: {
    // offline.html is served from Capacitor's own https://localhost origin
    // and has to probe the PC over plain http to notice it woke up — the
    // WebView blocks that as mixed content unless allowed.
    allowMixedContent: true,
  },
};

export default config;
