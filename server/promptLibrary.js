// Prompt geçmişi + kayıtlı promptlar (the app's 📜 button). History is
// written here, server-side, whenever a job is queued — so it fills itself
// from every device (phone app, a browser on another PC) and survives app
// reinstalls. Saved prompts are the ones starred by hand.
//
// File: server/cache/prompt-library.json
//   { history: { [kind]: [{ text, negative?, at, count }] },
//     saved:   [{ id, kind, text, negative?, name?, at }] }
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'prompt-library.json')
const HISTORY_MAX = 150 // per kind
const SAVED_MAX = 500
const TEXT_MAX = 20_000
const NAME_MAX = 80

let lib = { history: {}, saved: [] }
try {
  const raw = JSON.parse(await fs.readFile(LIB_PATH, 'utf8'))
  if (raw && typeof raw === 'object') {
    lib = {
      history: raw.history && typeof raw.history === 'object' ? raw.history : {},
      saved: Array.isArray(raw.saved) ? raw.saved : [],
    }
  }
} catch {
  // first run
}

let saveQueued = false
function persist() {
  if (saveQueued) return
  saveQueued = true
  setTimeout(() => {
    saveQueued = false
    fs.mkdir(path.dirname(LIB_PATH), { recursive: true })
      .then(() => fs.writeFile(`${LIB_PATH}.tmp`, JSON.stringify(lib)))
      .then(() => fs.rename(`${LIB_PATH}.tmp`, LIB_PATH))
      .catch((err) => console.warn('[output-server] prompt library write failed:', err.message))
  }, 300)
}

function cleanText(v) {
  return typeof v === 'string' ? v.trim().slice(0, TEXT_MAX) : ''
}

// Same prompt + negative = same entry (moved to the top, count +1).
function sameEntry(a, text, negative) {
  return a.text === text && (a.negative || '') === (negative || '')
}

// Called from the queue route with the app's form values for one job.
export function recordPromptHistory(kind, settings) {
  const text = cleanText(settings?.prompt)
  if (!text) return
  const negative = cleanText(settings?.negativePrompt) || undefined
  const list = (lib.history[kind] ??= [])
  const idx = list.findIndex((e) => sameEntry(e, text, negative))
  const prev = idx === -1 ? null : list.splice(idx, 1)[0]
  list.unshift({ text, ...(negative ? { negative } : {}), at: Date.now(), count: (prev?.count ?? 0) + 1 })
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX
  persist()
}

export function registerPromptLibraryRoutes(app, kinds) {
  const kindOf = (v) => (kinds.includes(v) ? v : null)

  app.get('/api/prompts', (req, res) => {
    const kind = kindOf(req.query.kind)
    if (!kind) return res.status(400).json({ error: 'Bilinmeyen tür.' })
    res.set('Cache-Control', 'no-store')
    res.json({ history: lib.history[kind] ?? [], saved: lib.saved.filter((s) => s.kind === kind) })
  })

  app.post('/api/prompts/saved', (req, res) => {
    const kind = kindOf(req.body?.kind)
    const text = cleanText(req.body?.text)
    if (!kind) return res.status(400).json({ error: 'Bilinmeyen tür.' })
    if (!text) return res.status(400).json({ error: 'Prompt boş.' })
    const negative = cleanText(req.body?.negative) || undefined
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, NAME_MAX) : ''
    const existing = lib.saved.find((s) => s.kind === kind && sameEntry(s, text, negative))
    if (existing) {
      if (name) existing.name = name
      persist()
      return res.json(existing)
    }
    if (lib.saved.length >= SAVED_MAX) return res.status(400).json({ error: `En fazla ${SAVED_MAX} kayıtlı prompt olabilir.` })
    const item = { id: crypto.randomUUID(), kind, text, ...(negative ? { negative } : {}), ...(name ? { name } : {}), at: Date.now() }
    lib.saved.unshift(item)
    persist()
    res.json(item)
  })

  app.delete('/api/prompts/saved/:id', (req, res) => {
    lib.saved = lib.saved.filter((s) => s.id !== req.params.id)
    persist()
    res.json({ ok: true })
  })

  // Body: { kind, text, negative? } drops that one entry; { kind, all: true }
  // clears the kind's whole history.
  app.post('/api/prompts/history/delete', (req, res) => {
    const kind = kindOf(req.body?.kind)
    if (!kind) return res.status(400).json({ error: 'Bilinmeyen tür.' })
    if (req.body?.all === true) lib.history[kind] = []
    else {
      const text = cleanText(req.body?.text)
      const negative = cleanText(req.body?.negative) || undefined
      lib.history[kind] = (lib.history[kind] ?? []).filter((e) => !sameEntry(e, text, negative))
    }
    persist()
    res.json({ ok: true })
  })
}
