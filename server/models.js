// Model management for the "Modeller" view and the Civitai model page:
//
//   - /api/civitai/model        a Civitai model's info + versions + files
//   - /api/models/downloads     downloads run HERE on the PC (the phone only
//                               starts / watches / cancels them), into
//                               MODEL_DOWNLOAD_DIR (~/Downloads/civitai);
//                               resumable across panel restarts / drops
//   - /api/models               list ComfyUI's models/ + the download folder
//   - /api/models/move|delete   move between folders / delete for good
//   - /api/models/preview*      the picture next to a model (rgthree's LoRA
//                               thumbnails read <name>.jpg/.png/.jpeg)
//   - /api/models/storage       free disk space + what each folder takes
//
// Safety rails, all enforced here rather than trusted from the phone:
//   - only .safetensors / .gguf are downloaded (.ckpt / .pt can run code
//     when loaded)
//   - a download that would leave less than RESERVE_BYTES free is refused
//     (models/ shares the system disk)
//   - every path goes through resolveSafePath against its area's root
//   - models the tabs' workflow templates load can't be moved or deleted
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import express from 'express'
import sharp from 'sharp'

const MODELS_ROOT = path.resolve(process.env.COMFYUI_MODELS_DIR || '/home/emir/Desktop/ComfyUI/models')
const DOWNLOAD_DIR = path.resolve(process.env.MODEL_DOWNLOAD_DIR || '/home/emir/Downloads/civitai')
const RESERVE_BYTES = 10 * 1024 ** 3

const MODEL_EXT = new Set(['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin', '.sft'])
// Civitai file metadata.format → the only extensions we'll write.
const DOWNLOADABLE = { SafeTensor: '.safetensors', GGUF: '.gguf' }
// Files that belong to a model and travel / die with it: <base>.<ext>, plus
// rgthree's own <file>.rgthree-info.json.
const SIDECAR_SUFFIXES = ['.jpg', '.jpeg', '.png', '.webp', '.preview.png', '.preview.jpg', '.preview.jpeg', '.json', '.civitai.info', '.txt']
const PREVIEW_SUFFIXES = ['.jpg', '.png', '.jpeg', '.webp', '.preview.png', '.preview.jpg', '.preview.jpeg']

// Models the tabs load by default (their workflow templates). Moving or
// deleting one would break that tab, so those are locked. LoRAs stay free:
// the templates' LoRA slots are just defaults you switch around anyway.
const TEMPLATE_TABS = {
  'template.json': 'Video',
  'imageTemplate.json': 'SDXL',
  'krea2Template.json': 'Krea2',
  'anime2realTemplate.json': 'Anime2Real',
}

function loadProtected() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workflow')
  const map = new Map() // ComfyUI model name ("Images/x.safetensors") → ['SDXL', …]
  for (const [file, tab] of Object.entries(TEMPLATE_TABS)) {
    let json
    try {
      json = JSON.parse(fsSync.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      continue
    }
    const visit = (v) => {
      if (typeof v === 'string') {
        if (MODEL_EXT.has(path.extname(v).toLowerCase())) map.set(v, [...new Set([...(map.get(v) ?? []), tab])])
      } else if (v && typeof v === 'object') for (const x of Object.values(v)) visit(x)
    }
    visit(json)
  }
  return map
}

// Turns Civitai's HTML descriptions into plain text — never rendered as HTML
// on the phone.
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return ''
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000)
}

function sanitizeFileName(name) {
  const base = path.basename(String(name)).replace(/[\u0000-\u001f/\\]/g, '_').trim()
  if (!base || base === '.' || base === '..') return null
  return base
}

function stripModelExt(name) {
  const ext = path.extname(name)
  return MODEL_EXT.has(ext.toLowerCase()) ? name.slice(0, -ext.length) : name
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function sidecarsOf(filePath) {
  const dir = path.dirname(filePath)
  const base = stripModelExt(path.basename(filePath))
  const names = [...SIDECAR_SUFFIXES.map((s) => base + s), path.basename(filePath) + '.rgthree-info.json']
  const out = []
  for (const n of names) if (await exists(path.join(dir, n))) out.push(path.join(dir, n))
  return out
}

async function findPreview(filePath) {
  const dir = path.dirname(filePath)
  const base = stripModelExt(path.basename(filePath))
  for (const s of PREVIEW_SUFFIXES) {
    const p = path.join(dir, base + s)
    if (await exists(p)) return p
  }
  return null
}

// Total size of a folder tree (symlinks not followed).
async function dirSize(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  const sizes = await Promise.all(
    entries.map(async (e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return dirSize(p)
      if (e.isFile()) return (await fs.lstat(p).catch(() => ({ size: 0 }))).size
      return 0
    }),
  )
  return sizes.reduce((a, b) => a + b, 0)
}

export function registerModelRoutes(app, deps) {
  const { HttpError, sendError, resolveSafePath, resolveSafeRealPath, civitaiHeaders, fetchCivitaiJson, findSource, outputRoot } = deps
  const PROTECTED = loadProtected()
  const AREAS = { models: MODELS_ROOT, downloads: DOWNLOAD_DIR }

  fsSync.mkdirSync(DOWNLOAD_DIR, { recursive: true })

  function areaRoot(area) {
    const root = AREAS[area]
    if (!root) throw new HttpError(400, 'Bilinmeyen alan.')
    return root
  }

  // "Images/x.safetensors" — how ComfyUI names a file inside its type folder.
  function comfyName(area, rel) {
    if (area !== 'models' || rel.startsWith('loras/')) return null
    return rel.split('/').slice(1).join('/')
  }
  // `inUse`: what the phone's tabs have selected right now ({comfy name:
  // [tab]}) — a tab's own pick (say a different video model) isn't in its
  // template, so the phone sends it along with a move / delete.
  function protectedBy(area, rel, inUse) {
    const name = comfyName(area, rel)
    if (!name) return null
    const tabs = [...(PROTECTED.get(name) ?? []), ...(inUse && Array.isArray(inUse[name]) ? inUse[name].map(String) : [])]
    return tabs.length ? [...new Set(tabs)] : null
  }

  // --- Listing --------------------------------------------------------------

  async function walk(root, rel, depth, files, dirs) {
    let entries
    try {
      entries = await fs.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        const st = await fs.stat(path.join(root, r)).catch(() => null)
        isDir = !!st?.isDirectory()
        isFile = !!st?.isFile()
      }
      if (isDir) {
        dirs.push(r)
        if (depth < 5) await walk(root, r, depth + 1, files, dirs)
      } else if (isFile && MODEL_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(r)
      }
    }
  }

  async function describe(area, rel) {
    const root = areaRoot(area)
    const full = path.join(root, rel)
    const st = await fs.stat(full)
    const preview = await findPreview(full)
    let civitai = null
    const json = path.join(path.dirname(full), stripModelExt(path.basename(full)) + '.json')
    try {
      const meta = JSON.parse(await fs.readFile(json, 'utf8'))
      if (meta?.civitai?.versionId) civitai = { modelId: meta.civitai.modelId ?? null, versionId: meta.civitai.versionId }
    } catch {
      // no sidecar / not ours
    }
    return {
      area,
      path: rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
      preview: preview ? Math.round((await fs.stat(preview)).mtimeMs) : null,
      protectedBy: protectedBy(area, rel),
      civitai,
    }
  }

  let indexCache = null // { at, byName: Map<lowercased file name, label> }
  async function localIndex() {
    if (indexCache && Date.now() - indexCache.at < 10000) return indexCache.byName
    const byName = new Map()
    for (const [area, root] of Object.entries(AREAS)) {
      const files = []
      await walk(root, '', 0, files, [])
      for (const f of files) byName.set(path.basename(f).toLowerCase(), area === 'models' ? `models/${f}` : `İndirilenler/${f}`)
    }
    indexCache = { at: Date.now(), byName }
    return byName
  }
  const invalidate = () => {
    indexCache = null
    storageCache = null
  }

  app.get('/api/models', async (_req, res) => {
    try {
      const out = {}
      const folders = []
      for (const area of Object.keys(AREAS)) {
        const files = []
        const dirs = []
        await walk(AREAS[area], '', 0, files, dirs)
        out[area] = await Promise.all(files.sort((a, b) => a.localeCompare(b)).map((f) => describe(area, f)))
        if (area === 'models') folders.push(...dirs.sort((a, b) => a.localeCompare(b)))
      }
      res.json({ models: out.models, downloads: out.downloads, folders, downloadDir: DOWNLOAD_DIR })
    } catch (err) {
      sendError(res, err, 'Modeller listelenemedi.')
    }
  })

  // --- Storage ---------------------------------------------------------------

  let storageCache = null
  app.get('/api/models/storage', async (_req, res) => {
    try {
      if (!storageCache || Date.now() - storageCache.at > 30000) {
        const places = [
          { key: 'models', label: 'Modeller', dir: MODELS_ROOT },
          { key: 'output', label: 'Galeri', dir: outputRoot },
          { key: 'downloads', label: 'İndirilenler', dir: DOWNLOAD_DIR },
        ].filter((p) => p.dir)
        const disks = new Map()
        for (const p of places) {
          const [st, sf, bytes] = await Promise.all([fs.stat(p.dir), fs.statfs(p.dir), dirSize(p.dir)])
          const id = String(st.dev)
          if (!disks.has(id)) disks.set(id, { total: sf.blocks * sf.bsize, free: sf.bavail * sf.bsize, folders: [] })
          disks.get(id).folders.push({ key: p.key, label: p.label, bytes })
        }
        storageCache = { at: Date.now(), data: { disks: [...disks.values()], reserve: RESERVE_BYTES } }
      }
      res.json(storageCache.data)
    } catch (err) {
      sendError(res, err, 'Disk bilgisi alınamadı.')
    }
  })

  async function freeBytes() {
    const sf = await fs.statfs(DOWNLOAD_DIR)
    return sf.bavail * sf.bsize
  }

  // --- Civitai model info ----------------------------------------------------

  app.get('/api/civitai/model', async (req, res) => {
    try {
      let modelId = Number(req.query.modelId)
      const versionId = Number(req.query.versionId)
      if (!(Number.isInteger(modelId) && modelId > 0)) {
        if (!(Number.isInteger(versionId) && versionId > 0)) throw new HttpError(400, 'Geçersiz model.')
        const v = await fetchCivitaiJson(`https://civitai.com/api/v1/model-versions/${versionId}`)
        modelId = v.modelId
      }
      const m = await fetchCivitaiJson(`https://civitai.com/api/v1/models/${modelId}`)
      const local = await localIndex()
      const jobs = [...downloads.values()]
      res.json({
        id: m.id,
        name: m.name,
        type: m.type,
        nsfw: !!m.nsfw,
        creator: m.creator?.username ?? null,
        tags: Array.isArray(m.tags) ? m.tags : [],
        downloads: m.stats?.downloadCount ?? 0,
        likes: m.stats?.thumbsUpCount ?? 0,
        description: htmlToText(m.description),
        versions: (m.modelVersions ?? []).map((v) => {
          const cover = (v.images ?? []).find((i) => i.type === 'image')
          return {
            id: v.id,
            name: v.name,
            baseModel: v.baseModel ?? null,
            publishedAt: v.publishedAt ?? null,
            // Anything but Public may refuse the download (early access,
            // paid) — the page shows a small warning but still lets you try:
            // creators often free older versions.
            availability: v.availability ?? 'Public',
            earlyAccessEndsAt: v.earlyAccessEndsAt ?? null,
            trainedWords: Array.isArray(v.trainedWords) ? v.trainedWords : [],
            description: htmlToText(v.description),
            cover: cover ? cover.url.replace('/original=true/', '/width=450/') : null,
            downloads: v.stats?.downloadCount ?? 0,
            files: (v.files ?? []).map((f) => {
              const ext = path.extname(f.name || '').toLowerCase()
              const fmt = f.metadata?.format ?? null
              const name = sanitizeFileName(f.name)
              const job = jobs.find((j) => j.fileId === f.id && (j.status === 'downloading' || j.status === 'done'))
              return {
                id: f.id,
                name: f.name,
                type: f.type ?? null,
                bytes: Math.round((f.sizeKB ?? 0) * 1024),
                format: fmt,
                fp: f.metadata?.fp ?? null,
                size: f.metadata?.size ?? null,
                primary: !!f.primary,
                allowed: DOWNLOADABLE[fmt] === ext,
                local: name ? (local.get(name.toLowerCase()) ?? null) : null,
                jobId: job?.id ?? null,
              }
            }),
          }
        }),
      })
    } catch (err) {
      sendError(res, err, 'Model bilgisi alınamadı.')
    }
  })

  // --- Civitai model browser (the Civitai view's "Modeller" tab) --------------
  // Public v1 /models with the key (so NSFW models are included). Its
  // payload is huge (every version with every image) — trimmed to one tile.
  const MODEL_SORTS = new Set(['Most Downloaded', 'Highest Rated', 'Newest'])
  const MODEL_PERIODS = new Set(['Day', 'Week', 'Month', 'Year', 'AllTime'])
  const MODEL_TYPES = new Set(['Checkpoint', 'LORA', 'LoCon', 'DoRA', 'TextualInversion', 'VAE', 'Upscaler', 'Controlnet'])

  app.get('/api/civitai/models', async (req, res) => {
    try {
      const params = new URLSearchParams({ limit: '30', nsfw: 'true' })
      const sort = MODEL_SORTS.has(req.query.sort) ? req.query.sort : 'Most Downloaded'
      params.set('sort', sort)
      const query = typeof req.query.query === 'string' ? req.query.query.trim().slice(0, 100) : ''
      // A search looks at all time: Civitai otherwise only finds models that
      // were downloaded within the period ("Hafta" → most searches empty).
      if (sort !== 'Newest') params.set('period', query ? 'AllTime' : MODEL_PERIODS.has(req.query.period) ? req.query.period : 'Month')
      const list = (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : [])
      for (const t of list(req.query.types)) if (MODEL_TYPES.has(t)) params.append('types', t)
      for (const b of list(req.query.baseModels).slice(0, 12)) params.append('baseModels', b)
      if (query) params.set('query', query)
      const tag = typeof req.query.tag === 'string' ? req.query.tag.trim().slice(0, 60) : ''
      if (tag) params.set('tag', tag)
      if (typeof req.query.cursor === 'string' && req.query.cursor) params.set('cursor', req.query.cursor)
      const data = await fetchCivitaiJson(`https://civitai.com/api/v1/models?${params}`)
      const nsfwOnly = req.query.nsfwOnly === 'true'
      res.json({
        items: (data.items ?? [])
          .filter((m) => !nsfwOnly || m.nsfw)
          .map((m) => {
            const v = m.modelVersions?.[0] ?? {}
            const img = (v.images ?? []).find((i) => i.type === 'image') ?? (v.images ?? [])[0] ?? null
            return {
              id: m.id,
              name: m.name,
              type: m.type,
              nsfw: !!m.nsfw,
              creator: m.creator?.username ?? null,
              downloads: m.stats?.downloadCount ?? 0,
              likes: m.stats?.thumbsUpCount ?? 0,
              baseModel: v.baseModel ?? null,
              versionId: v.id ?? null,
              versions: m.modelVersions?.length ?? 0,
              // Video covers: Civitai's CDN gives the first frame as a still.
              cover: img?.url ? img.url.replace('/original=true/', img.type === 'video' ? '/anim=false,transcode=true,width=450/' : '/width=450/') : null,
            }
          }),
        nextCursor: data.metadata?.nextCursor != null ? String(data.metadata.nextCursor) : null,
      })
    } catch (err) {
      sendError(res, err, 'Civitai model listesi alınamadı.')
    }
  })

  // --- Downloads ---------------------------------------------------------------
  //
  // Resumable: the job list is saved to disk, and the .part file is kept.
  // After a panel restart the unfinished ones carry on from where they
  // stopped (Civitai's storage honours HTTP Range); a dropped connection
  // (PC suspend, Wi-Fi blip, a Civitai 5xx) is retried the same way.

  const JOBS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'model-downloads.json')
  const MAX_ATTEMPTS = 8
  const downloads = new Map() // id → job (+ non-public: abort, samples, meta)
  const publicJob = ({ abort: _a, samples: _s, meta: _m, ...j }) => j

  let saveTimer = null
  function saveJobs() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      const data = [...downloads.values()].map(({ abort: _a, samples: _s, ...j }) => j)
      fs.mkdir(path.dirname(JOBS_PATH), { recursive: true })
        .then(() => fs.writeFile(JOBS_PATH, JSON.stringify(data)))
        .catch((err) => console.error('[models] could not save downloads', err.message))
    }, 300)
  }

  app.get('/api/models/downloads', (_req, res) => {
    res.json([...downloads.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt))
  })

  app.post('/api/models/downloads', async (req, res) => {
    try {
      const versionId = Number(req.body?.versionId)
      const fileId = Number(req.body?.fileId)
      if (!Number.isInteger(versionId) || !Number.isInteger(fileId)) throw new HttpError(400, 'Geçersiz dosya.')
      const v = await fetchCivitaiJson(`https://civitai.com/api/v1/model-versions/${versionId}`)
      const f = (v.files ?? []).find((x) => x.id === fileId)
      if (!f) throw new HttpError(404, 'Dosya bulunamadı.')
      const name = sanitizeFileName(f.name)
      const fmt = f.metadata?.format
      if (!name || DOWNLOADABLE[fmt] !== path.extname(name).toLowerCase())
        throw new HttpError(400, 'Sadece .safetensors ve .gguf indirilebilir (diğer formatlar yüklenirken kod çalıştırabilir).')
      const url = new URL(f.downloadUrl || v.downloadUrl)
      if (url.protocol !== 'https:' || url.hostname !== 'civitai.com') throw new HttpError(502, 'Beklenmeyen indirme adresi.')

      const existing = (await localIndex()).get(name.toLowerCase())
      if (existing) throw new HttpError(409, `Zaten var: ${existing}`)
      if ([...downloads.values()].some((j) => j.name === name && j.status === 'downloading')) throw new HttpError(409, 'Bu dosya zaten iniyor.')
      const bytes = Math.round((f.sizeKB ?? 0) * 1024)
      const active = [...downloads.values()].filter((j) => j.status === 'downloading').reduce((n, j) => n + (j.bytes - j.received), 0)
      const free = await freeBytes()
      if (free - active - bytes < RESERVE_BYTES)
        throw new HttpError(507, `Yer yetmiyor: ${gb(bytes)} indirilince ${gb(Math.max(0, free - active - bytes))} kalır (en az ${gb(RESERVE_BYTES)} boş kalmalı).`)
      // A stale .part of the same name (an earlier canceled run) — start clean.
      await fs.rm(path.join(DOWNLOAD_DIR, name + '.part'), { force: true })

      const cover = (v.images ?? []).find((i) => i.type === 'image')
      const job = {
        id: crypto.randomUUID(),
        versionId,
        fileId,
        modelId: v.modelId,
        modelName: v.model?.name ?? '',
        versionName: v.name ?? '',
        modelType: v.model?.type ?? f.type ?? null,
        name,
        bytes,
        received: 0,
        speed: 0,
        status: 'downloading',
        note: null, // "bağlantı koptu, tekrar deneniyor…" while retrying
        error: null,
        startedAt: Date.now(),
        // Everything needed to resume after a restart, without asking Civitai again.
        meta: {
          url: url.href,
          sha256: f.hashes?.SHA256 ?? null,
          cover: cover?.url ?? null,
          trainedWords: v.trainedWords ?? [],
          baseModel: v.baseModel ?? null,
        },
      }
      downloads.set(job.id, job)
      saveJobs()
      runDownload(job)
      res.json(publicJob(job))
    } catch (err) {
      sendError(res, err, 'İndirme başlatılamadı.')
    }
  })

  app.delete('/api/models/downloads/:id', async (req, res) => {
    const job = downloads.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'İndirme bulunamadı.' })
    if (job.status === 'downloading') {
      job.status = 'canceled'
      job.note = null
      job.abort?.abort()
      await fs.rm(path.join(DOWNLOAD_DIR, job.name + '.part'), { force: true })
    } else downloads.delete(job.id)
    saveJobs()
    res.json({ ok: true })
  })

  class Fatal extends Error {} // not worth retrying (no access, bad file…)

  async function hashFile(file, hash) {
    await pipeline(fsSync.createReadStream(file), new Transform({ transform: (c, _e, cb) => (hash.update(c), cb()) }))
  }

  // One attempt: continue the .part from its current size.
  async function downloadOnce(job, signal) {
    const part = path.join(DOWNLOAD_DIR, job.name + '.part')
    const start = (await fs.stat(part).catch(() => null))?.size ?? 0

    // Civitai answers with a redirect to a short-lived signed storage URL —
    // asked for fresh on every attempt. Followed by hand: the API key must
    // go to civitai.com only, and the storage host rejects a second
    // Authorization header.
    const first = await fetch(job.meta.url, { headers: civitaiHeaders(), redirect: 'manual', signal })
    if (first.status === 401 || first.status === 403) throw new Fatal('Erişim yok — bu sürüm erken erişimde / ücretli olabilir ya da giriş istiyor.')
    if (first.status === 404) throw new Fatal('Civitai dosyayı bulamadı (kaldırılmış olabilir).')
    let res = first
    if (first.status >= 300 && first.status < 400) {
      const loc = first.headers.get('location')
      if (!loc) throw new Error('Civitai yönlendirmesi eksik.')
      res = await fetch(new URL(loc, job.meta.url), { headers: start > 0 ? { Range: `bytes=${start}-` } : {}, signal })
    }
    if (res.status === 401 || res.status === 403) throw new Fatal('Erişim yok — bu sürüm erken erişimde / ücretli olabilir ya da giriş istiyor.')
    if (res.status === 416 && start > 0) return part // already complete
    if (!res.ok || !res.body) throw new Error(`Civitai ${res.status}`)
    if ((res.headers.get('content-type') || '').startsWith('text/html')) throw new Fatal('Civitai dosya yerine bir sayfa döndürdü (erişim yok olabilir).')

    const resumed = res.status === 206 && start > 0
    if (start > 0) console.log(`[models] ${job.name}: ${resumed ? `resuming at ${(start / 2 ** 20).toFixed(1)} MB` : 'server ignored Range, starting over'} (HTTP ${res.status})`)
    const len = Number(res.headers.get('content-length'))
    if (len > 0) job.bytes = (resumed ? start : 0) + len
    job.received = resumed ? start : 0
    job.samples = []
    job.note = null
    saveJobs()
    await pipeline(
      Readable.fromWeb(res.body),
      new Transform({
        transform(chunk, _enc, cb) {
          job.received += chunk.length
          const now = Date.now()
          job.samples.push([now, job.received])
          while (job.samples.length > 2 && now - job.samples[0][0] > 3000) job.samples.shift()
          const [t0, r0] = job.samples[0]
          if (now > t0) job.speed = Math.round(((job.received - r0) * 1000) / (now - t0))
          cb(null, chunk)
        },
      }),
      // A 200 (server ignored Range) means a full body: overwrite.
      fsSync.createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
      { signal },
    )
    return part
  }

  async function runDownload(job) {
    const abort = new AbortController()
    job.abort = abort
    const signal = abort.signal
    const part = path.join(DOWNLOAD_DIR, job.name + '.part')
    const final = path.join(DOWNLOAD_DIR, job.name)
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await downloadOnce(job, signal)
          break
        } catch (err) {
          if (signal.aborted || err instanceof Fatal || attempt >= MAX_ATTEMPTS) throw err
          job.speed = 0
          const wait = Math.min(60, 5 * 2 ** (attempt - 1))
          job.note = `Bağlantı koptu, ${wait} sn sonra kaldığı yerden devam (${attempt}/${MAX_ATTEMPTS - 1})`
          saveJobs()
          console.error('[models] download interrupted', job.name, err.message)
          await new Promise((r) => {
            const t = setTimeout(r, wait * 1000)
            signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
          })
          if (signal.aborted) throw err
        }
      }

      job.speed = 0
      job.note = 'Doğrulanıyor…'
      if (job.meta.sha256) {
        const hash = crypto.createHash('sha256')
        await hashFile(part, hash)
        if (hash.digest('hex').toLowerCase() !== job.meta.sha256.toLowerCase()) {
          await fs.rm(part, { force: true })
          throw new Fatal('Dosya bozuk indi (SHA256 tutmuyor) — tekrar indir.')
        }
      }
      if (await exists(final)) throw new Fatal('Aynı adlı dosya bu arada oluştu.')
      await fs.rename(part, final)

      // Side files: the Civitai cover as the thumbnail, and the trigger words
      // in the .json the LoRA tools (and rgthree) read.
      const base = path.join(DOWNLOAD_DIR, stripModelExt(job.name))
      if (job.meta.cover) {
        try {
          const img = await fetch(job.meta.cover.replace('/original=true/', '/width=768/'), { signal: AbortSignal.timeout(30000) })
          if (img.ok) await writePreviewJpeg(base, Buffer.from(await img.arrayBuffer()))
        } catch {
          // a missing thumbnail isn't worth failing the download over
        }
      }
      await fs.writeFile(
        base + '.json',
        JSON.stringify(
          {
            description: '',
            'sd version': job.meta.baseModel ?? 'Unknown',
            'activation text': job.meta.trainedWords.join(', '),
            'preferred weight': 0,
            'negative text': '',
            notes: `https://civitai.com/models/${job.modelId}?modelVersionId=${job.versionId}`,
            civitai: { modelId: job.modelId, versionId: job.versionId, fileId: job.fileId, baseModel: job.meta.baseModel, type: job.modelType },
          },
          null,
          4,
        ),
      )
      job.status = 'done'
      job.note = null
      job.received = job.bytes
    } catch (err) {
      if (job.status !== 'canceled') {
        job.status = 'error'
        job.note = null
        job.error = err.message
        console.error('[models] download failed', job.name, err.message)
        // A fatal answer can't be resumed — don't leave the partial behind.
        if (err instanceof Fatal) await fs.rm(part, { force: true })
      } else {
        // The DELETE handler removed it too, but the write stream may still
        // have flushed after that.
        await fs.rm(part, { force: true })
      }
    } finally {
      job.speed = 0
      saveJobs()
      invalidate()
    }
  }

  // Pick up where the last run stopped: unfinished jobs resume, .part files
  // nobody owns any more are cleared.
  {
    let saved = []
    try {
      saved = JSON.parse(fsSync.readFileSync(JOBS_PATH, 'utf8'))
    } catch {
      // first run / unreadable — nothing to resume
    }
    for (const j of Array.isArray(saved) ? saved : []) {
      if (!j?.id || !j.meta?.url) continue
      if (j.status === 'done' && Date.now() - j.startedAt > 7 * 24 * 3600_000) continue
      downloads.set(j.id, { ...j, speed: 0 })
    }
    const owned = new Set([...downloads.values()].filter((j) => j.status === 'downloading').map((j) => j.name + '.part'))
    for (const n of fsSync.readdirSync(DOWNLOAD_DIR)) if (n.endsWith('.part') && !owned.has(n)) fsSync.rmSync(path.join(DOWNLOAD_DIR, n), { force: true })
    for (const j of downloads.values()) {
      if (j.status !== 'downloading') continue
      j.note = 'Panel yeniden başladı — kaldığı yerden devam ediyor'
      try {
        j.received = fsSync.statSync(path.join(DOWNLOAD_DIR, j.name + '.part')).size
      } catch {
        j.received = 0
      }
      runDownload(j)
    }
  }

  // --- Move / delete -------------------------------------------------------

  async function resolveModelFile(area, rel) {
    const root = areaRoot(area)
    const full = await resolveSafeRealPath(root, rel)
    if (!MODEL_EXT.has(path.extname(full).toLowerCase())) throw new HttpError(400, 'Model dosyası değil.')
    return full
  }

  async function moveFile(from, to) {
    try {
      await fs.rename(from, to)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      await fs.copyFile(from, to)
      await fs.rm(from)
    }
  }

  app.post('/api/models/move', async (req, res) => {
    try {
      const { area, path: rel, toDir, inUse } = req.body ?? {}
      const full = await resolveModelFile(area, rel)
      const locked = protectedBy(area, rel, inUse)
      if (locked) throw new HttpError(409, `${locked.join(', ')} sekmesi bu modeli kullanıyor — taşınamaz.`)
      const dirRel = String(toDir ?? '').replace(/^\/+|\/+$/g, '')
      if (!dirRel || dirRel.split('/').length > 4) throw new HttpError(400, 'Geçersiz hedef klasör.')
      const top = dirRel.split('/')[0]
      if (!(await exists(path.join(MODELS_ROOT, top)))) throw new HttpError(400, `models/${top} diye bir klasör yok.`)
      if (dirRel.split('/').some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) throw new HttpError(400, 'Geçersiz klasör adı.')
      const targetDir = resolveSafePath(MODELS_ROOT, dirRel)
      await fs.mkdir(targetDir, { recursive: true })
      const target = path.join(targetDir, path.basename(full))
      if (target === full) throw new HttpError(400, 'Dosya zaten orada.')
      if (await exists(target)) throw new HttpError(409, 'Hedefte aynı adlı bir dosya var.')
      const sides = await sidecarsOf(full)
      await moveFile(full, target)
      for (const s of sides) {
        const t = path.join(targetDir, path.basename(s))
        if (!(await exists(t))) await moveFile(s, t)
      }
      invalidate()
      res.json({ ok: true, path: path.relative(MODELS_ROOT, target).split(path.sep).join('/') })
    } catch (err) {
      sendError(res, err, 'Taşınamadı.')
    }
  })

  app.post('/api/models/delete', async (req, res) => {
    try {
      const { area, path: rel, inUse } = req.body ?? {}
      const full = await resolveModelFile(area, rel)
      const locked = protectedBy(area, rel, inUse)
      if (locked) throw new HttpError(409, `${locked.join(', ')} sekmesi bu modeli kullanıyor — silinemez.`)
      for (const s of await sidecarsOf(full)) await fs.rm(s, { force: true })
      await fs.rm(full)
      invalidate()
      res.json({ ok: true })
    } catch (err) {
      sendError(res, err, 'Silinemedi.')
    }
  })

  // --- Preview picture ------------------------------------------------------

  async function writePreviewJpeg(basePath, buffer) {
    const jpeg = await sharp(buffer).rotate().resize(768, 768, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer()
    // One picture per model: drop the other names rgthree might pick first.
    for (const s of PREVIEW_SUFFIXES) if (s !== '.jpg') await fs.rm(basePath + s, { force: true })
    await fs.writeFile(basePath + '.jpg', jpeg)
  }

  function previewBase(full) {
    return path.join(path.dirname(full), stripModelExt(path.basename(full)))
  }

  app.get('/api/models/preview', async (req, res) => {
    try {
      const full = await resolveModelFile(req.query.area, req.query.path)
      const p = await findPreview(full)
      if (!p) throw new HttpError(404, 'Resim yok.')
      res.set('Cache-Control', 'private, max-age=86400')
      res.sendFile(p)
    } catch (err) {
      sendError(res, err, 'Resim yok.')
    }
  })

  // Raw image body (phone upload / paste).
  app.post('/api/models/preview', express.raw({ type: 'image/*', limit: '40mb' }), async (req, res) => {
    try {
      const full = await resolveModelFile(req.query.area, req.query.path)
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Görsel yok.')
      await writePreviewJpeg(previewBase(full), req.body)
      invalidate()
      res.json({ ok: true })
    } catch (err) {
      sendError(res, err, 'Resim eklenemedi (görsel okunamadı).')
    }
  })

  // From a Civitai image (the model page's pictures) or a Galeri file.
  app.post('/api/models/preview-from', async (req, res) => {
    try {
      const { area, path: rel, url, source, name } = req.body ?? {}
      const full = await resolveModelFile(area, rel)
      let buffer
      if (url) {
        let u
        try {
          u = new URL(String(url))
        } catch {
          throw new HttpError(400, 'Geçersiz adres.')
        }
        if (u.protocol !== 'https:' || u.hostname !== 'image.civitai.com') throw new HttpError(400, 'Sadece Civitai görselleri.')
        const r = await fetch(u.href.replace('/original=true/', '/width=768/'), { signal: AbortSignal.timeout(30000) })
        if (!r.ok) throw new HttpError(502, `Civitai ${r.status}`)
        buffer = Buffer.from(await r.arrayBuffer())
      } else {
        const src = findSource(source)
        buffer = await fs.readFile(await resolveSafeRealPath(src.root, name))
      }
      await writePreviewJpeg(previewBase(full), buffer)
      invalidate()
      res.json({ ok: true })
    } catch (err) {
      sendError(res, err, 'Resim eklenemedi.')
    }
  })
}

function gb(n) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
