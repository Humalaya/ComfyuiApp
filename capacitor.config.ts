import type { CapacitorConfig } from '@capacitor/cli';

// This wraps the *live* Vite dev server (same one you already open in a
// mobile browser) in a native Android shell — it does not bundle a static
// build of its own. That means editing the React app and refreshing behaves
// exactly like today; there's no separate "app build" step to keep in sync,
// only the one-time APK build below. If your PC's LAN IP changes, update it
// here and rebuild the APK.
const DEV_SERVER_URL = 'http://192.168.1.62:5173';

const config: CapacitorConfig = {
  appId: 'com.emir.minimaxcontrol',
  appName: 'MiniMax Kontrol',
  webDir: 'dist',
  server: {
    url: DEV_SERVER_URL,
    cleartext: true, // plain http, not https — required or Android blocks the request
  },
};

export default config;
