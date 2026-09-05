// Minimal backend for the mobile control panel's Output Browser.
//
// This process is completely separate from ComfyUI itself — it only reads
// (never writes) files inside configured output folders so the phone can
// browse past generations. It never touches the ComfyUI installation, its
// workflow files, or its custom nodes. ComfyUI's own REST/WebSocket API is
// still called directly by the frontend via the Vite proxy (see
// vite.config.ts) — this server has nothing to do with /prompt, /history or
// the generation flow.
import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// Every browsable output folder is a named "source". Add more here (plus a
// matching env var) to browse additional tools' output directories — each
// one is fully isolated to its own root, same path-traversal guarantees.
const SOURCE_DEFS = [
  { id: 'comfyui', label: 'ComfyUI', envVar: 'COMFYUI_OUTPUT_DIR' },
  { id: 'forge', label: 'Forge', envVar: 'FORGE_OUTPUT_DIR' },
]
const SOURCES = SOURCE_DEFS.map((s) => {
  const dir = process.env[s.envVar]
  return { ...s, root: dir ? path.resolve(dir) : null }
})

const PORT = Number(process.env.OUTPUT_SERVER_PORT || 5175)

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXT = new Set(['.mp4', '.webm'])
const THUMBNAILABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

// ComfyUI's VHS_VideoCombine writes the "moov" atom (the index HTML5 <video>
// needs before it can start decoding) at the END of the mp4, not the front —
// fine for downloading, but many mobile browsers refuse to play it as a
// <video> src. We never touch the original file; instead we lazily remux
// (container-only, no re-encode: `-c copy -movflags +faststart`) a copy into
// this cache directory the first time it's requested, then serve that.
// NOTE: must not live under a dot-directory (e.g. ".cache") — Express's
// res.sendFile() defaults to dotfiles: 'ignore' and 404s any path that
// passes through a segment starting with ".", which silently broke this.
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'faststart')
const inFlightRemux = new Map()

// Caps how many ffmpeg remux processes run at once. Without this, a gallery
// with hundreds of outputs could fire off hundreds of concurrent ffmpeg
// processes the moment it's browsed, saturating the CPU and starving the one
// video the user actually tapped — which is exactly what happened before the
// Output Browser stopped eagerly loading every tile's video.
const MAX_CONCURRENT_REMUX = 2
let activeRemuxCount = 0
const remuxQueue = []

function runQueued(task) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      activeRemuxCount++
      task().then(
        (value) => {
          activeRemuxCount--
          drainRemuxQueue()
          resolve(value)
        },
        (err) => {
          activeRemuxCount--
          drainRemuxQueue()
          reject(err)
        },
      )
    }
    remuxQueue.push(attempt)
    drainRemuxQueue()
  })
}

function drainRemuxQueue() {
  while (activeRemuxCount < MAX_CONCURRENT_REMUX && remuxQueue.length > 0) {
    remuxQueue.shift()()
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function findSource(id) {
  const source = SOURCES.find((s) => s.id === id)
  if (!source) throw new HttpError(400, `Bilinmeyen kaynak: ${id}`)
  if (!source.root) throw new HttpError(503, `${source.label} klasörü yapılandırılmamış (.env: ${source.envVar}).`)
  return source
}

// Resolves a user-supplied relative path against a source's root and
// guarantees the result cannot land outside it — this is the one function
// standing between a phone on the LAN and the rest of the filesystem, so
// every input (absolute paths, "..", encoded separators) is neutralized
// before the containment check, and the containment check is what actually
// enforces it.
function resolveSafePath(root, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new HttpError(400, 'Dosya adı gerekli.')
  }
  const normalized = path.normalize(name).replace(/^([/\\])+/, '')
  const resolved = path.resolve(root, normalized)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new HttpError(400, 'Geçersiz dosya yolu.')
  }
  return resolved
}

// resolveSafePath only checks the requested path *string* — if a symlink
// sitting inside the output folder points outside of it, that check alone
// wouldn't catch it (the string still resolves under root; only the target
// it points to doesn't). This does the same containment check again against
// the fully resolved real path, so a planted symlink can't be used to read
// or stream a file from outside the configured folder.
async function resolveSafeRealPath(root, name) {
  const resolved = resolveSafePath(root, name)
  let real
  try {
    real = await fs.realpath(resolved)
  } catch {
    throw new HttpError(404, 'Dosya bulunamadı.')
  }
  const realRoot = await fs.realpath(root).catch(() => root)
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (real !== realRoot && !real.startsWith(rootWithSep)) {
    throw new HttpError(400, 'Geçersiz dosya yolu.')
  }
  return real
}

// The listing endpoint only ever returns image/video names, but /file and
// /download previously served *any* file under the root with no extension
// check at all — meaning a differently-typed file placed in the folder
// (e.g. .html/.svg) could be fetched and rendered same-origin with its
// native content-type. Both endpoints now enforce the same whitelist the
// listing already implies.
function assertBrowsableExt(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) {
    throw new HttpError(415, 'Desteklenmeyen dosya türü.')
  }
}

// Non-HttpError failures (fs.stat/readdir throwing, etc.) carry the absolute
// server-side path in err.message — fine to log, but not to hand back to
// whoever's on the LAN. Only our own controlled HttpError messages go to the client.
function sendError(res, err, fallbackMessage) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[output-server]', err)
  res.status(500).json({ error: fallbackMessage })
}

// Lists exactly one directory level — folders and media files, never
// recursing — so a source organized into subfolders (e.g. Forge's
// txt2img-images/<date>/) is browsed folder-by-folder instead of being
// flattened into one giant list. `relPath` (possibly '') is the path already
// navigated to, relative to the source root; returned names are always
// relative to the root too, so they plug straight into resolveSafePath.
async function listDirectory(root, relPath) {
  const dirPath = relPath ? resolveSafePath(root, relPath) : root
  const entries = await fs.readdir(dirPath, { withFileTypes: true })

  const folders = []
  const fileNames = []
  for (const entry of entries) {
    const rel = relPath ? `${relPath}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      folders.push(rel)
    } else {
      const ext = path.extname(entry.name).toLowerCase()
      if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) fileNames.push(rel)
    }
  }
  folders.sort((a, b) => b.localeCompare(a)) // date-like names sort newest-first as strings too

  const files = await Promise.all(
    fileNames.map(async (name) => {
      const ext = path.extname(name).toLowerCase()
      const stat = await fs.stat(path.join(root, name))
      return {
        name,
        type: IMAGE_EXT.has(ext) ? 'image' : 'video',
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }
    }),
  )
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  return { folders, files }
}

function ffmpegRemuxFaststart(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Name the temp file with a real .mp4 extension (not just a random
    // suffix) so ffmpeg can infer the muxer from it; -f mp4 pins it explicitly
    // either way.
    const tmpPath = path.join(path.dirname(outputPath), `.tmp-${process.pid}-${Date.now()}.mp4`)
    const proc = spawn('ffmpeg', ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmpPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d
    })
    proc.on('error', reject) // e.g. ffmpeg not installed
    proc.on('close', (code) => {
      if (code === 0) {
        fs.rename(tmpPath, outputPath).then(resolve, reject)
      } else {
        fs.rm(tmpPath, { force: true }).finally(() => reject(new Error(`ffmpeg remux exited ${code}: ${stderr.slice(-500)}`)))
      }
    })
  })
}

// Returns a path to a faststart-safe copy of a video, remuxing + caching on
// first request. Falls back to the original file if ffmpeg is unavailable or
// the remux fails, so playback degrades gracefully instead of erroring out.
async function ensurePlayablePath(filePath, mtimeMs) {
  const ext = path.extname(filePath).toLowerCase()
  // "+faststart" is an mp4/mov-muxer concept; .webm (Matroska) doesn't have
  // this failure mode, so there's nothing to remux there.
  if (ext !== '.mp4') return filePath

  const key = crypto.createHash('sha1').update(`${filePath}:${mtimeMs}`).digest('hex')
  const cachePath = path.join(CACHE_DIR, `${key}${ext}`)

  try {
    await fs.access(cachePath)
    return cachePath
  } catch {
    // not cached yet, fall through to remux below
  }

  if (!inFlightRemux.has(cachePath)) {
    const job = fs
      .mkdir(CACHE_DIR, { recursive: true })
      .then(() => runQueued(() => ffmpegRemuxFaststart(filePath, cachePath)))
      .catch((err) => {
        console.warn(`[output-server] faststart remux failed for ${filePath}, serving original: ${err.message}`)
      })
      .finally(() => inFlightRemux.delete(cachePath))
    inFlightRemux.set(cachePath, job)
  }
  await inFlightRemux.get(cachePath)

  try {
    await fs.access(cachePath)
    return cachePath
  } catch {
    return filePath // remux unavailable/failed — best effort, serve the original
  }
}

const app = express()

app.get('/api/outputs/sources', (_req, res) => {
  res.json(SOURCES.map(({ id, label, root }) => ({ id, label, configured: !!root })))
})

app.get('/api/outputs', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'comfyui')
    const relPath = typeof req.query.path === 'string' ? req.query.path : ''
    const listing = await listDirectory(source.root, relPath)
    res.json(listing)
  } catch (err) {
    sendError(res, err, 'Klasör listelenemedi.')
  }
})

app.get('/api/outputs/file', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'comfyui')
    const filePath = await resolveSafeRealPath(source.root, req.query.name)
    assertBrowsableExt(filePath)
    const stat = await fs.stat(filePath)
    const playablePath = await ensurePlayablePath(filePath, stat.mtimeMs)
    res.sendFile(playablePath) // Express/`send` handles Range requests for video seeking.
  } catch (err) {
    sendError(res, err, 'Dosya bulunamadı.')
  }
})

app.get('/api/outputs/download', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'comfyui')
    const filePath = await resolveSafeRealPath(source.root, req.query.name)
    assertBrowsableExt(filePath)
    res.download(filePath, path.basename(filePath))
  } catch (err) {
    sendError(res, err, 'Dosya bulunamadı.')
  }
})

app.get('/api/outputs/thumbnail', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'comfyui')
    const filePath = await resolveSafeRealPath(source.root, req.query.name)
    const ext = path.extname(filePath).toLowerCase()
    if (!THUMBNAILABLE_EXT.has(ext)) {
      throw new HttpError(415, 'Bu dosya türü için thumbnail üretilmiyor.')
    }
    res.set('Cache-Control', 'public, max-age=3600')
    res.type('image/jpeg')
    sharp(filePath)
      .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .on('error', () => res.status(500).end())
      .pipe(res)
  } catch (err) {
    sendError(res, err, 'Dosya bulunamadı.')
  }
})

app.listen(PORT, () => {
  const rootsDesc = SOURCES.map((s) => `${s.label}=${s.root ?? 'AYARLANMADI'}`).join(', ')
  console.log(`[output-server] http://localhost:${PORT} (${rootsDesc})`)
})
