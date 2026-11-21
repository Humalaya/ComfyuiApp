// Serves the phone app as a *built* bundle (dist/) instead of the live Vite
// dev server — the APK opens http://<pc>:5173, and that port is now this
// process (Vite dev moved to 5174). A half-written source file can no longer
// break the phone: what it loads only changes on `npm run deploy`, which
// type-checks and builds first, then swaps dist/ in one rename.
//
// The dev server used to proxy ComfyUI for the app (/comfy-api → its HTTP
// API, /comfy-ws → its websocket); the same is done here with plain node
// http/net — no proxy dependency.
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'

export const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

// Must run before any body-parsing middleware: the request body (a queued
// workflow's JSON, an image upload) is streamed through untouched.
export function comfyHttpProxy(comfyTarget) {
  const target = new URL(comfyTarget)
  return (req, res, next) => {
    if (!req.url.startsWith('/comfy-api/') && req.url !== '/comfy-api') return next()
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: req.url.replace(/^\/comfy-api/, '') || '/',
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: `ComfyUI'ye ulaşılamadı: ${err.code || err.message}` })
      else res.destroy()
    })
    req.pipe(upstream)
  }
}

// /comfy-ws → ComfyUI's /ws: the upgrade request is re-sent with the
// rewritten path and host, then the two sockets are piped together.
export function attachComfyWsProxy(server, comfyTarget) {
  const target = new URL(comfyTarget)
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/comfy-ws')) return socket.destroy()
    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${req.url.replace(/^\/comfy-ws/, '/ws')} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const close = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
  })
}

// The built app: hashed assets cached for good, index.html never (so a
// deploy is picked up on the next load), and any other GET falls back to
// index.html.
export function serveBuiltApp(app) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      setHeaders(res, file) {
        res.set('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    }),
  )
  app.get(/^\/(?!api\/|comfy-api\/|comfy-ws).*/, (_req, res) => {
    const index = path.join(DIST_DIR, 'index.html')
    if (!fs.existsSync(index)) {
      return res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send("Uygulama henüz derlenmemiş — PC'de: cd ~/Desktop/mobile-control && npm run deploy")
    }
    res.set('Cache-Control', 'no-cache')
    res.sendFile(index)
  })
}

// Changes on every deploy (index.html is rewritten with new asset hashes) —
// an open app polls it to offer "Güncelleme hazır".
export function appVersion() {
  try {
    const st = fs.statSync(path.join(DIST_DIR, 'index.html'))
    return String(Math.round(st.mtimeMs))
  } catch {
    return null
  }
}
