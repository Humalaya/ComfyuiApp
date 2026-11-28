import { useEffect, useRef, useState } from 'react'
import { NumberField } from './NumberField'
import { ImageUploader } from './ImageUploader'
import { GenerationPreview } from './GenerationPreview'
import { ResultCarousel } from './ResultCarousel'
import { GenerationFullscreenViewer } from './GenerationFullscreenViewer'
import { CollapsibleSection } from './CollapsibleSection'
import { HelpTip } from './HelpTip'
import { randomSeed, SeedField } from './SeedField'
import { ModelSelect } from './ModelSelect'
import { archLabel, useTextEncoderArchs } from '../api/textEncoderClient'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useImageGeneration } from '../hooks/useImageGeneration'
import {
  activeImages,
  buildQwenEditWorkflow,
  defaultStepsFor,
  getDefaultQwenEditSettings,
  QWEN_EDIT_OUTPUT_NODE_ID,
  type ImageRef,
  type QwenEditSettings,
} from '../workflow/qwenEditFieldMap'
import { loadQwenEditSettings, normalizeQwenEditSettings, saveQwenEditSettings } from '../storage/qwenEditSettingsStorage'
import { useRemoteQueue } from '../storage/remoteQueueStorage'
import { PromptGenerator } from './PromptGenerator'

// This kind's key in the output-server's /api/state/:kind/* store.
const KIND = 'qwenedit'

const MAX_COMPLETED_RESULTS = 20

interface CompletedItem {
  promptId: string
  url: string
  createdAt: number
}

interface Props {
  // Pushed from App.tsx when Galeri / Civitai sends a picture (or an Edit
  // PNG's settings) here — reacts only when `id` changes, see
  // ImageGenerateTab.tsx.
  importRequest?: { settings: Partial<QwenEditSettings> & { inputImage?: ImageRef | null }; id: number } | null
}

// Edit (Qwen) — edits a picture with Qwen Image 2.1 by a plain instruction,
// with up to three more pictures as references ("the outfit from <image2>").
// See qwenEditFieldMap.ts. Same server-run queue and result handling as the
// Krea2 tab.
export function QwenEditGenerateTab({ importRequest }: Props) {
  const [settings, setSettings] = useState<QwenEditSettings>(
    () => loadQwenEditSettings() ?? { ...getDefaultQwenEditSettings(), seed: randomSeed() },
  )
  const { queue, comfyUp, queueError, append, remove, dismissError } = useRemoteQueue(KIND, normalizeQwenEditSettings)
  const [completedResults, setCompletedResults] = useState<CompletedItem[]>([])
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const objectInfo = useObjectInfo()
  const encoderArchs = useTextEncoderArchs(objectInfo.imageClipNames.join('|'))
  // The text encoder must be Qwen3-VL 8B — another one loads but fails at sampling.
  const encoderNote = (name: string) =>
    !encoderArchs[name]
      ? ''
      : encoderArchs[name] === 'qwen3vl_8b'
        ? '✓ uyumlu'
        : `✗ Edit (Qwen) ile uyumsuz (${archLabel(encoderArchs[name])})`
  const encoderWrong = !!encoderArchs[settings.clipName] && encoderArchs[settings.clipName] !== 'qwen3vl_8b'
  const gen = useImageGeneration(QWEN_EDIT_OUTPUT_NODE_ID, KIND)

  useEffect(() => {
    const timer = setTimeout(() => saveQwenEditSettings(settings), 400)
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
    const { inputImage, ...rest } = importRequest.settings
    setSettings((s) => {
      const next = { ...s, ...rest }
      // A picture sent from Galeri / Civitai becomes picture 1.
      if (inputImage) next.images = next.images.map((img, i) => (i === 0 ? { image: inputImage, on: true } : img))
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRequest?.id])

  // Saved model names can go stale — snap to what ComfyUI actually has.
  useEffect(() => {
    const { qwenUnetNames, imageClipNames, imageVaeNames } = objectInfo
    setSettings((s) => {
      let next = s
      if (qwenUnetNames.length > 0 && !qwenUnetNames.includes(s.unetName)) next = withModel(next, qwenUnetNames[0])
      // Qwen Image 2.1 takes the 8B Qwen3-VL encoder; prefer one named so.
      if (imageClipNames.length > 0 && !imageClipNames.includes(s.clipName))
        next = { ...next, clipName: imageClipNames.find((n) => /qwen3vl_8b/i.test(n)) ?? imageClipNames[0] }
      if (imageVaeNames.length > 0 && !imageVaeNames.includes(s.vaeName))
        next = { ...next, vaeName: imageVaeNames.find((n) => /qwen_image_2\.1/i.test(n)) ?? imageVaeNames[0] }
      return next
    })
  }, [objectInfo])

  function update<K extends keyof QwenEditSettings>(key: K, value: QwenEditSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
  }

  // A turbo model wants 8 steps, the full one 30 — carried over only while
  // the steps are still the old model's default.
  function withModel(s: QwenEditSettings, unetName: string): QwenEditSettings {
    const steps = s.steps === defaultStepsFor(s.unetName) ? defaultStepsFor(unetName) : s.steps
    return { ...s, unetName, steps }
  }

  function updateImage(slot: number, patch: Partial<QwenEditSettings['images'][number]>) {
    setSettings((s) => ({ ...s, images: s.images.map((img, i) => (i === slot ? { ...img, ...patch } : img)) }))
  }

  const isBusy = gen.status === 'running' || queue.length > 0
  const canGenerate = !!settings.images[0]?.image && settings.prompt.trim().length > 0
  const [submitting, setSubmitting] = useState(false)
  // <imageN> of each slot that goes in — a reference that's off closes the gap.
  const tagOf = new Map(activeImages(settings).map(({ slot }, n) => [slot, `<image${n + 1}>`]))
  const vaeMissing = !objectInfo.loading && !objectInfo.error && !objectInfo.imageVaeNames.includes(settings.vaeName)
  const clipMissing = !objectInfo.loading && !objectInfo.error && !objectInfo.imageClipNames.includes(settings.clipName)
  const unetMissing = !objectInfo.loading && !objectInfo.error && !objectInfo.qwenUnetNames.includes(settings.unetName)

  async function handleGenerate() {
    const count = Math.max(1, Math.round(settings.batchCount))
    const items: QwenEditSettings[] = []
    for (let i = 0; i < count; i++) {
      items.push(settings.fixedSeed ? settings : { ...settings, seed: randomSeed() })
    }
    if (!settings.fixedSeed) setSettings((s) => ({ ...s, seed: items[items.length - 1].seed }))
    setSubmitting(true)
    try {
      await append(items.map((s) => ({ settings: s, workflow: buildQwenEditWorkflow(s) })))
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
      {/* At the top: reachable without scrolling past the whole form. */}
      <button type="button" className="generate-button" disabled={!canGenerate || submitting || encoderWrong} onClick={handleGenerate}>
        {isBusy ? '+ Kuyruğa Ekle' : `Düzenle${settings.batchCount > 1 ? ` · ${settings.batchCount}` : ''}`}
      </button>

      {encoderWrong && (
        <div className="status-warning">
          ⚠ Seçili metin kodlayıcı {archLabel(encoderArchs[settings.clipName])} — Edit (Qwen) yalnızca Qwen3-VL 8B ile çalışır (başka bir
          kodlayıcı yüklenir ama örneklemede hata verir). Gelişmiş Ayarlar → Metin kodlayıcı'dan "✓ uyumlu" olanı seç.
        </div>
      )}

      {(vaeMissing || clipMissing || unetMissing) && (
        <div className="status-warning">
          ⚠ ComfyUI'de eksik model:{' '}
          {[
            unetMissing && 'Qwen Image modeli (diffusion_models/Image)',
            clipMissing && 'metin kodlayıcı (text_encoders/image)',
            vaeMissing && 'VAE (vae/image)',
          ]
            .filter(Boolean)
            .join(', ')}
          . Dosyayı koyduktan sonra uygulamayı yenile.
        </div>
      )}

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
                {i + 1}. {entry.settings.images[0]?.image?.filename ?? '(görsel yok)'}
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
            <div className="status-title">Düzenleniyor…</div>
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
          <div className="status-title">✓ Düzenleme Tamamlandı</div>
          {gen.totalElapsedSeconds !== null && <div className="status-row">Toplam süre: {gen.totalElapsedSeconds} sn</div>}
          <ResultCarousel key={gen.result.promptId} urls={historyUrls} kind="image" onOpen={setViewerUrl} />
        </div>
      )}

      {/* 2×2: picture 1 (the one edited — always on) and three references. */}
      <div className="picture-frame-row picture-frame-row-wrap">
        {settings.images.map((img, slot) =>
          slot === 0 ? (
            <ImageUploader
              key={slot}
              label="Görsel 1 · <image1>"
              help="Düzenlenecek görsel — her zaman açık. Sonuç bu görselin en-boy oranında ve boyutunda çıkar (Gelişmiş Ayarlar'da özel boyut seçilmedikçe). Talimatta <image1> diye geçer."
              value={img.image}
              onChange={(image) => updateImage(0, { image })}
            />
          ) : (
            <ImageUploader
              key={slot}
              label={`Görsel ${slot + 1}${tagOf.has(slot) ? ` · ${tagOf.get(slot)}` : ''}`}
              help={`İsteğe bağlı referans görsel — ör. "<image1>'deki kadına ${tagOf.get(slot) ?? `<image${slot + 1}>`}'deki kıyafeti giydir". Talimatta yanında yazan etiketle anılır; kapalı bir görsel sıradakilerin numarasını kaydırır.`}
              enabled={img.on}
              onToggleEnabled={(on) => updateImage(slot, { on })}
              offPlaceholder
              value={img.image}
              onChange={(image) => updateImage(slot, { image })}
            />
          ),
        )}
      </div>

      <div className="field">
        <div className="field-label" id="qe-talimat-label">
          Talimat
          <HelpTip>
            Yapılacak değişikliği İngilizce ve doğrudan yaz: <i>make the man in &lt;image1&gt; smile</i>, <i>remove the microphone</i>,{' '}
            <i>dress the woman from &lt;image1&gt; in the outfit from &lt;image2&gt;</i>. Görseller talimatta &lt;image1&gt;,
            &lt;image2&gt;… diye anılır. Söylemediğin şeylerin kalmasını istiyorsan bunu da yaz (
            <i>keep her face, pose and background unchanged</i>).
          </HelpTip>
          <PromptGenerator
            library={{ kind: KIND, prompt: settings.prompt, onUse: (p) => update('prompt', p.prompt) }}
            target="qwenedit"
            context={`Pictures given to the editing model: ${activeImages(settings).length} (named <image1>${activeImages(settings).length > 1 ? `…<image${activeImages(settings).length}>` : ''}).`}
            onUse={(text) => update('prompt', text)}
          />
        </div>
        <textarea
          aria-labelledby="qe-talimat-label"
          className="prompt-textarea"
          rows={4}
          value={settings.prompt}
          onChange={(e) => update('prompt', e.target.value)}
          placeholder="Ne değişsin? ör. make the man in <image1> smile"
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="qe-negatif">
          Negatif
          <HelpTip>İstenmeyenler (isteğe bağlı). CFG 1'de etkisi yoktur — sadece CFG 1'in üstünde çalışır.</HelpTip>
        </label>
        <textarea
          id="qe-negatif"
          className="prompt-textarea"
          rows={2}
          value={settings.negativePrompt}
          onChange={(e) => update('negativePrompt', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="qe-model">
          Model
          <HelpTip>Turbo model 8 adımda, tam model 30 adımda çalışır — model değişince adım sayısı da ona göre ayarlanır.</HelpTip>
        </label>
        <ModelSelect
          id="qe-model"
          value={settings.unetName}
          names={objectInfo.qwenUnetNames}
          loading={objectInfo.loading}
          onChange={(v) => setSettings((s) => withModel(s, v))}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="qe-adet">
            Adet
            <HelpTip>
              Kaç sonuç üretileceği — her biri ayrı iş olarak kuyruğa eklenir, Sabit kapalıysa her birine yeni seed seçilir.
            </HelpTip>
          </label>
          <NumberField id="qe-adet" min={1} max={20} step={1} value={settings.batchCount} onChange={(v) => update('batchCount', v)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="qe-uzun-kenar">
            Uzun kenar
            <HelpTip>
              Görsel 1'in uzun kenarı (piksel) — sonuç da bu boyutta çıkar. Büyüdükçe süre ve VRAM artar; 16 GB'ta 1536–1920 iyi bir aralık.
            </HelpTip>
          </label>
          <NumberField
            id="qe-uzun-kenar"
            min={512}
            max={2560}
            step={64}
            value={settings.maxSide}
            onChange={(v) => update('maxSide', v)}
            disabled={!settings.scaleImages}
          />
        </div>
      </div>

      <SeedField
        seed={settings.seed}
        fixed={settings.fixedSeed}
        onSeedChange={(v) => update('seed', v)}
        onFixedChange={(v) => update('fixedSeed', v)}
      />

      <CollapsibleSection title="Gelişmiş Ayarlar">
        <div className="field">
          <span className="field-label">
            Görselleri ölçekle
            <HelpTip>
              Açık: görseller uzun kenarlarına göre küçültülür/büyütülür. Kapalı: her görsel kendi boyutunda girer (yine de kenarları 16'nın
              katına kırpılır).
            </HelpTip>
            <button
              type="button"
              className={settings.scaleImages ? 'toggle-pill toggle-pill-on' : 'toggle-pill'}
              onClick={() => update('scaleImages', !settings.scaleImages)}
            >
              {settings.scaleImages ? 'Açık' : 'Kapalı'}
            </button>
          </span>
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="qe-ref-kenar">
              Referans uzun kenarı
              <HelpTip>Görsel 2–4'ün uzun kenarı (piksel).</HelpTip>
            </label>
            <NumberField
              id="qe-ref-kenar"
              min={256}
              max={2560}
              step={64}
              value={settings.refSide}
              onChange={(v) => update('refSide', v)}
              disabled={!settings.scaleImages}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="qe-enc-res">
              Kodlayıcı çözünürlüğü
              <HelpTip>Metin kodlayıcının referansları gördüğü boyut (≈ N×N piksel). 0: her görsel kendi boyutunda.</HelpTip>
            </label>
            <NumberField
              id="qe-enc-res"
              min={0}
              max={4096}
              step={32}
              value={settings.encoderResolution}
              onChange={(v) => update('encoderResolution', v)}
            />
          </div>
        </div>
        <div className="field">
          <span className="field-label">
            Özel çıktı boyutu
            <HelpTip>
              Kapalı (önerilen): sonuç Görsel 1'in boyutunda. Açık: aşağıdaki boyutta — başka boyutlar düzenlemeyi kaydırabilir.
            </HelpTip>
            <button
              type="button"
              className={settings.customSize ? 'toggle-pill toggle-pill-on' : 'toggle-pill'}
              onClick={() => update('customSize', !settings.customSize)}
            >
              {settings.customSize ? 'Açık' : 'Kapalı'}
            </button>
          </span>
        </div>
        {settings.customSize && (
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="qe-w">
                Genişlik
              </label>
              <NumberField id="qe-w" min={256} max={4096} step={16} value={settings.width} onChange={(v) => update('width', v)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="qe-h">
                Yükseklik
              </label>
              <NumberField id="qe-h" min={256} max={4096} step={16} value={settings.height} onChange={(v) => update('height', v)} />
            </div>
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="qe-adim">
              Adım
            </label>
            <NumberField id="qe-adim" min={1} max={60} step={1} value={settings.steps} onChange={(v) => update('steps', v)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="qe-cfg">
              CFG
            </label>
            <NumberField id="qe-cfg" min={0} max={10} step={0.1} value={settings.cfg} onChange={(v) => update('cfg', v)} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="qe-sampler">
              Sampler
            </label>
            <ModelSelect
              id="qe-sampler"
              value={settings.samplerName}
              names={objectInfo.samplerNames}
              loading={objectInfo.loading}
              onChange={(v) => update('samplerName', v)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="qe-scheduler">
              Scheduler
            </label>
            <ModelSelect
              id="qe-scheduler"
              value={settings.scheduler}
              names={objectInfo.schedulerNames}
              loading={objectInfo.loading}
              onChange={(v) => update('scheduler', v)}
            />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="qe-clip">
            Metin kodlayıcı
          </label>
          <ModelSelect
            id="qe-clip"
            value={settings.clipName}
            note={encoderNote}
            names={objectInfo.imageClipNames}
            loading={objectInfo.loading}
            onChange={(v) => update('clipName', v)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="qe-vae">
            VAE
          </label>
          <ModelSelect
            id="qe-vae"
            value={settings.vaeName}
            names={objectInfo.imageVaeNames}
            loading={objectInfo.loading}
            onChange={(v) => update('vaeName', v)}
          />
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
