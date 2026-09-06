import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ImageUploader } from './components/ImageUploader'
import { NumberField } from './components/NumberField'
import { ImportPngButton } from './components/ImportPngButton'
import { LoraList } from './components/LoraList'
import { StatusPanel } from './components/StatusPanel'
import { GenerationFullscreenViewer } from './components/GenerationFullscreenViewer'
import { Gallery } from './components/Gallery'
import { ImageGenerateTab } from './components/ImageGenerateTab'
import { Krea2GenerateTab } from './components/Krea2GenerateTab'
import { useObjectInfo } from './hooks/useObjectInfo'
import { useComfyGeneration } from './hooks/useComfyGeneration'
import { getDefaultSettings, type GenerationSettings, type LoraSlot } from './workflow/fieldMap'
import { loadSettings, saveSettings } from './storage/settingsStorage'
import { loadQueue, saveQueue } from './storage/queueStorage'

// Kept small on purpose — not a real history feature, just enough of a
// "what finished recently" trail for GenerationFullscreenViewer to swipe
// through (see completedResults below and its viewerItems derivation).
const MAX_COMPLETED_RESULTS = 20

// One flat entry per *file*, not per job — a batchCount job still finishes
// as a single gen.result, but that result can itself carry several urls
// (Batch Size > 1), each becoming its own entry here in the same order. Only
// the current job's own files are ever shown inline (via ResultCarousel in
// StatusPanel.tsx) — this array exists purely so tapping one opens
// GenerationFullscreenViewer with the rest of the session's history to swipe
// through, generation continuing in the background regardless.
interface CompletedItem {
  promptId: string
  url: string
  createdAt: number
}

// 'image' first/default per "image generation ana ekran olacak" — video
// generation (txt2vid/img2vid, see ImageUploader.tsx) and the gallery are
// both still one tap away.
type Tab = 'image' | 'video' | 'gallery'

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000_000)
}

export default function App() {
  const [tab, setTab] = useState<Tab>('image')
  const [imageModel, setImageModel] = useState<'sdxl' | 'krea2'>('sdxl')
  // Restores whatever was last saved (prompt, seed, model, LoRAs, input
  // image reference, ...) so a reload — screen lock, OEM background kill,
  // manual refresh — doesn't wipe the form back to scratch. Only a true
  // first-ever launch (nothing saved yet) falls back to the workflow
  // template's defaults, and only then does the seed get randomized — once
  // something is saved, the seed is whatever the user left it at, same as
  // every other field.
  const [settings, setSettings] = useState<GenerationSettings>(() => loadSettings() ?? { ...getDefaultSettings(), seed: randomSeed() })
  // Restored from storage on mount for the exact reason jobStorage.ts exists
  // for the *active* job: a page reload mid-batch (screen lock, OEM
  // background kill, manual refresh) used to wipe this array outright, since
  // it only ever lived in memory — which is exactly what silently ate an
  // overnight queue of ~15 videos down to just the first one or two. See
  // queueStorage.ts.
  const [queue, setQueue] = useState<GenerationSettings[]>(() => loadQueue())
  // Recently-finished results, most recent first — kept here (separate from
  // the single active `gen.result`) specifically so that when the queue
  // drain effect below immediately moves on to the next job, the just-shown
  // result doesn't just vanish; it stays visible in this small log until the
  // whole session is closed. Not persisted: it's a convenience log, not a
  // record of truth (the actual files are already safe on ComfyUI's disk,
  // browsable in Galeri).
  const [completedResults, setCompletedResults] = useState<CompletedItem[]>([])
  // The url of the item GenerationFullscreenViewer has open — null means
  // closed. Tracked by url rather than a plain index into completedResults:
  // a new job can finish (and get unshifted onto the front of that array)
  // while the viewer is still open, since it's a pure display layer that
  // never pauses generation — a plain index would then silently point at a
  // different, newer item the moment that happened. The url stays valid
  // regardless of how the array shifts around it.
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  // Set when the queue stops itself after a *pre-flight* failure (ComfyUI
  // never even accepted the prompt — almost always means it's unreachable,
  // not that this specific job was bad) instead of continuing to drain. See
  // the effect below for why blindly continuing would be worse than pausing.
  const [queuePaused, setQueuePaused] = useState(false)
  const objectInfo = useObjectInfo()
  const gen = useComfyGeneration()

  const isBusy = gen.status === 'queued' || gen.status === 'running' || (queuePaused && queue.length > 0)

  // Measured (rather than guessed/hardcoded) so the Galeri tab's sticky
  // breadcrumb/back button can dock its `top` exactly at the bottom of this
  // header via the --header-height CSS var below, regardless of exact font
  // metrics across devices.
  const headerRef = useRef<HTMLElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)

  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const update = () => setHeaderHeight(el.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Debounced so rapid-fire changes (typing in the prompt textarea) don't
  // hit localStorage on every keystroke — a few hundred ms of lag before a
  // reload would recover the very latest keystroke is an acceptable
  // trade-off for not writing on every single one.
  useEffect(() => {
    const timer = setTimeout(() => saveSettings(settings), 400)
    return () => clearTimeout(timer)
  }, [settings])

  useEffect(() => {
    saveQueue(queue)
  }, [queue])

  function startNextInQueue() {
    if (queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    setQueuePaused(false)
    gen.generate(next)
  }

  // Drains the queue one item at a time: the moment the active generation
  // reaches a terminal state — done, errored, or manually cancelled (which
  // also lands on 'idle') — immediately start the next queued job. The
  // just-finished result isn't lost when this happens (see completedResults
  // above), and this just means the on-screen status panel moves on instead
  // of sitting idle. Cancelling one queued job this way skips it and moves on
  // rather than getting the whole queue stuck (there'd be no other trigger to
  // drain it afterwards).
  //
  // Watches gen.settledCount *in addition to* gen.status on purpose: two
  // queued jobs failing back-to-back both land on 'error', which alone is
  // not a value *change* React re-fires an effect for — without the counter,
  // the second failure wouldn't advance the queue at all and the rest would
  // just sit there forever.
  //
  // lastDrainedKey guards against React StrictMode's documented double-
  // invocation of an effect right after it first mounts (setup → cleanup →
  // setup again, to help surface missing-cleanup bugs) — which this app
  // genuinely runs under in production, not just local dev tooling (see
  // main.tsx). Without the guard, a persisted queue with pending items and
  // no active job (nothing running right after a reload) would have this
  // effect's very first mount-time invocation fire twice, starting two
  // queued jobs at once instead of one.
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

    if (gen.status === 'error' && gen.preflightFailure) {
      // ComfyUI itself is almost certainly unreachable — starting the next
      // item would just fail the exact same way, and doing that 14 more
      // times in a row would burn through an entire overnight queue in a
      // few seconds with nothing to show for it. Stop and wait for either a
      // manual retry or the app being reopened (see the visibility effect
      // below), instead.
      setQueuePaused(true)
      return
    }

    startNextInQueue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.status, gen.settledCount])

  // One retry attempt whenever the app is reopened/foregrounded while the
  // queue is paused — covers exactly the "left it overnight, ComfyUI (or the
  // PC) was down for a while, came back before I checked in the morning"
  // case, without looping retries while still definitely unreachable.
  useEffect(() => {
    function onVisible() {
      const genIdle = gen.status !== 'queued' && gen.status !== 'running'
      if (document.visibilityState === 'visible' && queuePaused && queue.length > 0 && genIdle) {
        startNextInQueue()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
    // Re-registered (cheap) whenever any of these change, specifically so the
    // closure over `queue`/`gen.status` can't go stale between a pause and
    // whenever the user next foregrounds the app — e.g. removing a queued
    // item while paused, without this, would resume against the old queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuePaused, queue, gen.status])

  function update<K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
  }

  function updateLora(index: number, slot: LoraSlot) {
    setSettings((s) => {
      const loras = [...s.loras]
      loras[index] = slot
      return { ...s, loras }
    })
  }

  // No image required — the workflow's LoadImageCrop node already has a
  // default placeholder image baked into template.json (see fieldMap.ts),
  // so leaving inputImage unset falls straight through to a text-only
  // (txt2vid) generation instead of failing; setting one switches to
  // img2vid. Same workflow either way, this is purely a UI-level choice.
  const canGenerate = settings.prompt.trim().length > 0

  function handleGenerate() {
    // ComfyUI's "easy seed" node has no server-side randomize behavior of its
    // own — it just uses whatever seed value it's given. So unless the user
    // pinned it, a fresh seed is picked here, right before submitting, and
    // the field is updated so it's clear which seed this generation actually used.
    //
    // batchCount > 1: the video model has no native batch_size (checked via
    // ComfyUI's own /object_info — MiniMaxH3ImageToVideo doesn't take one),
    // so "batch" here means queuing N separate jobs instead of one, each
    // with its own freshly-randomized seed when not fixed.
    const count = Math.max(1, Math.round(settings.batchCount))
    const items: GenerationSettings[] = []
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

  return (
    <div className="app" style={{ '--header-height': `${headerHeight}px` } as CSSProperties}>
      <header className="app-header" ref={headerRef}>
        <h1>MiniMax H3 Mobil Kontrol</h1>
        <nav className="tabs">
          <button className={tab === 'image' ? 'tab tab-active' : 'tab'} onClick={() => setTab('image')}>
            Görsel
          </button>
          <button className={tab === 'video' ? 'tab tab-active' : 'tab'} onClick={() => setTab('video')}>
            Video
          </button>
          <button className={tab === 'gallery' ? 'tab tab-active' : 'tab'} onClick={() => setTab('gallery')}>
            Galeri
          </button>
        </nav>
      </header>

      {/* All tabs stay permanently mounted (just hidden via display:none)
          instead of being conditionally unmounted — Gallery previously lost
          its scroll position, selected source and current folder every time
          you switched away and back, since unmounting it threw all of that
          state away; the same would happen to in-progress generations on
          either generate tab. */}
      <div style={{ display: tab === 'image' ? 'block' : 'none' }}>
        <div className="tabs image-model-tabs">
          <button className={imageModel === 'sdxl' ? 'tab tab-active' : 'tab'} onClick={() => setImageModel('sdxl')}>
            SDXL
          </button>
          <button className={imageModel === 'krea2' ? 'tab tab-active' : 'tab'} onClick={() => setImageModel('krea2')}>
            Krea2 (FLUX)
          </button>
        </div>
        {/* Both stay mounted for the same reason as the outer tabs — switching
            between model families shouldn't lose an in-progress generation. */}
        <div style={{ display: imageModel === 'sdxl' ? 'block' : 'none' }}>
          <ImageGenerateTab />
        </div>
        <div style={{ display: imageModel === 'krea2' ? 'block' : 'none' }}>
          <Krea2GenerateTab />
        </div>
      </div>

      <div style={{ display: tab === 'gallery' ? 'block' : 'none' }}>
        <Gallery
          onSendToCreate={(imported) => {
            // fixedSeed is already set to true inside pngImport.ts whenever a
            // seed was actually recognized, so this merge doesn't need to
            // special-case it.
            setSettings((s) => ({ ...s, ...imported }))
            setTab('video')
          }}
        />
      </div>

      <main className="form" style={{ display: tab === 'video' ? 'flex' : 'none' }}>
        {/* Output first, form fields below — so the current job's progress
            or result is visible the moment this tab opens, without scrolling
            past the whole form to find out whether anything even finished. */}
        {queue.length > 0 && (
          <div className="queue-panel">
            <div className="queue-title">Kuyrukta {queue.length} iş bekliyor</div>
            {queuePaused && (
              <div className="status-warning">
                ⚠ ComfyUI'ye ulaşılamadığı için kuyruk duraklatıldı.
                <button type="button" className="secondary-button" onClick={startNextInQueue}>
                  Devam Et
                </button>
              </div>
            )}
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

        <StatusPanel
          status={gen.status}
          currentNodeTitle={gen.currentNodeTitle}
          totalNodeCount={gen.totalNodeCount}
          executedNodeCount={gen.executedNodeCount}
          samplingProgress={gen.samplingProgress}
          previewUrl={gen.previewUrl}
          elapsedSeconds={gen.elapsedSeconds}
          totalElapsedSeconds={gen.totalElapsedSeconds}
          eta={gen.eta}
          error={gen.error}
          result={gen.result}
          connectionLost={gen.connectionLost}
          recovering={gen.recovering}
          wsStatus={gen.wsStatus}
          onCancel={() => gen.cancel()}
          onOpenViewer={(i) => setViewerUrl(gen.result?.urls[i] ?? null)}
        />

        <ImportPngButton onImport={(imported) => setSettings((s) => ({ ...s, ...imported }))} />

        <ImageUploader value={settings.inputImage} onChange={(img) => update('inputImage', img)} />

        <div className="field">
          <label className="field-label">Prompt</label>
          <textarea
            className="prompt-textarea"
            rows={6}
            value={settings.prompt}
            onChange={(e) => update('prompt', e.target.value)}
            placeholder="Videoda ne olmasını istediğini yaz…"
          />
        </div>

        <div className="field">
          <label className="field-label">En-Boy Oranı</label>
          <select value={settings.aspectRatio} onChange={(e) => update('aspectRatio', e.target.value)} disabled={objectInfo.loading}>
            {!objectInfo.aspectRatios.includes(settings.aspectRatio) && (
              <option value={settings.aspectRatio}>{settings.aspectRatio}</option>
            )}
            {objectInfo.aspectRatios.map((ar) => (
              <option key={ar} value={ar}>
                {ar}
              </option>
            ))}
          </select>
        </div>

        <div className="field-row">
          <div className="field">
            <label className="field-label">Süre (saniye)</label>
            <NumberField min={1} max={30} step={1} value={settings.videoLengthSeconds} onChange={(v) => update('videoLengthSeconds', v)} />
          </div>
          <div className="field">
            <label className="field-label">FPS</label>
            <NumberField min={8} max={60} step={1} value={settings.framerate} onChange={(v) => update('framerate', v)} />
          </div>
        </div>

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

        <div className="field">
          <label className="field-label">Model</label>
          <select value={settings.unetName} onChange={(e) => update('unetName', e.target.value)} disabled={objectInfo.loading}>
            {!objectInfo.unetNames.includes(settings.unetName) && (
              <option value={settings.unetName}>{settings.unetName}</option>
            )}
            {objectInfo.unetNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <LoraList loras={settings.loras} loraNames={objectInfo.loraNames} onChange={updateLora} />

        <div className="field-row">
          <div className="field">
            <label className="field-label">Megapiksel</label>
            <NumberField min={0.1} max={4} step={0.1} value={settings.megapixels} onChange={(v) => update('megapixels', v)} />
          </div>
          <div className="field">
            <label className="field-label">Adım Sayısı</label>
            <NumberField min={1} max={50} step={1} value={settings.totalSteps} onChange={(v) => update('totalSteps', v)} />
          </div>
        </div>

        <div className="field">
          <label className="field-label">Batch Count (arka arkaya üretilecek video sayısı)</label>
          <NumberField min={1} max={20} step={1} value={settings.batchCount} onChange={(v) => update('batchCount', v)} />
          {settings.batchCount > 1 && (
            <span className="field-hint">
              Video modelinin gerçek batch desteği yok — {settings.batchCount} ayrı iş art arda kuyruğa eklenecek.
            </span>
          )}
        </div>

        {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}

        <button type="button" className="generate-button" disabled={!canGenerate} onClick={handleGenerate}>
          {isBusy ? '+ Kuyruğa Ekle' : 'Oluştur'}
        </button>
      </main>

      {viewerUrl !== null && (
        <GenerationFullscreenViewer
          items={completedResults.map((r) => ({ url: r.url, kind: 'video' as const }))}
          index={completedResults.findIndex((r) => r.url === viewerUrl)}
          onIndexChange={(i) => setViewerUrl(completedResults[i]?.url ?? null)}
          onClose={() => setViewerUrl(null)}
        />
      )}
    </div>
  )
}
