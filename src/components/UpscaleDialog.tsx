import { useEffect, useRef, useState } from 'react'
import { extractComboOptions, extractHistoryErrorMessage, getHistory, getObjectInfo, queuePrompt } from '../api/comfyClient'
import type { OutputFile } from '../api/outputsClient'
import { useBackHandler } from '../native/backButton'
import { buildUpscaleWorkflow, modelScale, UPSCALE_FACTORS, type UpscaleFactor } from '../workflow/upscale'

interface Props {
  source: string
  item: OutputFile
  // The picture's pixel size, when the viewer has loaded it.
  dims: { width: number; height: number } | null
  onClose: () => void
  // The result landed in the gallery — refresh the listing.
  onDone: () => void
}

const PREFS_KEY = 'upscale-prefs'
const POLL_MS = 2000
const GIVE_UP_MS = 15 * 60_000

function loadPrefs(): { model?: string; factor?: UpscaleFactor } {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function sizeText(dims: Props['dims'], factor: number): string | null {
  return dims ? `${dims.width}×${dims.height} → ${dims.width * factor}×${dims.height * factor}` : null
}

type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; file: string } | { kind: 'error'; message: string }

// "🔍 Büyüt" from Galeri's viewer: picks the upscale model and factor, queues
// the job on ComfyUI and waits for the result.
export function UpscaleDialog({ source, item, dims, onClose, onDone }: Props) {
  useBackHandler(true, onClose)
  const [models, setModels] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [model, setModel] = useState(() => loadPrefs().model ?? '')
  const [factor, setFactor] = useState<UpscaleFactor>(() => (loadPrefs().factor === 4 ? 4 : 2))
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function loadModels() {
    setLoadError(null)
    setModels(null)
    getObjectInfo('UpscaleModelLoader')
      .then((info) => {
        const list = extractComboOptions(info.UpscaleModelLoader, 'model_name')
        setModels(list)
        setModel((m) => (list.includes(m) ? m : (list[0] ?? '')))
      })
      .catch((e: Error) => setLoadError(`ComfyUI'ye ulaşılamadı: ${e.message}`))
  }
  useEffect(loadModels, [])

  async function run() {
    if (!model) return
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ model, factor }))
    } catch {
      // not remembered — fine
    }
    setPhase({ kind: 'running' })
    try {
      const { prompt_id } = await queuePrompt(buildUpscaleWorkflow(source, item.name, model, factor))
      const started = Date.now()
      while (alive.current) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        const entry = (await getHistory(prompt_id))[prompt_id]
        if (entry?.status?.status_str === 'error') throw new Error(extractHistoryErrorMessage(entry))
        if (entry?.status?.completed) {
          const saved = Object.values(entry.outputs).flatMap((o) => (Array.isArray(o.images) ? o.images : []))[0] as
            { filename?: string } | undefined
          onDone()
          if (alive.current) setPhase({ kind: 'done', file: saved?.filename ?? '' })
          return
        }
        if (Date.now() - started > GIVE_UP_MS) throw new Error('15 dakikada bitmedi — ComfyUI kuyruğunu kontrol et.')
      }
    } catch (err) {
      if (alive.current) setPhase({ kind: 'error', message: (err as Error).message })
    }
  }

  const running = phase.kind === 'running'
  const size = sizeText(dims, factor)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Büyüt"
      className="popup-overlay media-action-overlay"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="media-action-menu upscale-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="gallery-lock-title">🔍 Büyüt</div>

        {loadError ? (
          <>
            <div className="field-error">{loadError}</div>
            <button type="button" className="secondary-button" onClick={loadModels}>
              Tekrar dene
            </button>
          </>
        ) : models === null ? (
          <div className="spinner" aria-label="Yükleniyor" />
        ) : models.length === 0 ? (
          <>
            <div className="field-hint">
              Henüz büyütme modeli yok. Bir model dosyasını (ör. <b>4x-UltraSharp.pth</b>) PC'de şu klasöre koy:
            </div>
            <code className="upscale-path">ComfyUI/models/upscale_models/</code>
            <div className="field-hint">ComfyUI'yi yeniden başlatmana gerek yok — koyduktan sonra "Tekrar bak"a dokun.</div>
            <button type="button" className="secondary-button" onClick={loadModels}>
              ↻ Tekrar bak
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label className="field-label" htmlFor="upscale-model">
                Model
              </label>
              <select id="upscale-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m} ({modelScale(m)}×)
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label">Büyütme</span>
              <div className="seg">
                {UPSCALE_FACTORS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={f === factor ? 'seg-btn seg-btn-active' : 'seg-btn'}
                    onClick={() => setFactor(f)}
                    disabled={running}
                  >
                    {f}×
                  </button>
                ))}
              </div>
              {size && <span className="field-hint">{size}</span>}
            </div>
            {phase.kind === 'error' && <div className="field-error">{phase.message}</div>}
            {phase.kind === 'done' ? (
              <>
                <div className="field-hint">
                  ✅ Kaydedildi, aynı klasörde: <b>{phase.file}</b>
                </div>
                <button type="button" className="secondary-button" onClick={onClose}>
                  Tamam
                </button>
              </>
            ) : (
              <>
                <button type="button" className="generate-button" onClick={run} disabled={running || !model}>
                  {running ? (
                    <>
                      <span className="spinner spinner-small" /> Büyütülüyor…
                    </>
                  ) : (
                    `🔍 ${factor}× büyüt`
                  )}
                </button>
                {running && <span className="field-hint">Kapatsan da ComfyUI'de devam eder; sonuç bu klasöre düşer.</span>}
              </>
            )}
          </>
        )}

        {phase.kind !== 'done' && (
          <button type="button" className="secondary-button" onClick={onClose}>
            {running ? 'Kapat' : 'Vazgeç'}
          </button>
        )}
      </div>
    </div>
  )
}
