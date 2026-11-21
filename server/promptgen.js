// Prompt generator (the ✨ button on every tab's Prompt box): the user
// describes what they want, a local LLM (llama-swap) writes the prompt in
// the target model's own style, and the user can ask for revisions.
//
// The LLM and ComfyUI share one 16 GB GPU, so a run is a little dance, done
// here on the PC as a job the phone polls (it may lock meanwhile):
//   1. hold the queue dispatcher (no new ComfyUI job may start) and wait for
//      a running one to finish
//   2. ComfyUI /free — unload its models (the next generation reloads them)
//   3. chat with PROMPT_MODEL (llama-swap starts it on demand)
//   4. unload it again — unless it (or the OpenWebUI coder sharing its GPU
//      group) was already running before: then it's someone's chat, left as is
//   5. release the dispatcher
//
// PROMPT_MODEL is a llama-swap entry made for this (see
// ~/Desktop/ai-stack/config/llama-swap.yml "qwen-prompt"): the same 27B as
// OpenWebUI's qwen-coder but with an 8k context and reasoning off — the 90k
// context doesn't fit next to ComfyUI's idle CUDA context, and thinking only
// makes a prompt slower, not better.
import crypto from 'node:crypto'

const PROMPT_MODEL = process.env.PROMPT_LLM_MODEL || 'qwen-prompt'
// Already loaded instead (same GPU group): use it rather than evicting it.
const SHARED_MODELS = (process.env.PROMPT_LLM_SHARED || 'qwen-coder').split(',').filter(Boolean)
const TARGETS = new Set(['sdxl', 'krea2', 'anime2real', 'video'])
const MAX_WAIT_FOR_COMFY_MS = 15 * 60 * 1000

// Strip what a chat model wraps an answer in: thinking blocks, code fences,
// a leading "Prompt:" label, surrounding quotes.
function cleanOutput(text) {
  let t = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i)
  if (fence) t = fence[1].trim()
  // The SDXL instruction has the model translate the request first
  // ("EN: …" line) — it reasons better from English; not part of the prompt.
  t = t.replace(/^\s*EN:[^\n]*\n+/, '').trim()
  t = t.replace(/^(prompt|positive prompt|output)\s*:\s*/i, '').trim()
  if (/^".*"$/s.test(t)) t = t.slice(1, -1).trim()
  return t
}

export function registerPromptGenRoutes(app, { HttpError, sendError, llamaSwapFetch, comfyUrl }) {
  let current = null // the one job (only one at a time — one GPU)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function comfyBusy() {
    try {
      const q = await (await fetch(`${comfyUrl}/queue`, { signal: AbortSignal.timeout(3000) })).json()
      return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0) > 0
    } catch {
      return false // ComfyUI down: nothing to wait for or free
    }
  }

  async function runningModels() {
    try {
      const r = await llamaSwapFetch('/running', {}, 5000)
      return ((await r.json())?.running ?? []).map((x) => x.model)
    } catch {
      return []
    }
  }

  async function run(job) {
    try {
      const until = Date.now() + MAX_WAIT_FOR_COMFY_MS
      let model
      let wasLoaded
      // Loops back if a ComfyUI job slipped in anyway: a dispatcher tick
      // already past its hold check can still POST one after we looked.
      for (;;) {
        job.stage = 'waiting'
        while (await comfyBusy()) {
          if (job.canceled) throw new Error('İptal edildi.')
          if (Date.now() > until) throw new Error('ComfyUI 15 dakikadır meşgul — sonra tekrar dene.')
          await sleep(2000)
        }
        if (job.canceled) throw new Error('İptal edildi.')

        const before = await runningModels()
        model = SHARED_MODELS.find((m) => before.includes(m)) ?? PROMPT_MODEL
        wasLoaded = before.includes(model)
        if (!wasLoaded) {
          job.stage = 'freeing'
          await fetch(`${comfyUrl}/free`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
            signal: AbortSignal.timeout(30000),
          }).catch(() => {})
          await sleep(1500) // let CUDA actually hand the memory back
        }
        if (!(await comfyBusy())) break
      }

      if (job.canceled) throw new Error('İptal edildi.')
      job.stage = wasLoaded ? 'generating' : 'loading'
      const loadTimer = setInterval(async () => {
        if (job.stage === 'loading' && (await runningModels()).includes(model)) job.stage = 'generating'
      }, 1500)
      let res
      try {
        res = await llamaSwapFetch(
          '/v1/chat/completions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The shared OpenWebUI model thinks first (reasoning_effort
            // medium) and its thinking counts against max_tokens — give it
            // room, or it can spend the budget before writing anything.
            body: JSON.stringify({
              model,
              messages: job.messages,
              max_tokens: model !== PROMPT_MODEL ? 6000 : job.target === 'video' ? 1500 : 600,
              temperature: 0.7,
            }),
          },
          10 * 60 * 1000,
        )
      } finally {
        clearInterval(loadTimer)
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error?.message || body?.error || `LLM ${res.status}`)
      const choice = body?.choices?.[0]
      const text = cleanOutput(choice?.message?.content)
      if (!text)
        throw new Error(
          choice?.finish_reason === 'length' ? 'Model cevabı bitiremeden sınıra takıldı (düşünmeye harcadı) — tekrar dene.' : 'Model boş cevap verdi.',
        )
      job.result = text

      if (!wasLoaded) {
        job.stage = 'unloading'
        await llamaSwapFetch(`/api/models/unload/${encodeURIComponent(model)}`, { method: 'POST' }, 30000).catch(() => {})
      }
      job.status = 'done'
    } catch (err) {
      job.status = 'error'
      job.error = err.message || String(err)
      // Don't leave the 13 GB model holding the GPU after a failure.
      const now = await runningModels()
      if (now.includes(PROMPT_MODEL)) await llamaSwapFetch(`/api/models/unload/${encodeURIComponent(PROMPT_MODEL)}`, { method: 'POST' }, 30000).catch(() => {})
    } finally {
      job.stage = null
      job.finishedAt = Date.now()
    }
  }

  const publicJob = ({ messages: _m, canceled: _c, ...j }) => j

  // { target, system, request, previous?, feedback? } — `previous` +
  // `feedback` make it a revision of the last answer.
  app.post('/api/promptgen', (req, res) => {
    try {
      if (current && current.status === 'running') throw new HttpError(409, 'Zaten bir prompt üretiliyor.')
      const { target, system, request, previous, feedback, context } = req.body ?? {}
      if (!TARGETS.has(target)) throw new HttpError(400, 'Geçersiz sekme.')
      const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
      const sys = str(system, 8000)
      const ask = str(request, 4000)
      if (!sys || !ask) throw new HttpError(400, 'İstek boş.')
      const ctx = str(context, 1000)
      const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: ctx ? `${ask}\n\n(${ctx})` : ask },
      ]
      const prev = str(previous, 12000)
      const fb = str(feedback, 4000)
      if (prev && fb) {
        messages.push({ role: 'assistant', content: prev })
        messages.push({
          role: 'user',
          content: `Revise the prompt above: ${fb}\nKeep everything else that wasn't asked to change. Output only the full revised prompt.`,
        })
      }
      current = { id: crypto.randomUUID(), target, status: 'running', stage: 'waiting', result: null, error: null, startedAt: Date.now(), messages }
      run(current)
      res.json(publicJob(current))
    } catch (err) {
      sendError(res, err, 'Prompt üretimi başlatılamadı.')
    }
  })

  app.get('/api/promptgen/:id', (req, res) => {
    if (!current || current.id !== req.params.id) return res.status(404).json({ error: 'İş bulunamadı (panel yeniden başlamış olabilir).' })
    res.json(publicJob(current))
  })

  app.delete('/api/promptgen/:id', (req, res) => {
    if (current?.id === req.params.id && current.status === 'running') current.canceled = true
    res.json({ ok: true })
  })

  // The dispatcher asks this before starting a ComfyUI job.
  return { holdsGpu: () => !!current && current.status === 'running' }
}
