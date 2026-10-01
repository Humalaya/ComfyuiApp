import { useEffect, useRef, useState } from 'react'
import { NumberField } from './NumberField'
import { LoraList } from './LoraList'
import { GenerationPreview } from './GenerationPreview'
import { ResultCarousel } from './ResultCarousel'
import { GenerationFullscreenViewer } from './GenerationFullscreenViewer'
import { CollapsibleSection } from './CollapsibleSection'
import { TagCheatSheet } from './TagCheatSheet'
import { HelpTip } from './HelpTip'
import { randomSeed, SeedField } from './SeedField'
import { modelLabel } from '../utils/modelLabel'
import { useObjectInfo } from '../hooks/useObjectInfo'
import { useImageGeneration } from '../hooks/useImageGeneration'
import { buildImageWorkflow, getDefaultImageSettings, IMAGE_OUTPUT_NODE_ID, QUALITY_PRESETS, type ImageGenerationSettings } from '../workflow/imageFieldMap'
import { appendTriggerWords } from '../utils/promptText'
import type { LoraSlot } from '../workflow/fieldMap'
import { loadImageSettings, normalizeImageSettings, saveImageSettings } from '../storage/imageSettingsStorage'
import { loadRemoteQueue, saveRemoteQueue } from '../storage/remoteQueueStorage'

// This kind's key in the output-server's shared /api/state/:kind/* store —
// see remoteQueueStorage.ts for why that's PC RAM now, not phone localStorage.
const KIND = 'sdxl'

// Kept small — a "what finished recently" log, not a real history feature.
// Same rationale as App.tsx's identical constant for the video tab.
const MAX_COMPLETED_RESULTS = 20

// One flat entry per *file*, not per job — see App.tsx's identical
// CompletedItem for the full rationale (a batchSize > 1 job's extra files
// get the full ResultCarousel treatment only for the current/just-finished
// result; this older-results log stays a simple flat thumbnail strip).
interface CompletedItem {
  promptId: string
  url: string
  createdAt: number
}

interface Props {
  // Pushed from App.tsx when Galeri's "Ayarları Gönder" targets this tab
  // (see App.tsx's PendingImport) — this tab owns `settings` entirely
  // locally, so this is the only way anything outside it can change what's
  // in the form. `id` is a nonce: the effect below only reacts when it
  // actually changes, so sending the exact same PNG's settings twice in a
  // row still registers as a fresh request instead of silently no-op'ing.
  importRequest?: { settings: Partial<ImageGenerationSettings>; id: number } | null
}

// Text2Img — see imageFieldMap.ts for what this workflow does and doesn't
// expose yet (the FaceDetailer's ~29 parameters are a future "Detail
// Enhancers" tab). This screen controls prompt, negative prompt, size,
// steps/cfg/batch count, seed, checkpoint, and LoRAs — no VAE/CLIP override
// (removed: this checkpoint's own bundled VAE/CLIP is what's actually used
// and there was never a compatible standalone VAE file to switch to anyway).
export function ImageGenerateTab({ importRequest }: Props) {
  const [settings, setSettings] = useState<ImageGenerationSettings>(
    () => loadImageSettings() ?? { ...getDefaultImageSettings(), seed: randomSeed() },
  )
  // Same queueing pattern as the video tab (App.tsx), now backed by the
  // output-server's PC-RAM store (see remoteQueueStorage.ts) instead of the
  // phone's own storage — persisted so closing the phone (not just reloading
  // it) doesn't drop everything still waiting in line, plus a small
  // "recently finished" log so draining the queue doesn't make the previous
  // result disappear the instant the next one starts. Starts empty and is
  // populated by the mount effect below (loading it is now an async fetch).
  const [queue, setQueue] = useState<ImageGenerationSettings[]>([])
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
  const gen = useImageGeneration(buildImageWorkflow, IMAGE_OUTPUT_NODE_ID, KIND)

  useEffect(() => {
    const timer = setTimeout(() => saveImageSettings(settings), 400)
    return () => clearTimeout(timer)
  }, [settings])

  useEffect(() => {
    let cancelled = false
    loadRemoteQueue(KIND, normalizeImageSettings, () => cancelled).then((loaded) => {
      if (cancelled || loaded === null) return
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

  // Drains one queued job at a time, same design as App.tsx's video queue
  // (see the long comment there for the full rationale) — including the
  // lastDrainedKey guard against React StrictMode's mount-time double-invoke
  // (this app runs under StrictMode in production too, see main.tsx), which
  // would otherwise start two queued jobs at once right after a reload with
  // a persisted queue and no active job.
  const lastDrainedKey = useRef<string | null>(null)
  useEffect(() => {
    if (!(gen.status === 'done' || gen.status === 'error' || gen.status === 'idle')) return
    // Wait for the queue's own PC-RAM load to finish before deciding it's
    // empty — this races gen's own mount-time job recovery (see
    // useImageGeneration.ts). If that settles first and finds the job
    // already done, `queue` can still be its initial `[]` at that exact
    // moment — reading queue.length as "0, nothing to drain" then would
    // strand every real pending item forever, since queueLoaded flipping
    // true afterwards was never a dependency this effect re-ran for.
    // Including it as one now (see the array below) is what makes that late
    // queue load retry this check.
    if (!queueLoaded) return
    // Also wait for gen's OWN mount-time job-recovery check to have actually
    // run — see App.tsx's identical guard for the full rationale. Without
    // this, 'idle' (which means EITHER "genuinely nothing running" OR
    // "recovery hasn't reported back yet") could get read as the former
    // right before recovery settles a leftover job to 'done' a moment later,
    // firing this effect twice and starting two queued items whose
    // generate() calls step on the same shared refs — this is what let
    // queued Krea2/SDXL jobs vanish without ever reaching ComfyUI after a
    // background process kill.
    if (!gen.recoveryChecked) return
    const key = `${gen.status}:${gen.settledCount}:${queueLoaded}`
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
  }, [gen.status, gen.settledCount, queueLoaded, gen.recoveryChecked])

  // The template's baked-in default checkpoint file can stop existing (get
  // renamed/removed on disk) without any code change here — this snaps back
  // to whatever ComfyUI actually reports as available the moment that list
  // loads, instead of silently trying to queue a prompt with a checkpoint
  // name ComfyUI will reject.
  useEffect(() => {
    if (objectInfo.checkpointNames.length === 0) return
    if (!objectInfo.checkpointNames.includes(settings.checkpoint)) {
      update('checkpoint', objectInfo.checkpointNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectInfo.checkpointNames])

  // See the importRequest prop's own comment — reacts only to `id` changing,
  // not to `settings` (a fresh object every send anyway), so this can't
  // re-fire on every unrelated re-render.
  useEffect(() => {
    if (!importRequest) return
    setSettings((s) => ({ ...s, ...importRequest.settings }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRequest?.id])

  function update<K extends keyof ImageGenerationSettings>(key: K, value: ImageGenerationSettings[K]) {
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
    // batchSize (real ComfyUI batch_size, sent as-is on every item below) and
    // batchCount (queues this many separate jobs, each with its own
    // freshly-randomized seed when not fixed — same rationale as the video
    // tab's identical field in App.tsx) stack rather than substitute for one
    // another: batchSize 4 + batchCount 3 queues 3 jobs of 4 images each.
    const count = Math.max(1, Math.round(settings.batchCount))
    const items: ImageGenerationSettings[] = []
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
        <label className="field-label">Prompt</label>
        <textarea
          className="prompt-textarea"
          rows={6}
          value={settings.prompt}
          onChange={(e) => update('prompt', e.target.value)}
          placeholder="Görselde ne olmasını istediğini yaz…"
        />
      </div>

      <div className="field">
        <label className="field-label">
          Negatif Prompt
          <HelpTip>
            Görselde istemediğin şeyler. CFG 0 iken negatif prompt'un hiçbir etkisi olmadığı (classifier-free guidance devre dışı)
            için kutu kapanır.
          </HelpTip>
        </label>
        <textarea
          className="prompt-textarea"
          rows={3}
          value={settings.negativePrompt}
          onChange={(e) => update('negativePrompt', e.target.value)}
          placeholder={settings.cfg === 0 ? 'CFG 0 — kapalı' : 'İstemediğin şeyler…'}
          disabled={settings.cfg === 0}
        />
      </div>

      <TagCheatSheet
        prompt={settings.prompt}
        negativePrompt={settings.negativePrompt}
        onPromptChange={(prompt) => update('prompt', prompt)}
        onNegativePromptChange={(negativePrompt) => update('negativePrompt', negativePrompt)}
      />

      <div className="field">
        <label className="field-label">
          Quality Prompt
          <HelpTip>
            Checkpoint ailesine uygun sabit kalite etiketlerini ekler. Prompt kutularında görünmez, sadece üretime gönderilirken
            eklenir. Seçiliye tekrar dokunmak kapatır.
            {settings.qualityPreset !== 'none' && (
              <>
                <br />
                <br />
                <b>+</b> {QUALITY_PRESETS[settings.qualityPreset].positive}
                <br />
                <b>−</b> {QUALITY_PRESETS[settings.qualityPreset].negative}
              </>
            )}
          </HelpTip>
        </label>
        <div className="seg">
          {(Object.keys(QUALITY_PRESETS) as (keyof typeof QUALITY_PRESETS)[]).map((id) => (
            <button
              key={id}
              type="button"
              className={settings.qualityPreset === id ? 'seg-btn seg-btn-active' : 'seg-btn'}
              onClick={() => update('qualityPreset', settings.qualityPreset === id ? 'none' : id)}
            >
              {QUALITY_PRESETS[id].label}
            </button>
          ))}
        </div>
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

      <SeedField
        seed={settings.seed}
        fixed={settings.fixedSeed}
        onSeedChange={(v) => update('seed', v)}
        onFixedChange={(v) => update('fixedSeed', v)}
      />

      <div className="field">
        <label className="field-label">Checkpoint</label>
        <select value={settings.checkpoint} onChange={(e) => update('checkpoint', e.target.value)} disabled={objectInfo.loading}>
          {!objectInfo.checkpointNames.includes(settings.checkpoint) && <option value={settings.checkpoint}>{settings.checkpoint}</option>}
          {objectInfo.checkpointNames.map((name) => (
            <option key={name} value={name}>
              {modelLabel(name)}
            </option>
          ))}
        </select>
      </div>

      <LoraList
        loras={settings.loras}
        loraNames={objectInfo.loraNames}
        tab="sdxl"
        onChange={updateLora}
        onSendToPrompt={(words) => update('prompt', appendTriggerWords(settings.prompt, words))}
      />

      <div className="field-row">
        <div className="field">
          <label className="field-label">Adım Sayısı</label>
          <NumberField min={1} max={100} step={1} value={settings.steps} onChange={(v) => update('steps', v)} />
        </div>
        <div className="field">
          <label className="field-label">CFG</label>
          <NumberField min={0} max={30} step={0.5} value={settings.cfg} onChange={(v) => update('cfg', v)} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label">
            Batch Size
            <HelpTip>
              <b>Batch Size:</b> tek işte kaç görsel üretileceği. <b>Batch Count:</b> kaç ayrı işin art arda kuyruğa ekleneceği.
              İkisi çarpılır — 4 × 3 = 3 iş, her birinde 4 görsel.
            </HelpTip>
          </label>
          <NumberField min={1} max={8} step={1} value={settings.batchSize} onChange={(v) => update('batchSize', v)} />
        </div>
        <div className="field">
          <label className="field-label">Batch Count</label>
          <NumberField min={1} max={20} step={1} value={settings.batchCount} onChange={(v) => update('batchCount', v)} />
        </div>
      </div>

      <CollapsibleSection title="Gelişmiş Ayarlar">
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
        <div className="field">
          <label className="field-label">Denoise</label>
          <NumberField min={0} max={1} step={0.01} value={settings.denoise} onChange={(v) => update('denoise', v)} />
        </div>
      </CollapsibleSection>

      {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}

      <button type="button" className="generate-button" disabled={!canGenerate} onClick={handleGenerate}>
        {isBusy ? '+ Kuyruğa Ekle' : settings.batchSize * settings.batchCount > 1 ? `Oluştur · ${settings.batchSize * settings.batchCount}` : 'Oluştur'}
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
