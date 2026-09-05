import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// ComfyUI tarayıcıdan CORS izni olmadan çağrılamayabileceği için
// dev sunucusu /comfy-api ve /comfy-ws altında ComfyUI'ye reverse-proxy yapar.
// Telefon bu proxy'nin arkasındaki gerçek adresi hiç görmez, sadece PC'nin
// LAN IP'sine (bu dev sunucusuna) bağlanır.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const comfyTarget = env.VITE_COMFYUI_URL || 'http://192.168.1.65:8188'
  const outputServerTarget = `http://localhost:${env.OUTPUT_SERVER_PORT || 5175}`

  return {
    plugins: [react()],
    server: {
      host: true, // 0.0.0.0 üzerinde dinle, LAN'daki telefon erişebilsin
      port: 5173,
      proxy: {
        '/comfy-api': {
          target: comfyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/comfy-api/, ''),
        },
        '/comfy-ws': {
          target: comfyTarget,
          ws: true,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/comfy-ws/, '/ws'),
        },
        // Output Browser: served by the local server/index.js process (see README),
        // not by ComfyUI itself.
        '/api': {
          target: outputServerTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
