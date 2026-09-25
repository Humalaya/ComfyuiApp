import { useEffect, useRef, useState } from 'react'
import { NumberField } from './NumberField'
import { LoraList } from './LoraList'
import { GenerationPreview } from './GenerationPreview'
import { ResultCarousel } from './ResultCarousel'
import { GenerationFullscreenViewer } from './GenerationFullscreenViewer'
import { CollapsibleSection } from './CollapsibleSection'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useImageGeneration } from '../hooks/useImageGeneration'
import { buildKrea2Workflow, getDefaultKrea2Settings, KREA2_OUTPUT_NODE_ID, type Krea2GenerationSettings } from '../workflow/krea2FieldMap'
import type { LoraSlot } from '../workflow/fieldMap'
import { loadKrea2Settings, normalizeKrea2Settings, saveKrea2Settings } from '../storage/krea2SettingsStorage'
import { appendTriggerWords } from '../utils/promptText'
import { loadRemoteQueue, saveRemoteQueue } from '../storage/remoteQueueStorage'

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000_000)
}

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
  importRequest?: { settings: Partial<Krea2GenerationSettings>; id: number } | null
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
  // Same queueing pattern as the SDXL tab, backed by the output-server's
  // PC-RAM store — see ImageGenerateTab.tsx's identical block for the full
  // rationale.
  const [queue, setQueue] = useState<Krea2GenerationSettings[]>([])
  const [queueLoaded, setQueueLoaded] = useState(false)
  const [completedResults, setCompletedResults] = useState<CompletedItem[]>([])
  // The url of the item GenerationFullscreenViewer has open — null means
  // closed. Tracked by url, not a plain index into completedResults: a new
  // job can finish (and get unshifted onto the front of that array) while
  // the viewer stays open, since it's a pure display layer that never pauses
  // the queue — a plain index would then silently point at a different,
  // newer item the moment that happened.
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const objectInfo = useObjectInfo()
  const gen = useImageGeneration(buildKrea2Workflow, KREA2_OUTPUT_NODE_ID, KIND)

  useEffect(() => {
    const timer = setTimeout(() => saveKrea2Settings(settings), 400)
    return () => clearTimeout(timer)
  }, [settings])

  useEffect(() => {
    let cancelled = false
    loadRemoteQueue(KIND, normalizeKrea2Settings).then((loaded) => {
      if (cancelled) return
      setQueue(loaded)
      setQueueLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!queueLoaded) return
    saveRemoteQueue(KIND, queue)
  }, [queue, queueLoaded])

  // Drains one queued job at a time — identical design (and identical
  // StrictMode double-invoke guard) to ImageGenerateTab.tsx's queue effect;
  // see the long comment there for the full rationale.
  const lastDrainedKey = useRef<string | null>(null)
  useEffect(() => {
    if (!(gen.status === 'done' || gen.status === 'error' || gen.status === 'idle')) return
    const key = `${gen.status}:${gen.settledCount}`
    if (lastDrainedKey.current === key) return
    lastDrainedKey.current = key

    if (gen.status === 'done' && gen.result) {
      const { promptId, urls, createdAt } = gen.result
      const items: CompletedItem[] = urls.map((url) => ({ promptId, url, createdAt }))
      setCompletedResults((list) => [...items, ...list].slice(0, MAX_COMPLETED_RESULTS))
    }

    if (queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    gen.generate(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.status, gen.settledCount])

  // See the importRequest prop's own comment (and ImageGenerateTab.tsx's
  // identical effect) — reacts only to `id` changing.
  useEffect(() => {
    if (!importRequest) return
    setSettings((s) => ({ ...s, ...importRequest.settings }))
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

  const isBusy = gen.status === 'running'
  const canGenerate = settings.prompt.trim().length > 0

  function handleGenerate() {
    // batchSize (real ComfyUI batch_size) and batchCount (queues this many
    // separate jobs) stack rather than substitute for one another — same
    // rationale as ImageGenerateTab.tsx's identical handleGenerate.
    const count = Math.max(1, Math.round(settings.batchCount))
    const items: Krea2GenerationSettings[] = []
    for (let i = 0; i < count; i++) {
      items.push(settings.fixedSeed ? settings : { ...settings, seed: randomSeed() })
    }
    if (!settings.fixedSeed) setSettings((s) => ({ ...s, seed: items[items.length - 1].seed }))
    if (isBusy) {
      setQueue((q) => [...q, ...items])
    } else {
      const [first, ...rest] = items
      gen.generate(first)
      if (rest.length > 0) setQueue((q) => [...q, ...rest])
    }
  }

  function removeFromQueue(index: number) {
    setQueue((q) => q.filter((_, i) => i !== index))
  }

  // Shared by the compact strip (running), the full strip (done), and
  // GenerationFullscreenViewer.
  const historyUrls = completedResults.map((r) => r.url)

  return (
    <div className="form">
      {/* Output first, form fields below — so the current job's progress or
          result is visible the moment this tab opens, without scrolling past
          the whole form to find out whether anything even finished. */}
      {queue.length > 0 && (
        <div className="queue-panel">
          <div className="queue-title">Kuyrukta {queue.length} iş bekliyor</div>
          {queue.map((item, i) => (
            <div className="queue-item" key={i}>
              <span className="queue-item-label">
                {i + 1}. {item.prompt.trim() || '(prompt yok)'}
              </span>
              <button type="button" className="queue-item-remove" onClick={() => removeFromQueue(i)} aria-label="Kuyruktan çıkar">
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
        <label className="field-label">Model</label>
        <select value={settings.unetName} onChange={(e) => update('unetName', e.target.value)} disabled={objectInfo.loading}>
          {!objectInfo.krea2UnetNames.includes(settings.unetName) && <option value={settings.unetName}>{settings.unetName}</option>}
          {objectInfo.krea2UnetNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label">Prompt</label>
        <textarea
          className="prompt-textarea"
          rows={6}
          value={settings.prompt}
          onChange={(e) => update('prompt', e.target.value)}
          placeholder="Görselde ne olmasını istediğini yaz…"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label">Genişlik</label>
          <NumberField min={64} max={4096} step={64} value={settings.width} onChange={(v) => update('width', v)} />
        </div>
        <div className="field">
          <label className="field-label">Yükseklik</label>
          <NumberField min={64} max={4096} step={64} value={settings.height} onChange={(v) => update('height', v)} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label">Adım Sayısı (1. Geçiş)</label>
          <NumberField min={1} max={60} step={1} value={settings.steps1} onChange={(v) => update('steps1', v)} />
        </div>
        <div className="field">
          <label className="field-label">Adım Sayısı (2. Geçiş)</label>
          <NumberField min={1} max={30} step={1} value={settings.steps2} onChange={(v) => update('steps2', v)} />
        </div>
      </div>
      <span className="field-hint">Bu workflow iki geçişli çalışıyor — ilki kaba yapıyı oluşturuyor, ikincisi düşük denoise ile inceliyor; ayrı ayrı ayarlanabiliyor.</span>

      <div className="field-row">
        <div className="field">
          <label className="field-label">Batch Size</label>
          <NumberField min={1} max={8} step={1} value={settings.batchSize} onChange={(v) => update('batchSize', v)} />
        </div>
        <div className="field">
          <label className="field-label">Batch Count</label>
          <NumberField min={1} max={20} step={1} value={settings.batchCount} onChange={(v) => update('batchCount', v)} />
        </div>
      </div>
      <span className="field-hint">
        {settings.batchCount > 1
          ? `${settings.batchCount} ayrı iş art arda kuyruğa eklenecek, her biri ${settings.batchSize} görsel üretecek (toplam ${settings.batchSize * settings.batchCount} görsel).`
          : settings.batchSize > 1
            ? `${settings.batchSize} görsel tek seferde üretilecek — sonuç kartında hepsi gösterilir, hepsi Galeri'de de görünür.`
            : 'Batch Size: tek işte kaç görsel üretilecek. Batch Count: kaç ayrı iş art arda kuyruğa eklenecek.'}
      </span>

      <div className="field">
        <label className="field-label">Seed</label>
        <div className="seed-row">
          <NumberField value={settings.seed} onChange={(v) => update('seed', v)} />
          <button type="button" className="secondary-button" onClick={() => update('seed', randomSeed())}>
            🎲 Rastgele
          </button>
          <button
            type="button"
            className={settings.fixedSeed ? 'switch switch-on seed-fixed-switch' : 'switch seed-fixed-switch'}
            aria-pressed={settings.fixedSeed}
            onClick={() => update('fixedSeed', !settings.fixedSeed)}
            aria-label="Seed'i sabitle"
          >
            <span className="switch-knob" />
          </button>
        </div>
        <span className="field-hint">{settings.fixedSeed ? 'Sabit — her üretimde aynı seed kullanılır' : 'Rastgele — her üretimde yeni bir seed seçilir'}</span>
      </div>

      <LoraList
        loras={settings.loras}
        loraNames={objectInfo.loraNames}
        onChange={updateLora}
        onSendToPrompt={(words) => update('prompt', appendTriggerWords(settings.prompt, words))}
      />

      <CollapsibleSection title="Gelişmiş Ayarlar">
        <span className="field-hint">Bu workflow iki geçişli olduğu için her ayar da ayrı ayrı — 1. Geçiş ve 2. Geçiş kendi sampler/scheduler/denoise'una sahip.</span>

        <div className="field-row">
          <div className="field">
            <label className="field-label">Sampler (1. Geçiş)</label>
            <select value={settings.samplerName1} onChange={(e) => update('samplerName1', e.target.value)} disabled={objectInfo.loading}>
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
            <label className="field-label">Scheduler (1. Geçiş)</label>
            <select value={settings.scheduler1} onChange={(e) => update('scheduler1', e.target.value)} disabled={objectInfo.loading}>
              {!objectInfo.schedulerNames.includes(settings.scheduler1) && <option value={settings.scheduler1}>{settings.scheduler1}</option>}
              {objectInfo.schedulerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label">Denoise (1. Geçiş)</label>
          <NumberField min={0} max={1} step={0.01} value={settings.denoise1} onChange={(v) => update('denoise1', v)} />
        </div>

        <div className="field-row">
          <div className="field">
            <label className="field-label">Sampler (2. Geçiş)</label>
            <select value={settings.samplerName2} onChange={(e) => update('samplerName2', e.target.value)} disabled={objectInfo.loading}>
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
            <label className="field-label">Scheduler (2. Geçiş)</label>
            <select value={settings.scheduler2} onChange={(e) => update('scheduler2', e.target.value)} disabled={objectInfo.loading}>
              {!objectInfo.schedulerNames.includes(settings.scheduler2) && <option value={settings.scheduler2}>{settings.scheduler2}</option>}
              {objectInfo.schedulerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label">Denoise (2. Geçiş)</label>
          <NumberField min={0} max={1} step={0.01} value={settings.denoise2} onChange={(v) => update('denoise2', v)} />
        </div>
      </CollapsibleSection>

      {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}

      <button type="button" className="generate-button" disabled={!canGenerate} onClick={handleGenerate}>
        {isBusy ? '+ Kuyruğa Ekle' : 'Oluştur'}
      </button>

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
