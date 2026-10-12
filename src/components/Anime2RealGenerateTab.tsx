import { useEffect, useRef, useState } from 'react'
import { NumberField } from './NumberField'
import { LoraList } from './LoraList'
import { ImageUploader } from './ImageUploader'
import { GenerationPreview } from './GenerationPreview'
import { ResultCarousel } from './ResultCarousel'
import { GenerationFullscreenViewer } from './GenerationFullscreenViewer'
import { CollapsibleSection } from './CollapsibleSection'
import { HelpTip } from './HelpTip'
import { randomSeed, SeedField } from './SeedField'
import { modelLabel } from '../utils/modelLabel'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useImageGeneration } from '../hooks/useImageGeneration'
import {
  ANIME2REAL_OUTPUT_NODE_ID,
  buildAnime2RealWorkflow,
  getDefaultAnime2RealSettings,
  type Anime2RealSettings,
} from '../workflow/anime2realFieldMap'
import type { LoraSlot } from '../workflow/fieldMap'
import { loadAnime2RealSettings, normalizeAnime2RealSettings, saveAnime2RealSettings } from '../storage/anime2realSettingsStorage'
import { appendTriggerWords } from '../utils/promptText'
import { useRemoteQueue } from '../storage/remoteQueueStorage'

// This kind's key in the output-server's /api/state/:kind/* store.
const KIND = 'anime2real'

const MAX_COMPLETED_RESULTS = 20

const DEFAULT_SYSTEM_PROMPT = getDefaultAnime2RealSettings().systemPrompt

interface CompletedItem {
  promptId: string
  url: string
  createdAt: number
}

interface Props {
  // Pushed from App.tsx when Galeri sends a picture (or an Anime2Real PNG's
  // settings) here — reacts only when `id` changes, see ImageGenerateTab.tsx.
  importRequest?: { settings: Partial<Anime2RealSettings>; id: number } | null
}

// Anime2Real — turns an input picture into a realistic photo with Krea2's
// edit patch + the AnimeToReal LoRA (see anime2realFieldMap.ts). Same
// server-run queue and result handling as the Krea2 tab.
export function Anime2RealGenerateTab({ importRequest }: Props) {
  const [settings, setSettings] = useState<Anime2RealSettings>(
    () => loadAnime2RealSettings() ?? { ...getDefaultAnime2RealSettings(), seed: randomSeed() },
  )
  const { queue, comfyUp, queueError, append, remove, dismissError } = useRemoteQueue(KIND, normalizeAnime2RealSettings)
  const [completedResults, setCompletedResults] = useState<CompletedItem[]>([])
  // Tracked by url, not index — see Krea2GenerateTab.tsx.
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const objectInfo = useObjectInfo()
  const gen = useImageGeneration(ANIME2REAL_OUTPUT_NODE_ID, KIND)

  useEffect(() => {
    const timer = setTimeout(() => saveAnime2RealSettings(settings), 400)
    return () => clearTimeout(timer)
  }, [settings])

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

  useEffect(() => {
    if (!importRequest) return
    setSettings((s) => ({ ...s, ...importRequest.settings }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRequest?.id])

  // A saved model name can go stale — snap to what ComfyUI actually has.
  useEffect(() => {
    if (objectInfo.krea2UnetNames.length === 0) return
    if (!objectInfo.krea2UnetNames.includes(settings.unetName)) {
      update('unetName', objectInfo.krea2UnetNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectInfo.krea2UnetNames])

  function update<K extends keyof Anime2RealSettings>(key: K, value: Anime2RealSettings[K]) {
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
  const canGenerate = !!settings.inputImage && settings.prompt.trim().length > 0
  const [submitting, setSubmitting] = useState(false)

  async function handleGenerate() {
    const count = Math.max(1, Math.round(settings.batchCount))
    const items: Anime2RealSettings[] = []
    for (let i = 0; i < count; i++) {
      items.push(settings.fixedSeed ? settings : { ...settings, seed: randomSeed() })
    }
    if (!settings.fixedSeed) setSettings((s) => ({ ...s, seed: items[items.length - 1].seed }))
    setSubmitting(true)
    try {
      await append(items.map((s) => ({ settings: s, workflow: buildAnime2RealWorkflow(s) })))
      gen.checkRemoteJob()
    } catch (err) {
      alert(`Kuyruğa eklenemedi: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const historyUrls = completedResults.map((r) => r.url)

  return (
    <div className="form">
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
                {i + 1}. {entry.settings.inputImage?.filename ?? '(görsel yok)'}
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
            <div className="status-title">Dönüştürülüyor…</div>
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
          <div className="status-title">✓ Dönüştürme Tamamlandı</div>
          {gen.totalElapsedSeconds !== null && <div className="status-row">Toplam süre: {gen.totalElapsedSeconds} sn</div>}
          <ResultCarousel key={gen.result.promptId} urls={historyUrls} kind="image" onOpen={setViewerUrl} />
        </div>
      )}

      <ImageUploader
        wide
        label="Girdi görseli"
        help="Gerçekçi fotoğrafa çevrilecek görsel (anime, çizim, 3D…). Sonuç bu görselin en-boy oranında, aşağıdaki uzun kenar boyutunda çıkar."
        value={settings.inputImage}
        onChange={(img) => update('inputImage', img)}
      />

      <div className="field">
        <label className="field-label">
          Talimat
          <HelpTip>
            Varsayılan "transform the image to realistic photograph" LoRA'nın kendi tetik cümlesi. Arkasına kısa bir tarif eklemek
            sonucu iyileştirir: ırk, yaş, saç rengi, ifade, poz, çekim açısı. Daha az gerçekçi bir sonuç için "Semi-realistic
            photograph" yazabilirsin. Yeterince gerçekçi olmazsa sonucu tekrar dönüştürmek de işe yarar.
          </HelpTip>
        </label>
        <textarea
          className="prompt-textarea"
          rows={4}
          value={settings.prompt}
          onChange={(e) => update('prompt', e.target.value)}
          placeholder="transform the image to realistic photograph"
        />
      </div>

      <div className="field">
        <label className="field-label">
          Sistem talimatı
          <HelpTip>
            Modele girdi görselini nasıl okuyacağını ve talimatı nasıl uygulayacağını anlatan sabit yönerge (system_prompt). Korunmasını
            istediğin ayrıntıları buraya yazabilirsin, ör. "keep the exact pose, clothing and background". Varsayılana dönmek için
            ↺'ye bas.
          </HelpTip>
          {settings.systemPrompt !== DEFAULT_SYSTEM_PROMPT && (
            <button type="button" className="help-tip" onClick={() => update('systemPrompt', DEFAULT_SYSTEM_PROMPT)} aria-label="Varsayılana dön">
              ↺
            </button>
          )}
        </label>
        <textarea
          className="prompt-textarea"
          rows={5}
          value={settings.systemPrompt}
          onChange={(e) => update('systemPrompt', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label">Model</label>
        <select value={settings.unetName} onChange={(e) => update('unetName', e.target.value)} disabled={objectInfo.loading}>
          {!objectInfo.krea2UnetNames.includes(settings.unetName) && <option value={settings.unetName}>{settings.unetName}</option>}
          {objectInfo.krea2UnetNames.map((name) => (
            <option key={name} value={name}>
              {modelLabel(name)}
            </option>
          ))}
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label">
            Uzun kenar
            <HelpTip>Sonucun en uzun kenarı (piksel). Girdi görseli oranı korunarak bu boyuta getirilir. 1536 iyi bir denge; büyüdükçe süre uzar.</HelpTip>
          </label>
          <NumberField min={512} max={2560} step={64} value={settings.maxSide} onChange={(v) => update('maxSide', v)} />
        </div>
        <div className="field">
          <label className="field-label">
            Adet
            <HelpTip>Aynı görseli kaç kez dönüştüreceği — her biri ayrı iş olarak kuyruğa eklenir, Sabit kapalıysa her birine yeni seed seçilir.</HelpTip>
          </label>
          <NumberField min={1} max={20} step={1} value={settings.batchCount} onChange={(v) => update('batchCount', v)} />
        </div>
      </div>

      <SeedField
        seed={settings.seed}
        fixed={settings.fixedSeed}
        onSeedChange={(v) => update('seed', v)}
        onFixedChange={(v) => update('fixedSeed', v)}
      />

      <LoraList
        loras={settings.loras}
        loraNames={objectInfo.loraNames}
        tab="krea2"
        onChange={updateLora}
        onSendToPrompt={(words) => update('prompt', appendTriggerWords(settings.prompt, words))}
      />

      <CollapsibleSection title="Gelişmiş Ayarlar">
        <div className="field-row">
          <div className="field">
            <label className="field-label">Adım</label>
            <NumberField min={1} max={50} step={1} value={settings.steps} onChange={(v) => update('steps', v)} />
          </div>
          <div className="field">
            <label className="field-label">CFG</label>
            <NumberField min={0} max={10} step={0.1} value={settings.cfg} onChange={(v) => update('cfg', v)} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label">Sampler</label>
            <select value={settings.samplerName} onChange={(e) => update('samplerName', e.target.value)} disabled={objectInfo.loading}>
              {!objectInfo.samplerNames.includes(settings.samplerName) && <option value={settings.samplerName}>{settings.samplerName}</option>}
              {objectInfo.samplerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">Scheduler</label>
            <select value={settings.scheduler} onChange={(e) => update('scheduler', e.target.value)} disabled={objectInfo.loading}>
              {!objectInfo.schedulerNames.includes(settings.scheduler) && <option value={settings.scheduler}>{settings.scheduler}</option>}
              {objectInfo.schedulerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </CollapsibleSection>

      {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}

      <button type="button" className="generate-button" disabled={!canGenerate || submitting} onClick={handleGenerate}>
        {isBusy ? '+ Kuyruğa Ekle' : settings.batchCount > 1 ? `Dönüştür · ${settings.batchCount}` : 'Dönüştür'}
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
