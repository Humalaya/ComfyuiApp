// Which architecture each image text encoder is — read from the
// .safetensors header (the small JSON at the start; never the weights), the
// same way ComfyUI's comfy/sd.py detect_te_model tells them apart. Krea2
// only takes Qwen3-VL-4B and Qwen Image 2.1 only Qwen3-VL-8B; any other file
// loads fine but fails at sampling ("expects 12x2560=30720 features … got
// 2560"), so the app warns before a job is queued. Cached per file until
// its mtime/size changes.
import fs from 'node:fs/promises'
import path from 'node:path'

const MODELS_ROOT = path.resolve(process.env.COMFYUI_MODELS_DIR || '/home/emir/Desktop/ComfyUI/models')
const DIR = path.join(MODELS_ROOT, 'text_encoders', 'image')
const cache = new Map() // file -> { mtimeMs, size, arch }

async function readHeader(file) {
  const fh = await fs.open(file, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    await fh.read(lenBuf, 0, 8, 0)
    const len = Number(lenBuf.readBigUInt64LE(0))
    if (!len || len > 64 * 1024 * 1024) return null
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 8)
    return JSON.parse(buf.toString('utf8'))
  } finally {
    await fh.close()
  }
}

// 'qwen3vl_4b' | 'qwen3vl_8b' | 'qwen3vl_2b' | 'qwen35_4b' | … | 'unknown'
export function archOf(header) {
  const shape = (k) => header?.[k]?.shape
  const ln = shape('model.language_model.layers.0.input_layernorm.weight')
  if (header['model.language_model.layers.0.linear_attn.A_log'] && ln) {
    return { 1024: 'qwen35_08b', 2560: 'qwen35_4b', 4096: 'qwen35_9b', 5120: 'qwen35_27b' }[ln[0]] ?? 'qwen35_2b'
  }
  for (const p of ['model.visual.', 'visual.']) {
    if (header[`${p}deepstack_merger_list.0.norm.weight`]) {
      const out = shape(`${p}merger.linear_fc2.weight`)?.[0]
      return { 2048: 'qwen3vl_2b', 2560: 'qwen3vl_4b' }[out] ?? 'qwen3vl_8b'
    }
  }
  return 'unknown'
}

export function registerTextEncoderRoutes(app) {
  // [{ name: 'image/x.safetensors' (ComfyUI's clip_name), arch }]
  app.get('/api/text-encoders', async (_req, res) => {
    try {
      const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.safetensors'))
      const out = []
      for (const f of files) {
        const full = path.join(DIR, f)
        const st = await fs.stat(full)
        let hit = cache.get(full)
        if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
          let arch = 'unknown'
          try {
            const header = await readHeader(full)
            if (header) arch = archOf(header)
          } catch {
            // unreadable — left unknown
          }
          hit = { mtimeMs: st.mtimeMs, size: st.size, arch }
          cache.set(full, hit)
        }
        out.push({ name: `image/${f}`, arch: hit.arch })
      }
      res.json(out)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}
