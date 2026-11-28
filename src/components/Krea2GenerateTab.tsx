import { useEffect, useRef, useState } from 'react'
import { mergeLoras, type LoraAdd } from '../workflow/loraMerge'
import { NumberField } from './NumberField'
import { ModelSelect } from './ModelSelect'
import { archLabel, useTextEncoderArchs } from '../api/textEncoderClient'
import { LoraList } from './LoraList'
import { GenerationPreview } from './GenerationPreview'
import { ResultCarousel } from './ResultCarousel'
import { GenerationFullscreenViewer } from './GenerationFullscreenViewer'
import { CollapsibleSection } from './CollapsibleSection'
import { HelpTip } from './HelpTip'
import { randomSeed, SeedField } from './SeedField'
import { modelLabel } from '../utils/modelLabel'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useImageGeneration } from '../hooks/useImageGeneration'
import { buildKrea2Workflow, getDefaultKrea2Settings, KREA2_OUTPUT_NODE_ID, type Krea2GenerationSettings } from '../workflow/krea2FieldMap'
import type { LoraSlot } from '../workflow/fieldMap'
import { loadKrea2Settings, normalizeKrea2Settings, saveKrea2Settings } from '../storage/krea2SettingsStorage'
import { appendTriggerWords } from '../utils/promptText'
import { useRemoteQueue } from '../storage/remoteQueueStorage'
import { PromptGenerator } from './PromptGenerator'
import { canvasContext } from '../workflow/promptGenPresets'

// This kind's key in the output-server's shared /api/state/:kind/* store —
// see remoteQueueStorage.ts for why that's PC RAM now, not phone localStorage.
const KIND = 'krea2'

// Kept small — a "what finished recently" log, not a real history feature.
// Same rationale as App.tsx's/ImageGenerateTab.tsx's identical constant.
const MAX_COMPLETED_RESULTS = 20

// One flat entry per *file*, not per job — see App.tsx's identical
// CompletedItem for the full rationale.
interface CompletedItem {
  promptId: string
  url: string
  createdAt: number
}

interface Props {
  // Pushed from App.tsx when Galeri's "Ayarları Gönder" targets this tab —
  // see ImageGenerateTab.tsx's identical prop for the full rationale.
  importRequest?: { settings: Partial<Krea2GenerationSettings>; id: number; addLoras?: LoraAdd[] } | null
}

// Krea2 (FLUX) Text2Img — a completely different pipeline from the SDXL one
// in ImageGenerateTab.tsx (UNETLoader instead of CheckpointLoaderSimple, a
// two-pass Clownshark sampler instead of a plain KSampler, no cfg/steps/
// checkpoint exposed here since this workflow's two sampling passes each
// have their own fixed step count/cfg by design — see krea2FieldMap.ts).
// Same queueing pattern as the SDXL tab (batchCount queues N separate jobs
// on top of ComfyUI's own batchSize) — see ImageGenerateTab.tsx for the full
// rationale, this mirrors it exactly.
export function Krea2GenerateTab({ importRequest }: Props) {
  const [settings, setSettings] = useState<Krea2GenerationSettings>(
    () => loadKrea2Settings() ?? { ...getDefaultKrea2Settings(), seed: randomSeed() },
  )
  // Server-run queue, same as the SDXL tab — see ImageGenerateTab.tsx.
  const { queue, comfyUp, queueError, append, remove, dismissError } = useRemoteQueue(KIND, normalizeKrea2Settings)
  const [completedResults, setCompletedResults] = useState<CompletedItem[]>([])
  // The url of the item GenerationFullscreenViewer has open — null means
  // closed. Tracked by url, not a plain index into completedResults: a new
  // job can finish (and get unshifted onto the front of that array) while
  // the viewer stays open, since it's a pure display layer that never pauses
  // the queue — a plain index would then silently point at a different,
  // newer item the moment that happened.
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const objectInfo = useObjectInfo()
  const encoderArchs = useTextEncoderArchs(objectInfo.imageClipNames.join('|'))
  // The text encoder must be Qwen3-VL 4B — another one loads but fails at sampling.
  const encoderNote = (name: string) =>
    !encoderArchs[name] ? '' : encoderArchs[name] === 'qwen3vl_4b' ? '✓ uyumlu' : `✗ Krea2 ile uyumsuz (${archLabel(encoderArchs[name])})`
  const encoderWrong = !!encoderArchs[settings.clipName] && encoderArchs[settings.clipName] !== 'qwen3vl_4b'
  const gen = useImageGeneration(KREA2_OUTPUT_NODE_ID, KIND)

  useEffect(() => {
    const timer = setTimeout(() => saveKrea2Settings(settings), 400)
    return () => clearTimeout(timer)
  }, [settings])

  // Collects each finished result into the "recently finished" strip. The
  // queue itself advances on the server (see remoteQueueStorage.ts).
  const lastCollected = useRef(0)
  useEffect(() => {
    if (gen.settledCount === lastCollected.current) return
    lastCollected.current = gen.settledCount
    if (gen.status === 'done' && gen.result) {
      const { promptId, urls, createdAt } = gen.result
      const items: CompletedItem[] = urls.map((url) => ({ promptId, url, createdAt }))
      setCompletedResults((list) => [...items, ...list].slice(0, MAX_COMPLETED_RESULTS))
    }
  }, [gen.settledCount, gen.status, gen.result])

  // See the importRequest prop's own comment (and ImageGenerateTab.tsx's
  // identical effect) — reacts only to `id` changing.
  useEffect(() => {
    if (!importRequest) return
    setSettings((s) => {
      const next = { ...s, ...importRequest.settings }
      return importRequest.addLoras ? { ...next, loras: mergeLoras(next.loras, importRequest.addLoras).loras } : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRequest?.id])

  // Same self-correcting pattern as the video tab's Model dropdown and the
  // SDXL tab's Checkpoint dropdown — a persisted unetName can go stale (file
  // renamed/removed, or from before this dropdown existed at all) in a way
  // that would otherwise fail silently at generation time instead of here,
  // where it's actually visible.
  useEffect(() => {
    if (objectInfo.krea2UnetNames.length === 0) return
    if (!objectInfo.krea2UnetNames.includes(settings.unetName)) {
      update('unetName', objectInfo.krea2UnetNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectInfo.krea2UnetNames])

  function update<K extends keyof Krea2GenerationSettings>(key: K, value: Krea2GenerationSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
  }

  function updateLora(index: number, slot: LoraSlot) {
    setSettings((s) => {
      const loras = [...s.loras]
      loras[index] = slot
      return { ...s, loras }
    })
  }

  const isBusy = gen.status === 'running' || queue.length > 0
  const canGenerate = settings.prompt.trim().length > 0

  const [submitting, setSubmitting] = useState(false)

  async function handleGenerate() {
    // batchSize (real ComfyUI batch_size) and batchCount (queues this many
    // separate jobs) stack rather than substitute for one another — same
    // rationale as ImageGenerateTab.tsx's identical handleGenerate.
    const count = Math.max(1, Math.round(settings.batchCount))
    const items: Krea2GenerationSettings[] = []
    for (let i = 0; i < count; i++) {
      items.push(settings.fixedSeed ? settings : { ...settings, seed: randomSeed() })
    }
    if (!settings.fixedSeed) setSettings((s) => ({ ...s, seed: items[items.length - 1].seed }))
    setSubmitting(true)
    try {
      // Built here (the app owns the workflow templates); the server only
      // runs them, one at a time, starting right away if ComfyUI is idle.
      await append(items.map((s) => ({ settings: s, workflow: buildKrea2Workflow(s) })))
      gen.checkRemoteJob()
    } catch (err) {
      alert(`Kuyruğa eklenemedi: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Shared by the compact strip (running), the full strip (done), and
  // GenerationFullscreenViewer.
  const historyUrls = completedResults.map((r) => r.url)

  return (
    <div className="form">
      {/* At the top: reachable without scrolling past the whole form. */}
      <button type="button" className="generate-button" disabled={!canGenerate || submitting || encoderWrong} onClick={handleGenerate}>
        {isBusy
          ? '+ Kuyruğa Ekle'
          : settings.batchSize * settings.batchCount > 1
            ? `Oluştur · ${settings.batchSize * settings.batchCount}`
            : 'Oluştur'}
      </button>

      {encoderWrong && (
        <div className="status-warning">
          ⚠ Seçili metin kodlayıcı {archLabel(encoderArchs[settings.clipName])} — Krea2 yalnızca Qwen3-VL 4B ile çalışır (başka bir
          kodlayıcı yüklenir ama örneklemede hata verir). Gelişmiş Ayarlar → Metin kodlayıcı'dan "✓ uyumlu" olanı seç.
        </div>
      )}

      {/* Output first, form fields below — so the current job's progress or
          result is visible the moment this tab opens, without scrolling past
          the whole form to find out whether anything even finished. */}
      {queueError && (
        <div className="status-warning">
          {queueError.message}
          <button type="button" className="secondary-button" onClick={dismissError}>
            Tamam
          </button>
        </div>
      )}

      {queue.length > 0 && (
        <div className="queue-panel">
          <div className="queue-title">Kuyrukta {queue.length} iş bekliyor</div>
          {!comfyUp && <div className="status-warning">⚠ ComfyUI'ye ulaşılamıyor — ulaşılınca kuyruk kendiliğinden devam edecek.</div>}
          {queue.map((entry, i) => (
            <div className="queue-item" key={entry.id}>
              <span className="queue-item-label">
                {i + 1}. {entry.settings.prompt.trim() || '(prompt yok)'}
              </span>
              <button type="button" className="queue-item-remove" onClick={() => remove(entry.id)} aria-label="Kuyruktan çıkar">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {gen.status === 'running' && (
        <div className="status-panel">
          <div className="status-panel-header-row">
            <div className="status-title">Oluşturuluyor…</div>
            <ResultCarousel urls={historyUrls} kind="image" onOpen={setViewerUrl} compact />
          </div>
          <GenerationPreview previewUrl={gen.previewUrl} progress={gen.samplingProgress} />
          <div className="status-row">
            <span>Geçen süre</span>
            <span>{gen.elapsedSeconds} sn</span>
          </div>
          <button type="button" className="generate-button generate-button-cancel" onClick={() => gen.cancel()}>
            İptal Et
          </button>
        </div>
      )}

      {gen.status === 'error' && (
        <div className="status-panel status-panel-error">
          <div className="status-title">Hata</div>
          <div className="field-error">{gen.error}</div>
        </div>
      )}

      {gen.status === 'done' && gen.result && (
        <div className="status-panel status-panel-done">
          <div className="status-title">✓ Üretim Tamamlandı</div>
          {gen.totalElapsedSeconds !== null && <div className="status-row">Toplam süre: {gen.totalElapsedSeconds} sn</div>}
          <ResultCarousel key={gen.result.promptId} urls={historyUrls} kind="image" onOpen={setViewerUrl} />
        </div>
      )}

      <div className="field">
        <div className="field-label" id="krea2-prompt-label">
          Prompt
          <PromptGenerator
            library={{ kind: 'krea2', prompt: settings.prompt, onUse: (p) => update('prompt', p.prompt) }}
            target="krea2"
            context={canvasContext(settings.width, settings.height)}
            onUse={(text) => update('prompt', text)}
          />
        </div>
        <textarea
          aria-labelledby="krea2-prompt-label"
          className="prompt-textarea"
          rows={6}
          value={settings.prompt}
          onChange={(e) => update('prompt', e.target.value)}
          placeholder="Görselde ne olmasını istediğini yaz…"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="krea2-genislik">
            Genişlik
          </label>
          <NumberField id="krea2-genislik" min={64} max={4096} step={64} value={settings.width} onChange={(v) => update('width', v)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="krea2-yukseklik">
            Yükseklik
          </label>
          <NumberField id="krea2-yukseklik" min={64} max={4096} step={64} value={settings.height} onChange={(v) => update('height', v)} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="krea2-adim-1-gecis">
            Adım · 1. geçiş
            <HelpTip>
              Bu workflow iki geçişli çalışıyor: ilki kaba yapıyı oluşturuyor, ikincisi düşük denoise ile inceliyor. Adımlar ayrı ayrı
              ayarlanabiliyor.
            </HelpTip>
          </label>
          <NumberField id="krea2-adim-1-gecis" min={1} max={60} step={1} value={settings.steps1} onChange={(v) => update('steps1', v)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="krea2-adim-2-gecis">
            Adım · 2. geçiş
          </label>
          <NumberField id="krea2-adim-2-gecis" min={1} max={30} step={1} value={settings.steps2} onChange={(v) => update('steps2', v)} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="krea2-batch-size">
            Batch Size
            <HelpTip>
              <b>Batch Size:</b> tek işte kaç görsel üretileceği. <b>Batch Count:</b> kaç ayrı işin art arda kuyruğa ekleneceği. İkisi
              çarpılır — 4 × 3 = 3 iş, her birinde 4 görsel.
            </HelpTip>
          </label>
          <NumberField id="krea2-batch-size" min={1} max={8} step={1} value={settings.batchSize} onChange={(v) => update('batchSize', v)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="krea2-batch-count">
            Batch Count
          </label>
          <NumberField
            id="krea2-batch-count"
            min={1}
            max={20}
            step={1}
            value={settings.batchCount}
            onChange={(v) => update('batchCount', v)}
          />
        </div>
      </div>

      <SeedField
        seed={settings.seed}
        fixed={settings.fixedSeed}
        onSeedChange={(v) => update('seed', v)}
        onFixedChange={(v) => update('fixedSeed', v)}
      />

      <div className="field">
        <label className="field-label" htmlFor="krea2-model">
          Model
        </label>
        <select
          id="krea2-model"
          value={settings.unetName}
          onChange={(e) => update('unetName', e.target.value)}
          disabled={objectInfo.loading}
        >
          {!objectInfo.krea2UnetNames.includes(settings.unetName) && <option value={settings.unetName}>{settings.unetName}</option>}
          {objectInfo.krea2UnetNames.map((name) => (
            <option key={name} value={name}>
              {modelLabel(name)}
            </option>
          ))}
        </select>
      </div>

      <LoraList
        loras={settings.loras}
        loraNames={objectInfo.loraNames}
        tab="krea2"
        onChange={updateLora}
        onSendToPrompt={(words) => update('prompt', appendTriggerWords(settings.prompt, words))}
      />

      {!objectInfo.loading &&
        !objectInfo.error &&
        (!objectInfo.imageClipNames.includes(settings.clipName) || !objectInfo.imageVaeNames.includes(settings.vaeName)) && (
          <div className="status-warning">
            ⚠ Seçili {!objectInfo.imageClipNames.includes(settings.clipName) ? 'metin kodlayıcı' : 'VAE'} ComfyUI'de yok — Gelişmiş
            Ayarlar'dan var olan birini seç.
          </div>
        )}

      <CollapsibleSection title="Gelişmiş Ayarlar">
        <div className="field">
          <label className="field-label" htmlFor="krea2-clip">
            Metin kodlayıcı
            <HelpTip>
              text_encoders/image klasöründeki dosyalar. Krea2 Qwen3-VL 4B ile eğitildi; farklı boyutta bir kodlayıcı hata verebilir.
            </HelpTip>
          </label>
          <ModelSelect
            id="krea2-clip"
            value={settings.clipName}
            note={encoderNote}
            names={objectInfo.imageClipNames}
            loading={objectInfo.loading}
            onChange={(v) => update('clipName', v)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="krea2-vae">
            VAE
            <HelpTip>vae/image klasöründeki dosyalar.</HelpTip>
          </label>
          <ModelSelect
            id="krea2-vae"
            value={settings.vaeName}
            names={objectInfo.imageVaeNames}
            loading={objectInfo.loading}
            onChange={(v) => update('vaeName', v)}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="krea2-sampler-1">
              Sampler · 1
            </label>
            <select
              id="krea2-sampler-1"
              value={settings.samplerName1}
              onChange={(e) => update('samplerName1', e.target.value)}
              disabled={objectInfo.loading}
            >
              {!objectInfo.krea2SamplerNames.includes(settings.samplerName1) && (
                <option value={settings.samplerName1}>{settings.samplerName1}</option>
              )}
              {objectInfo.krea2SamplerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="krea2-scheduler-1">
              Scheduler · 1
            </label>
            <select
              id="krea2-scheduler-1"
              value={settings.scheduler1}
              onChange={(e) => update('scheduler1', e.target.value)}
              disabled={objectInfo.loading}
            >
              {!objectInfo.schedulerNames.includes(settings.scheduler1) && (
                <option value={settings.scheduler1}>{settings.scheduler1}</option>
              )}
              {objectInfo.schedulerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="krea2-denoise-1">
            Denoise · 1
          </label>
          <NumberField id="krea2-denoise-1" min={0} max={1} step={0.01} value={settings.denoise1} onChange={(v) => update('denoise1', v)} />
        </div>

        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="krea2-sampler-2">
              Sampler · 2
            </label>
            <select
              id="krea2-sampler-2"
              value={settings.samplerName2}
              onChange={(e) => update('samplerName2', e.target.value)}
              disabled={objectInfo.loading}
            >
              {!objectInfo.krea2SamplerNames.includes(settings.samplerName2) && (
                <option value={settings.samplerName2}>{settings.samplerName2}</option>
              )}
              {objectInfo.krea2SamplerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="krea2-scheduler-2">
              Scheduler · 2
            </label>
            <select
              id="krea2-scheduler-2"
              value={settings.scheduler2}
              onChange={(e) => update('scheduler2', e.target.value)}
              disabled={objectInfo.loading}
            >
              {!objectInfo.schedulerNames.includes(settings.scheduler2) && (
                <option value={settings.scheduler2}>{settings.scheduler2}</option>
              )}
              {objectInfo.schedulerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="krea2-denoise-2">
            Denoise · 2
          </label>
          <NumberField id="krea2-denoise-2" min={0} max={1} step={0.01} value={settings.denoise2} onChange={(v) => update('denoise2', v)} />
        </div>
      </CollapsibleSection>

      {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}

      {viewerUrl !== null && (
        <GenerationFullscreenViewer
          items={historyUrls.map((url) => ({ url, kind: 'image' as const }))}
          index={historyUrls.indexOf(viewerUrl)}
          onIndexChange={(i) => setViewerUrl(historyUrls[i] ?? null)}
          onClose={() => setViewerUrl(null)}
        />
      )}
    </div>
  )
}
