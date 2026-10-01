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
import { execFile, spawn } from 'node:child_process'
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

// --- Civitai image/video browser (the app's "🌐 Civitai" view) ---
// Proxied here rather than called from the phone so the API key (needed for
// the full NSFW feed) never leaves this PC, and so the payload can be
// trimmed to the handful of fields the app shows.
const CIVITAI_SORTS = new Set(['Newest', 'Most Reactions', 'Most Comments'])
const CIVITAI_PERIODS = new Set(['Day', 'Week', 'Month', 'Year', 'AllTime'])

function civitaiHeaders() {
  return CIVITAI_API_KEY ? { Authorization: `Bearer ${CIVITAI_API_KEY}` } : {}
}

async function fetchCivitaiJson(url) {
  let upstream = await fetch(url, { headers: civitaiHeaders(), signal: AbortSignal.timeout(30000) })
  // Civitai throws the odd transient 503 — one quiet retry before erroring.
  if (upstream.status >= 500) {
    await new Promise((r) => setTimeout(r, 800))
    upstream = await fetch(url, { headers: civitaiHeaders(), signal: AbortSignal.timeout(30000) })
  }
  if (!upstream.ok) throw new HttpError(502, `Civitai API ${upstream.status}`)
  return upstream.json()
}

// tRPC responses come as a flat, reference-compressed array (devalue
// style): every value inside an object/array is an index into the root
// array. Negative indices are sentinels (-1 undefined, the rest NaN/±Inf/-0
// — none of which this feed uses, so they just become null).
function civitaiUnflatten(arr) {
  const memo = new Map()
  const hydrate = (i) => {
    if (i < 0) return i === -1 ? undefined : null
    if (memo.has(i)) return memo.get(i)
    const v = arr[i]
    if (v === null || typeof v !== 'object') {
      memo.set(i, v)
      return v
    }
    if (Array.isArray(v)) {
      // A leading string marks a special type: ["Date", iso], ["Set", ...].
      if (typeof v[0] === 'string') {
        const out = v[0] === 'Set' ? v.slice(1).map(hydrate) : v[1]
        memo.set(i, out)
        return out
      }
      const out = []
      memo.set(i, out)
      for (const x of v) out.push(hydrate(x))
      return out
    }
    const out = {}
    memo.set(i, out)
    for (const [k, x] of Object.entries(v)) out[k] = hydrate(x)
    return out
  }
  return hydrate(0)
}

const CIVITAI_CDN = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA'
// Browsing-level bit flags: PG 1, PG-13 2, R 4, X 8, XXX 16.
const CIVITAI_LEVEL_ALL = 1 + 2 + 4 + 8 + 16
const CIVITAI_LEVEL_NSFW = 4 + 8 + 16

// The feed comes from civitai.red's own website feed (tRPC
// image.getInfinite), not the public v1 /api/v1/images: v1's "Most
// Reactions" ranking is broken for many queries (it caches per URL and some
// entries come back as unranked 0–7 reaction posts — worst with its nsfw
// filter, where Pony/Illustrious/NoobAI were almost always wrong), and its
// "Newest" needs a period workaround. This is exactly what the site shows,
// and answers in well under a second. civitai.com's copy of the endpoint is
// SFW-only even when logged in, hence .red.
// Undocumented — if its shape changes, this is the part to revisit.
async function civitaiFeed({ sort, period, type, baseModels, withMeta, nsfwOnly, cursor }) {
  const browsingLevel = nsfwOnly ? CIVITAI_LEVEL_NSFW : CIVITAI_LEVEL_ALL
  const input = { period, sort, browsingLevel, types: [type], withMeta, limit: 40 }
  if (baseModels) input.baseModels = [baseModels]
  if (cursor) input.cursor = cursor
  const body = await fetchCivitaiJson(`https://civitai.red/api/trpc/image.getInfinite?input=${encodeURIComponent(JSON.stringify({ json: input }))}`)
  let data = body?.result?.data
  data = typeof data === 'string' ? civitaiUnflatten(JSON.parse(data)) : data?.json
  if (!data || !Array.isArray(data.items)) throw new HttpError(502, 'Civitai yanıtı tanınmadı.')
  return {
    items: data.items.map((it) => {
      const s = it.stats ?? {}
      return {
        id: it.id,
        url: `${CIVITAI_CDN}/${it.url}/original=true/${encodeURIComponent(it.name || it.url)}`,
        type: it.type === 'video' ? 'video' : 'image',
        width: it.width,
        height: it.height,
        createdAt: it.publishedAt || it.createdAt,
        // The feed leaves baseModel empty — the filter, when set, is the answer.
        baseModel: it.baseModel || baseModels || null,
        username: it.user?.username || null,
        reactions: (s.likeCountAllTime ?? 0) + (s.heartCountAllTime ?? 0) + (s.laughCountAllTime ?? 0) + (s.cryCountAllTime ?? 0),
        comments: s.commentCountAllTime ?? 0,
        // Not in the feed; the viewer fetches prompt/settings on open
        // (/api/civitai/generation).
        meta: null,
      }
    }),
    nextCursor: data.nextCursor != null ? String(data.nextCursor) : null,
  }
}

app.get('/api/civitai/images', async (req, res) => {
  try {
    const sort = CIVITAI_SORTS.has(req.query.sort) ? req.query.sort : 'Newest'
    res.json(
      await civitaiFeed({
        sort,
        period: sort === 'Newest' ? 'AllTime' : CIVITAI_PERIODS.has(req.query.period) ? req.query.period : 'Week',
        type: req.query.type === 'video' ? 'video' : 'image',
        baseModels: typeof req.query.baseModels === 'string' ? req.query.baseModels : '',
        withMeta: req.query.withMeta === 'true',
        nsfwOnly: req.query.nsfwOnly === 'true',
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : '',
      }),
    )
  } catch (err) {
    sendError(res, err, 'Civitai listesi alınamadı.')
  }
})

// Civitai's own generator endpoint — not part of the documented v1 API. The
// feed carries no generation metadata, so this is where the viewer gets the
// prompt, settings, size and checkpoint/LoRAs of an opened post. Best-effort:
// any failure just means "no info".
app.get('/api/civitai/generation', async (req, res) => {
  try {
    const id = Number(req.query.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Geçersiz id.')
    const upstream = await fetch(`https://civitai.com/api/generation/data?type=image&id=${id}`, {
      headers: civitaiHeaders(),
      signal: AbortSignal.timeout(20000),
    })
    if (!upstream.ok) throw new HttpError(502, `Civitai ${upstream.status}`)
    const data = await upstream.json()
    const p = data.params ?? {}
    res.json({
      prompt: typeof p.prompt === 'string' ? p.prompt : null,
      negativePrompt: typeof p.negativePrompt === 'string' ? p.negativePrompt : null,
      seed: p.seed ?? null,
      steps: p.steps ?? null,
      cfgScale: p.cfgScale ?? null,
      sampler: p.sampler ?? null,
      scheduler: p.scheduler ?? null,
      model: p.Model ?? null,
      width: p.width ?? p.aspectRatio?.width ?? null,
      height: p.height ?? p.aspectRatio?.height ?? null,
      resources: (data.resources ?? []).map((r) => ({
        name: r.model?.name ? `${r.model.name}${r.name ? ` — ${r.name}` : ''}` : r.name,
        type: r.model?.type ?? null,
        baseModel: r.baseModel ?? null,
        strength: typeof r.strength === 'number' ? r.strength : null,
      })),
    })
  } catch (err) {
    sendError(res, err, 'Civitai üretim bilgisi alınamadı.')
  }
})

// Which base-model family each LoRA was trained for, read straight from the
// .safetensors header (kohya's ss_base_model_version / the modelspec
// architecture field) — so the app's LoRA picker can show only the LoRAs
// that actually work with the current tab's model (an SDXL LoRA does nothing
// useful on Krea2, and vice versa) without guessing from folder names. Only
// the small JSON header at the start of each file is read, never the
// weights, and results are cached per file until its mtime/size changes.
const loraFamilyCache = new Map() // relative name -> { mtimeMs, size, family }

async function readSafetensorsArchitecture(filePath) {
  const fh = await fs.open(filePath, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    await fh.read(lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    if (!headerLen || headerLen > 64 * 1024 * 1024) return null
    const header = Buffer.alloc(headerLen)
    await fh.read(header, 0, headerLen, 8)
    const meta = JSON.parse(header.toString('utf8')).__metadata__ || {}
    return meta['modelspec.architecture'] || meta.ss_base_model_version || null
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

// null = the file doesn't say (the client falls back to its folder then).
function loraFamilyFromArchitecture(arch) {
  if (!arch) return null
  const a = String(arch).toLowerCase()
  if (a.includes('krea2')) return 'krea2'
  if (a.includes('minimax')) return 'video'
  if (a.includes('stable-diffusion-xl') || a.includes('sdxl')) return 'sdxl'
  if (a.includes('stable-diffusion-v1') || a.includes('sd_v1')) return 'sd1'
  return 'other'
}

async function listLoraFiles(dir, prefix = '') {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listLoraFiles(path.join(dir, entry.name), rel)))
    else if (entry.name.toLowerCase().endsWith('.safetensors')) out.push(rel)
  }
  return out
}

app.get('/api/loras/meta', async (_req, res) => {
  try {
    if (!LORA_ROOT) throw new HttpError(503, 'LoRA klasörü yapılandırılmamış (.env: COMFYUI_LORA_DIR).')
    const result = {}
    for (const name of await listLoraFiles(LORA_ROOT)) {
      const filePath = path.join(LORA_ROOT, name)
      const stat = await fs.stat(filePath)
      let entry = loraFamilyCache.get(name)
      if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
        entry = { mtimeMs: stat.mtimeMs, size: stat.size, family: loraFamilyFromArchitecture(await readSafetensorsArchitecture(filePath)) }
        loraFamilyCache.set(name, entry)
      }
      result[name] = entry.family
    }
    res.json(result)
  } catch (err) {
    sendError(res, err, 'LoRA bilgileri okunamadı.')
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
// ComfyUI runs as its own transient systemd user unit (systemd-run), not as
// a child of this server. As a child it lived in mobile-control.service's
// cgroup, so every panel restart (KillMode=control-group) killed ComfyUI
// along with it — mid-generation, models and all. As its own unit it
// survives panel restarts, and stop/status go through systemctl.
const COMFYUI_UNIT = 'comfyui.service'

function systemctlUser(args) {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err && err.code !== 3) reject(new Error((stderr || err.message).trim())) // 3 = "not active" for is-active/show
      else resolve(stdout)
    })
  })
}

async function comfyUnitStatus() {
  const out = await systemctlUser(['show', COMFYUI_UNIT, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ExecMainStartTimestamp', '--timestamp=unix'])
  const props = Object.fromEntries(out.trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
  const running = props.ActiveState === 'active' || props.ActiveState === 'activating'
  const startedSec = Number((props.ExecMainStartTimestamp || '').replace('@', ''))
  return {
    running,
    pid: running && Number(props.MainPID) > 0 ? Number(props.MainPID) : undefined,
    startedAt: running && startedSec > 0 ? startedSec * 1000 : undefined,
  }
}

app.get('/api/system/start-all', async (_req, res) => {
  try {
    const [comfyUp, panelUp, unit] = await Promise.all([probePort(COMFYUI_PROBE_PORT), probePort(5173), comfyUnitStatus()])
    res.json({ script: START_ALL_SCRIPT, ...unit, comfyUp, panelUp })
  } catch (err) {
    sendError(res, err, 'ComfyUI durumu alınamadı.')
  }
})

app.post('/api/system/start-all/start', async (req, res) => {
  try {
    if ((await comfyUnitStatus()).running) throw new HttpError(409, 'ComfyUI zaten çalışıyor.')
    try {
      await fs.access(START_ALL_SCRIPT, fsSync.constants.X_OK)
    } catch {
      throw new HttpError(404, `Script çalıştırılabilir değil ya da bulunamadı: ${START_ALL_SCRIPT}`)
    }
    await new Promise((resolve, reject) => {
      execFile(
        'systemd-run',
        [
          '--user',
          `--unit=${COMFYUI_UNIT}`,
          '--description=ComfyUI (mobile-control panelinden başlatıldı)',
          // Remove the unit once it stops, failed or not — otherwise a
          // crashed run blocks the next start under the same name.
          '--collect',
          `--working-directory=${path.dirname(START_ALL_SCRIPT)}`,
          '-p',
          'TimeoutStopSec=15',
          'bash',
          START_ALL_SCRIPT,
        ],
        { timeout: 15000 },
        (err, _stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve()),
      )
    })
    res.json({ ok: true, ...(await comfyUnitStatus()) })
  } catch (err) {
    sendError(res, err, 'start-all.sh başlatılamadı.')
  }
})

app.post('/api/system/start-all/stop', async (_req, res) => {
  try {
    if (!(await comfyUnitStatus()).running) throw new HttpError(409, 'Bu panelden başlatılmış çalışan bir ComfyUI yok.')
    // SIGTERM to the whole unit, SIGKILL after TimeoutStopSec — systemd
    // does the escalation the old process-group code did by hand.
    await systemctlUser(['stop', '--no-block', COMFYUI_UNIT])
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

// Sleep instead of power-off: resume takes seconds and ComfyUI (with its
// models still in VRAM — nvidia-suspend preserves video memory here) carries
// on where it was. Woken again by a Wake-on-LAN packet from the APK's
// offline page (android/.../WakeOnLanPlugin.java). Refused while ComfyUI
// has work, since suspending mid-generation would just stall it.
app.post('/api/system/suspend', async (_req, res) => {
  try {
    const queue = await fetch(`http://127.0.0.1:${COMFYUI_PROBE_PORT}/queue`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .catch(() => null)
    const busy = queue ? queue.queue_running.length + queue.queue_pending.length : 0
    if (busy > 0) throw new HttpError(409, `ComfyUI'de ${busy} iş var — bitince tekrar dene.`)
    res.json({ ok: true })
    // Same reasoning as shutdown above: let the response reach the phone
    // first; an active local session may suspend without sudo (CanSuspend → "yes").
    setTimeout(() => {
      spawn('systemctl', ['suspend'], { detached: true, stdio: 'ignore' }).unref()
    }, 800)
  } catch (err) {
    sendError(res, err, 'Uyku moduna geçilemedi.')
  }
})

app.listen(PORT, () => {
  const rootsDesc = SOURCES.map((s) => `${s.label}=${s.root ?? 'AYARLANMADI'}`).join(', ')
  console.log(`[output-server] http://localhost:${PORT} (${rootsDesc})`)
})
