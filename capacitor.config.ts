import type { CapacitorConfig } from '@capacitor/cli';

// This wraps the *live* Vite dev server (same one you already open in a
// mobile browser) in a native Android shell — it does not bundle a static
// build of its own. That means editing the React app and refreshing behaves
// exactly like today; there's no separate "app build" step to keep in sync,
// only the one-time APK build below.
//
// The PC's LAN address — and it works away from home too: the PC advertises
// exactly this address to the tailnet as a Tailscale subnet route
// (`tailscale up … --advertise-routes=192.168.1.62/32`, approved in the
// admin console), so with Tailscale on, the phone reaches it from anywhere;
// at home it works with Tailscale off as well. If the PC's LAN IP changes,
// update it here, in public/offline.html and in that route, and rebuild.
const DEV_SERVER_URL = 'http://192.168.1.62:5173';

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
