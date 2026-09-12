// Minimal backend for the mobile control panel's Output Browser (plus a
// small in-memory generation-state store, see the /api/state/* routes near
// the bottom).
//
// This process is completely separate from ComfyUI itself — it only reads
// (never writes) files inside configured output folders so the phone can
// browse past generations. It never touches the ComfyUI installation, its
// workflow files, or its custom nodes. ComfyUI's own REST/WebSocket API is
// still called directly by the frontend via the Vite proxy (see
// vite.config.ts) — this server has nothing to do with /prompt, /history or
// the generation flow *itself*; it only remembers what the phone last told
// it about the client-side queue/active-job bookkeeping around that flow.
import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// Every browsable output folder is a named "source". Add more here (plus a
// matching env var) to browse additional tools' output directories — each
// one is fully isolated to its own root, same path-traversal guarantees.
//
// One source per generation type (Video/Krea/SDXL) rather than one "ComfyUI"
// source rooted at the whole output/ folder — each root points straight at
// that type's own subfolder (see the corresponding filename_prefix in
// template.json/krea2Template.json/imageTemplate.json), so opening a tab
// lands directly on that type's own date folders instead of having to
// navigate into image/video/krea from a shared root first. Forge's own
// output folder isn't a distinct generation type of this app's, so it's not
// one of these — browsing it from here was never anything more than a
// leftover convenience from before this split existed.
const SOURCE_DEFS = [
  { id: 'video', label: 'Video', envVar: 'VIDEO_OUTPUT_DIR' },
  { id: 'krea', label: 'Krea', envVar: 'KREA_OUTPUT_DIR' },
  { id: 'sdxl', label: 'SDXL', envVar: 'SDXL_OUTPUT_DIR' },
]
const SOURCES = SOURCE_DEFS.map((s) => {
  const dir = process.env[s.envVar]
  return { ...s, root: dir ? path.resolve(dir) : null }
})

// LoRA folder — separate from SOURCES above (those are *outputs*, this is
// ComfyUI's own models/loras) — used only by the Civitai lookup endpoint
// below to resolve a lora name (as reported by ComfyUI's own LoraLoader
// combo, e.g. "MinimaxH3/foo.safetensors") to an actual file to hash.
const LORA_ROOT = process.env.COMFYUI_LORA_DIR ? path.resolve(process.env.COMFYUI_LORA_DIR) : null

// Optional — civitai.com/api/v1/model-versions/by-hash/ works unauthenticated
// for most models (confirmed even for NSFW-tagged ones), but some content is
// only fully visible with a key attached. Free to create at
// civitai.com/user/account under "API Keys".
const CIVITAI_API_KEY = process.env.CIVITAI_API_KEY || null

// "Ayarlar" (Settings) tab — three "this box, from the couch" conveniences,
// see the /api/system/* routes near the bottom. Same trust model as the rest
// of this server: no auth, reachable only by whoever can already reach the
// LAN it's on.
//   - llama-swap (its own web UI lives at :8080) — flip a model on/off
//   - start-all.sh — (re)start the ComfyUI + control-panel stack
//   - the machine itself — full power-off
const LLAMA_SWAP_URL = (process.env.LLAMA_SWAP_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const START_ALL_SCRIPT = process.env.START_ALL_SCRIPT || '/home/emir/Desktop/ComfyUI/start-all.sh'
// ComfyUI's own listen port (start-all.sh runs `main.py --listen 0.0.0.0`
// with ComfyUI's default 8188) — probed so the Settings tab can show whether
// ComfyUI is actually up regardless of who started it.
const COMFYUI_PROBE_PORT = Number(process.env.COMFYUI_PROBE_PORT || 8188)

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

// Civitai lookup results, cached to disk so this survives a server restart —
// hashing a several-hundred-MB lora file and round-tripping to Civitai isn't
// something worth redoing every time the LoRA grid is opened. Keyed by the
// lora's relative path (what the client sends); each entry also records the
// file's mtime/size at hash time, so replacing a file on disk (same name,
// different content) doesn't keep serving the old file's stale result.
const CIVITAI_CACHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'civitai-cache.json')
let civitaiCache = {}
try {
  civitaiCache = JSON.parse(await fs.readFile(CIVITAI_CACHE_PATH, 'utf8'))
} catch {
  // no cache yet, or unreadable — starts empty either way
}
let civitaiCacheSaveQueued = false
function saveCivitaiCacheSoon() {
  // Coalesces bursts of writes (e.g. a fresh LoRA grid with several missing
  // thumbnails resolving in quick succession) into one disk write instead of
  // one per lookup.
  if (civitaiCacheSaveQueued) return
  civitaiCacheSaveQueued = true
  setTimeout(() => {
    civitaiCacheSaveQueued = false
    fs.mkdir(path.dirname(CIVITAI_CACHE_PATH), { recursive: true })
      .then(() => fs.writeFile(CIVITAI_CACHE_PATH, JSON.stringify(civitaiCache)))
      .catch((err) => console.warn('[output-server] civitai cache write failed:', err.message))
  }, 1000)
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fsSync.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// Looks up a lora by content hash — Civitai's own recommended way to match a
// local file to its model page, since filenames alone are unreliable (people
// rename downloads constantly). A 404 here genuinely means "not on Civitai
// at all" (e.g. a personally-trained lora), not an error.
async function lookupCivitaiByHash(hash) {
  const headers = CIVITAI_API_KEY ? { Authorization: `Bearer ${CIVITAI_API_KEY}` } : {}
  const res = await fetch(`https://civitai.com/api/v1/model-versions/by-hash/${hash}`, { headers })
  if (res.status === 404) return { found: false, imageUrl: null, triggerWords: [], modelName: null }
  if (!res.ok) throw new Error(`Civitai API ${res.status}`)
  const data = await res.json()
  // Some model versions (this MiniMax H3 lora among them) only carry *video*
  // showcase clips in `images`, no static image at all — falling back to
  // images[0] regardless of type used to hand the client an .mp4 URL under
  // "imageUrl", which it then tried to render as an <img> and silently
  // failed to decode (indistinguishable from "nothing found" in the UI).
  // Only an actual `type: 'image'` entry counts now; genuinely
  // image-less-but-matched loras correctly get imageUrl: null instead of a
  // URL that was never going to render.
  const image = data.images?.find((im) => im.type === 'image') ?? null
  return {
    found: true,
    imageUrl: image?.url ?? null,
    triggerWords: Array.isArray(data.trainedWords) ? data.trainedWords : [],
    modelName: data.model?.name ?? null,
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
// recursing — so a source organized into subfolders (e.g. each generation
// type's own <date>/ subfolder) is browsed folder-by-folder instead of being
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

// In-memory only ("the PC's RAM", as opposed to the phone's own
// localStorage) — a batch queued overnight, or a generation mid-flight, used
// to live only in the *phone's* browser storage, so closing the phone,
// clearing site data, or just switching to a different device lost track of
// it completely even though ComfyUI itself (running on this same PC) was
// still working through it just fine. Kept here — one always-on process on
// the same machine as ComfyUI — instead of the phone: whatever's queued or
// active survives a phone reboot, a different browser, a different device
// entirely, right up until this server process itself restarts (deliberately
// not persisted to disk — that's an explicit choice, not a limitation: this
// is a live work queue, not a record worth keeping across a restart of the
// thing tracking it).
const GENERATION_KINDS = ['video', 'sdxl', 'krea2']
const remoteJobs = Object.fromEntries(GENERATION_KINDS.map((k) => [k, null]))
const remoteQueues = Object.fromEntries(GENERATION_KINDS.map((k) => [k, []]))

function requireGenerationKind(kind, res) {
  if (!GENERATION_KINDS.includes(kind)) {
    res.status(400).json({ error: `Bilinmeyen üretim türü: ${kind}` })
    return false
  }
  return true
}

const app = express()
app.use(express.json({ limit: '2mb' })) // only the /api/state/* PUT routes below actually read a body

app.get('/api/outputs/sources', (_req, res) => {
  res.json(SOURCES.map(({ id, label, root }) => ({ id, label, configured: !!root })))
})

app.get('/api/outputs', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'video')
    const relPath = typeof req.query.path === 'string' ? req.query.path : ''
    const listing = await listDirectory(source.root, relPath)
    res.json(listing)
  } catch (err) {
    sendError(res, err, 'Klasör listelenemedi.')
  }
})

app.get('/api/outputs/file', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'video')
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
    const source = findSource(req.query.source || 'video')
    const filePath = await resolveSafeRealPath(source.root, req.query.name)
    assertBrowsableExt(filePath)
    res.download(filePath, path.basename(filePath))
  } catch (err) {
    sendError(res, err, 'Dosya bulunamadı.')
  }
})

app.get('/api/outputs/thumbnail', async (req, res) => {
  try {
    const source = findSource(req.query.source || 'video')
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

app.get('/api/loras/civitai', async (req, res) => {
  try {
    if (!LORA_ROOT) throw new HttpError(503, 'LoRA klasörü yapılandırılmamış (.env: COMFYUI_LORA_DIR).')
    const name = req.query.name
    const filePath = await resolveSafeRealPath(LORA_ROOT, name)
    const stat = await fs.stat(filePath)

    const cached = civitaiCache[name]
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      res.json(cached.result)
      return
    }

    const hash = await sha256File(filePath)
    const result = await lookupCivitaiByHash(hash)
    civitaiCache[name] = { mtimeMs: stat.mtimeMs, size: stat.size, hash, result }
    saveCivitaiCacheSoon()
    res.json(result)
  } catch (err) {
    sendError(res, err, 'Civitai bilgisi alınamadı.')
  }
})

// The one job currently submitted-to-or-tracked-against ComfyUI for this
// generation kind, if any — `null` clears it. Body shape: `{ promptId,
// startedAt } | null`, opaque to this server beyond that minimal check; the
// client is the one that actually knows how to recover a job's progress from
// ComfyUI's own /history using this.
app.get('/api/state/:kind/job', (req, res) => {
  if (!requireGenerationKind(req.params.kind, res)) return
  res.json(remoteJobs[req.params.kind])
})

app.put('/api/state/:kind/job', (req, res) => {
  if (!requireGenerationKind(req.params.kind, res)) return
  const body = req.body
  remoteJobs[req.params.kind] =
    body && typeof body.promptId === 'string' && body.promptId ? { promptId: body.promptId, startedAt: Number(body.startedAt) || Date.now() } : null
  res.json({ ok: true })
})

// The full "still waiting to be submitted" queue for this generation kind —
// opaque settings objects this server never reads into, just holds and hands
// back verbatim (the client re-validates each item through its own
// normalizer on the way back in, the same way it already did coming out of
// localStorage, in case of a stale/incompatible shape from an older session).
app.get('/api/state/:kind/queue', (req, res) => {
  if (!requireGenerationKind(req.params.kind, res)) return
  res.json(remoteQueues[req.params.kind])
})

app.put('/api/state/:kind/queue', (req, res) => {
  if (!requireGenerationKind(req.params.kind, res)) return
  remoteQueues[req.params.kind] = Array.isArray(req.body) ? req.body : []
  res.json({ ok: true })
})

// --- "Ayarlar" tab: llama-swap models / start-all.sh / machine power -------

function llamaSwapFetch(pathname, init, timeoutMs = 8000) {
  return fetch(`${LLAMA_SWAP_URL}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

// Bare TCP connect check — "is something listening on this port right now".
// Cheap enough to run on every Settings poll; only ever probes localhost.
function probePort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const finish = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

// llama-swap: every configured model + whether it's currently loaded. The
// per-model `state` ('ready' | 'loading' | ...) comes from /running; a model
// not in /running at all is reported 'stopped'.
app.get('/api/system/models', async (_req, res) => {
  try {
    const [modelsRes, runningRes] = await Promise.all([llamaSwapFetch('/v1/models'), llamaSwapFetch('/running')])
    if (!modelsRes.ok) throw new HttpError(502, `llama-swap /v1/models → ${modelsRes.status}`)
    const models = (await modelsRes.json())?.data ?? []
    const running = runningRes.ok ? (await runningRes.json())?.running ?? [] : []
    const stateById = Object.fromEntries(running.map((r) => [r.model, r.state || 'ready']))
    res.json({
      url: LLAMA_SWAP_URL,
      models: models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        state: stateById[m.id] ?? 'stopped',
        running: Object.prototype.hasOwnProperty.call(stateById, m.id),
      })),
    })
  } catch (err) {
    sendError(res, err, 'llama-swap modelleri alınamadı.')
  }
})

app.post('/api/system/models/:id/load', (req, res) => {
  const id = req.params.id
  // Kick the load and keep the connection open long enough that llama-swap
  // doesn't read an immediate client disconnect as "gave up" and cancel the
  // spin-up — but the phone doesn't wait it out: the Settings screen polls
  // /api/system/models and flips the toggle once the state turns 'ready'.
  llamaSwapFetch(`/upstream/${encodeURIComponent(id)}/?_=${Date.now()}`, {}, 180000).catch(() => {})
  res.json({ ok: true })
})

app.post('/api/system/models/:id/unload', async (req, res) => {
  try {
    const r = await llamaSwapFetch(`/api/models/unload/${encodeURIComponent(req.params.id)}`, { method: 'POST' }, 15000)
    if (!r.ok) throw new HttpError(502, `llama-swap unload → ${r.status}`)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err, 'Model kapatılamadı.')
  }
})

// start-all.sh — spawned in its own process group (detached) so "stop" can
// signal the whole tree (ComfyUI + the npm dev stack it launches). Only a
// copy *this* server started is tracked/stoppable; one already running from a
// terminal is invisible here (the port probes below are the status readout
// for that case).
let startAllChild = null // { proc, pid, startedAt } | null

function startAllRunning() {
  return !!startAllChild && startAllChild.proc.exitCode === null && !startAllChild.proc.killed
}

app.get('/api/system/start-all', async (_req, res) => {
  const [comfyUp, panelUp] = await Promise.all([probePort(COMFYUI_PROBE_PORT), probePort(5173)])
  const alive = startAllRunning()
  res.json({
    script: START_ALL_SCRIPT,
    running: alive,
    pid: alive ? startAllChild?.pid : undefined,
    startedAt: alive ? startAllChild?.startedAt : undefined,
    comfyUp,
    panelUp,
  })
})

app.post('/api/system/start-all/start', async (req, res) => {
  try {
    if (startAllRunning()) throw new HttpError(409, 'start-all.sh zaten bu panelden başlatıldı.')
    try {
      await fs.access(START_ALL_SCRIPT, fsSync.constants.X_OK)
    } catch {
      throw new HttpError(404, `Script çalıştırılabilir değil ya da bulunamadı: ${START_ALL_SCRIPT}`)
    }
    const proc = spawn('bash', [START_ALL_SCRIPT], {
      cwd: path.dirname(START_ALL_SCRIPT),
      detached: true, // own process group → stop can kill the whole tree
      stdio: 'ignore',
    })
    proc.unref()
    const entry = { proc, pid: proc.pid, startedAt: Date.now() }
    startAllChild = entry
    proc.on('exit', () => {
      if (startAllChild === entry) startAllChild = null
    })
    res.json({ ok: true, pid: proc.pid })
  } catch (err) {
    sendError(res, err, 'start-all.sh başlatılamadı.')
  }
})

app.post('/api/system/start-all/stop', (_req, res) => {
  try {
    if (!startAllRunning()) throw new HttpError(409, 'Bu panelden başlatılmış çalışan bir start-all.sh yok.')
    const entry = startAllChild
    const pid = entry.pid
    const signal = (sig) => {
      try {
        process.kill(-pid, sig) // negative pid → whole process group
      } catch {
        try {
          process.kill(pid, sig)
        } catch {
          /* already gone */
        }
      }
    }
    signal('SIGTERM')
    setTimeout(() => {
      if (entry.proc.exitCode === null) signal('SIGKILL')
    }, 6000).unref()
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err, 'start-all.sh durdurulamadı.')
  }
})

app.post('/api/system/shutdown', (_req, res) => {
  res.json({ ok: true })
  // A beat so the response reaches the phone before logind tears the session
  // down. `systemctl poweroff` needs no sudo here: the desktop session is
  // "active" on seat0 and polkit lets an active local session power off on
  // its own (verified: CanPowerOff → "yes").
  setTimeout(() => {
    spawn('systemctl', ['poweroff'], { detached: true, stdio: 'ignore' }).unref()
  }, 800)
})

app.listen(PORT, () => {
  const rootsDesc = SOURCES.map((s) => `${s.label}=${s.root ?? 'AYARLANMADI'}`).join(', ')
  console.log(`[output-server] http://localhost:${PORT} (${rootsDesc})`)
})
