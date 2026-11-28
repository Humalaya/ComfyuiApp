import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ImageUploader } from './components/ImageUploader'
import { mergeLoras, type LoraAdd } from './workflow/loraMerge'
import { NumberField } from './components/NumberField'
import { CollapsibleSection } from './components/CollapsibleSection'
import { ImportPngButton } from './components/ImportPngButton'
import { LoraList } from './components/LoraList'
import { appendTriggerWords } from './utils/promptText'
import { StatusPanel } from './components/StatusPanel'
import { GenerationFullscreenViewer } from './components/GenerationFullscreenViewer'
import { Gallery, type ImportPayload } from './components/Gallery'
import { GalleryLockGate } from './components/GalleryLock'
import { ImageGenerateTab } from './components/ImageGenerateTab'
import { Krea2GenerateTab } from './components/Krea2GenerateTab'
import { QwenEditGenerateTab } from './components/QwenEditGenerateTab'
import { SettingsTab } from './components/SettingsTab'
import { UpdateBanner } from './components/UpdateBanner'
import { UretDrawer, type UretView } from './components/UretDrawer'
import { OpenWebUiFrame } from './components/OpenWebUiFrame'
import { CivitaiBrowser } from './components/CivitaiBrowser'
import type { ModelRef } from './components/CivitaiModelPage'
import { ModelsView } from './components/ModelsView'
import { HelpTip } from './components/HelpTip'
import { randomSeed, SeedField } from './components/SeedField'
import { exitApp, useRootBackHandler } from './native/backButton'
import { modelLabel } from './utils/modelLabel'
import { applyVideoAlignment, effectiveVideoSeconds, hasImg2Vid, toggleImg2Vid, videoTask } from './workflow/videoPromptModes'
import { useObjectInfo } from './hooks/useObjectInfo'
import { useComfyGeneration } from './hooks/useComfyGeneration'
import { buildWorkflow, getDefaultSettings, referenceImages, type GenerationSettings, type LoraSlot } from './workflow/fieldMap'
import type { ImageGenerationSettings } from './workflow/imageFieldMap'
import type { Krea2GenerationSettings } from './workflow/krea2FieldMap'
import type { QwenEditSettings, ImageRef as QwenImageRef } from './workflow/qwenEditFieldMap'
import { loadSettings, normalizeSettings, saveSettings } from './storage/settingsStorage'
import { useRemoteQueue } from './storage/remoteQueueStorage'
import { PromptGenerator } from './components/PromptGenerator'

// This kind's key in the output-server's shared /api/state/:kind/* store —
// see remoteQueueStorage.ts for why that's PC RAM now, not phone localStorage.
const QUEUE_KIND = 'video'

// A settings payload pushed at ImageGenerateTab/Krea2GenerateTab from
// outside (Galeri's "send to create") — those two tabs own their settings
// state entirely locally (unlike the video tab, which App.tsx already holds
// directly), so this is how App.tsx hands them something to merge in. `id`
// is a nonce: without it, sending the exact same settings object twice in a
// row (same PNG, same "Ayarları Gönder" tap) wouldn't register as a change
// and the second send would silently do nothing.
export interface PendingImport<T> {
  settings: Partial<T>
  id: number
  // LoRAs to switch on in the tab's list (loraMerge.ts).
  addLoras?: LoraAdd[]
}

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
//
// Top nav is three entries: [ Üret ] [ Galeri ] [ ⚙ ]. "Üret" is not a plain
// tab: a tap from Galeri/Ayarlar comes back to the sub-view you last had
// open, a tap while already on it opens the drawer to switch (see
// UretDrawer), and a long-press jumps back to the previous sub-view.
// Galeri and Ayarlar (the gear) are ordinary tabs.
type Tab = 'uret' | 'gallery' | 'settings'
// UretView ('image' | 'video' | 'civitai' | 'openwebui') — the sub-views
// behind "Üret"; defined with the drawer that switches between them.
// 'civitai' browses Civitai's image/video feed (CivitaiBrowser.tsx);
// 'openwebui' is the OpenWebUI instance on this same PC (:3000), embedded
// as an iframe.

const WIDE_VIEWS = new Set(['uret:civitai', 'uret:models', 'gallery'])

const URET_VIEW_LABEL: Record<UretView, string> = {
  image: 'Görsel',
  video: 'Video',
  civitai: 'Civitai',
  openwebui: 'OpenWebUI',
  models: 'Modeller',
}

// Which "Üret" sub-view to restore on next launch — a plain reload (screen
// lock, OEM kill, manual refresh) shouldn't always dump you back on Görsel.
const URET_VIEW_KEY = 'mobile-control:uret-view'
function loadUretView(): UretView {
  try {
    const v = localStorage.getItem(URET_VIEW_KEY)
    if (v === 'image' || v === 'video' || v === 'civitai' || v === 'openwebui' || v === 'models') return v
  } catch {
    /* private mode / unavailable — fall through to the default */
  }
  return 'image'
}
function saveUretView(v: UretView): void {
  try {
    localStorage.setItem(URET_VIEW_KEY, v)
  } catch {
    /* best effort */
  }
}

const OFFSCREEN_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: '-200vw',
  // Same width .app gives it when shown (640px max, 16px side padding).
  width: 'min(640px, calc(100vw - 32px))',
  visibility: 'hidden',
  pointerEvents: 'none',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('uret')
  const [uretView, setUretView] = useState<UretView>(loadUretView)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // OpenWebUI's iframe is only mounted once you've actually opened it once,
  // then kept mounted (hidden) so switching away and back doesn't reload the
  // whole chat UI / drop its session. No reason to load a second web app on
  // startup for someone who never touches that view.
  const [openWebUiVisited, setOpenWebUiVisited] = useState(() => loadUretView() === 'openwebui')
  // Same lazy-mount-then-keep idea for the Civitai browser — no reason to hit
  // Civitai's API on every app start for someone who never opens it.
  const [civitaiVisited, setCivitaiVisited] = useState(() => loadUretView() === 'civitai')
  const [modelsVisited, setModelsVisited] = useState(() => loadUretView() === 'models')
  // Modeller → "Civitai sayfası": opens that model's page in the Civitai view.
  const [civitaiModelRequest, setCivitaiModelRequest] = useState<ModelRef | null>(null)
  // The sub-view before the current one — long-press on Üret goes back to it.
  const previousView = useRef<UretView | null>(null)
  const [imageModel, setImageModel] = useState<'sdxl' | 'krea2' | 'qwenedit'>('sdxl')
  // See PendingImport above — null means "nothing pending", each tab only
  // reacts when `id` actually changes.
  const [imageImportRequest, setImageImportRequest] = useState<PendingImport<ImageGenerationSettings> | null>(null)
  const [krea2ImportRequest, setKrea2ImportRequest] = useState<PendingImport<Krea2GenerationSettings> | null>(null)
  const [qwenEditImportRequest, setQwenEditImportRequest] = useState<PendingImport<
    QwenEditSettings & { inputImage?: QwenImageRef | null }
  > | null>(null)
  // Restores whatever was last saved (prompt, seed, model, LoRAs, input
  // image reference, ...) so a reload — screen lock, OEM background kill,
  // manual refresh — doesn't wipe the form back to scratch. Only a true
  // first-ever launch (nothing saved yet) falls back to the workflow
  // template's defaults, and only then does the seed get randomized — once
  // something is saved, the seed is whatever the user left it at, same as
  // every other field.
  const [settings, setSettings] = useState<GenerationSettings>(() => loadSettings() ?? { ...getDefaultSettings(), seed: randomSeed() })
  // Jobs waiting to run — held *and run* by the PC's output-server (see
  // remoteQueueStorage.ts), so the queue keeps going while the phone is
  // locked or the app is closed.
  const { queue, comfyUp, queueError, append, remove, dismissError } = useRemoteQueue(QUEUE_KIND, normalizeSettings)
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
  const objectInfo = useObjectInfo()
  const gen = useComfyGeneration()

  const isBusy = gen.status === 'queued' || gen.status === 'running' || queue.length > 0

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
    saveUretView(uretView)
  }, [uretView])

  // Switch which "Üret" sub-view is showing and make sure we're on the Üret
  // tab — shared by the drawer, the nav button, and Gallery's "send to
  // create" hand-off below.
  function goToUret(view: UretView) {
    if (view !== uretView) previousView.current = uretView
    setUretView(view)
    if (view === 'openwebui') setOpenWebUiVisited(true)
    if (view === 'civitai') setCivitaiVisited(true)
    if (view === 'models') setModelsVisited(true)
    setTab('uret')
    setDrawerOpen(false)
  }

  // The home screen is whichever of Görsel/Video was used last: the Android
  // back button returns there from any other view, and exits from there.
  const homeView = useRef<UretView>(uretView === 'image' || uretView === 'video' ? uretView : 'image')
  useEffect(() => {
    if (uretView === 'image' || uretView === 'video') homeView.current = uretView
  }, [uretView])

  // Overlays (viewers, the drawer, popups…) handle back themselves via
  // useBackHandler; this only runs when none of them is open. At home,
  // the first press only shows a hint — a second one within 2 s exits.
  const [exitHint, setExitHint] = useState(false)
  const lastHomeBackAt = useRef(0)
  useRootBackHandler(() => {
    const atHome = tab === 'uret' && (uretView === 'image' || uretView === 'video')
    if (!atHome) {
      goToUret(homeView.current)
      return
    }
    const now = Date.now()
    if (now - lastHomeBackAt.current < 2000) {
      exitApp()
      return
    }
    lastHomeBackAt.current = now
    setExitHint(true)
  })
  useEffect(() => {
    if (!exitHint) return
    const t = setTimeout(() => setExitHint(false), 2000)
    return () => clearTimeout(t)
  }, [exitHint])

  // Every view scrolls the same window, so switching views used to leave the
  // page wherever the previous one was — usually clamped to the top. Each
  // view's own position is remembered and restored when it's shown again.
  const viewKey = tab === 'uret' ? `uret:${uretView}` : tab
  const scrollByView = useRef(new Map<string, number>())
  const shownView = useRef(viewKey)
  useEffect(() => {
    const onScroll = () => scrollByView.current.set(shownView.current, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    if (shownView.current === viewKey) return
    shownView.current = viewKey
    window.scrollTo(0, scrollByView.current.get(viewKey) ?? 0)
  }, [viewKey])

  // The "Üret" nav button: a tap from another tab returns to the current
  // sub-view, a tap while already there opens the drawer; a long-press
  // jumps to the previous sub-view (quick back-and-forth between two).
  // Pointer events (not touch+mouse both) so the handlers fire once, not
  // twice, on a phone. The ref-tracked flag swallows the click that fires
  // when the finger lifts after a long-press.
  const uretPressTimer = useRef<number | null>(null)
  const uretLongFired = useRef(false)

  function beginUretPress() {
    uretLongFired.current = false
    if (uretPressTimer.current) window.clearTimeout(uretPressTimer.current)
    uretPressTimer.current = window.setTimeout(() => {
      uretLongFired.current = true
      const prev = previousView.current
      if (prev && prev !== uretView) goToUret(prev)
      else setTab('uret')
    }, 450)
  }
  function endUretPress() {
    if (uretPressTimer.current) {
      window.clearTimeout(uretPressTimer.current)
      uretPressTimer.current = null
    }
  }
  function onUretClick() {
    if (uretLongFired.current) {
      uretLongFired.current = false
      return
    }
    if (tab === 'uret') setDrawerOpen(true)
    else setTab('uret')
  }

  // Collects each finished result into the "recently finished" strip. The
  // queue itself advances on the server, not here.
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

  // A persisted unetName can go stale in a way that still *looks* fine in
  // the dropdown — e.g. this app's own model-folder reorganization earlier
  // changed every video model's required subfolder prefix, so a value saved
  // before that (e.g. "minimaxH3INT8INT4_fl2vaINT8Pruned.safetensors" with
  // no "Video/" prefix) keeps rendering as a normal-looking selected option
  // (loadSettings() restores it verbatim, and the <select> below falls back
  // to a synthetic <option> for it when it's not in the live list) right up
  // until it's actually submitted, where ComfyUI rejects it outright:
  // "Model in folder 'diffusion_models' with filename '...' not found." Same
  // fix as ImageGenerateTab.tsx's identical checkpoint effect — snap back to
  // whatever ComfyUI actually reports the moment that list loads, instead of
  // only ever finding out a saved model went stale when a generation fails.
  useEffect(() => {
    if (objectInfo.unetNames.length === 0) return
    if (!objectInfo.unetNames.includes(settings.unetName)) {
      update('unetName', objectInfo.unetNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectInfo.unetNames])

  // Settings sent over from Galeri (a PNG's metadata) or Civitai — routes
  // each to its own Create tab and switches to it.
  function handleImport(payload: ImportPayload) {
    if (payload.kind === 'video') {
      // fixedSeed is already set to true inside pngImport.ts whenever
      // a seed was actually recognized, so this merge doesn't need to
      // special-case it.
      setSettings((s) => {
        const next = { ...s, ...payload.settings }
        return payload.addLoras ? { ...next, loras: mergeLoras(next.loras, payload.addLoras).loras } : next
      })
      goToUret('video')
    } else if (payload.kind === 'sdxl') {
      setImageImportRequest({ settings: payload.settings, addLoras: payload.addLoras, id: Date.now() })
      setImageModel('sdxl')
      goToUret('image')
    } else if (payload.kind === 'krea2') {
      setKrea2ImportRequest({ settings: payload.settings, addLoras: payload.addLoras, id: Date.now() })
      setImageModel('krea2')
      goToUret('image')
    } else {
      setQwenEditImportRequest({ settings: payload.settings, id: Date.now() })
      setImageModel('qwenedit')
      goToUret('image')
    }
  }

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

  const [submitting, setSubmitting] = useState(false)

  async function handleGenerate() {
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
    setSubmitting(true)
    try {
      // Built here (the app owns the workflow templates); the server only
      // runs them, one at a time, starting right away if ComfyUI is idle.
      await append(items.map((s) => ({ settings: s, workflow: buildWorkflow(s) })))
      gen.checkRemoteJob()
    } catch (err) {
      alert(`Kuyruğa eklenemedi: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Shared by StatusPanel's thumbnail strips (both the compact one shown
  // while queued/running and the full one in the "done" card) and
  // GenerationFullscreenViewer — computed once here instead of separately
  // at each call site.
  const historyUrls = completedResults.map((r) => r.url)

  return (
    <div
      // Browsing views spread out on a wide (desktop) screen — see .app-wide.
      className={WIDE_VIEWS.has(viewKey) ? 'app app-wide' : 'app'}
      style={{ '--header-height': `${headerHeight}px` } as CSSProperties}
    >
      <UpdateBanner />
      <header className="app-header" ref={headerRef}>
        <h1>MiniMax H3 Mobil Kontrol</h1>
        <nav className="tabs">
          <button
            className={tab === 'uret' ? 'tab tab-active' : 'tab'}
            onClick={onUretClick}
            onPointerDown={beginUretPress}
            onPointerUp={endUretPress}
            onPointerLeave={endUretPress}
            onPointerCancel={endUretPress}
            onContextMenu={(e) => e.preventDefault()}
            aria-haspopup="menu"
            title="Dokun: menü · Uzun bas: önceki ekran"
          >
            {URET_VIEW_LABEL[uretView]}
            <span className="tab-caret" aria-hidden="true">
              {' '}
              ▾
            </span>
          </button>
          <button className={tab === 'gallery' ? 'tab tab-active' : 'tab'} onClick={() => setTab('gallery')}>
            Galeri
          </button>
          <button
            className={tab === 'settings' ? 'tab tab-active tab-icon' : 'tab tab-icon'}
            onClick={() => setTab('settings')}
            aria-label="Ayarlar"
            title="Ayarlar"
          >
            ⚙
          </button>
        </nav>
      </header>

      {/* All tabs stay permanently mounted (just hidden via display:none)
          instead of being conditionally unmounted — Gallery previously lost
          its scroll position, selected source and current folder every time
          you switched away and back, since unmounting it threw all of that
          state away; the same would happen to in-progress generations on
          either generate tab. */}
      <div style={{ display: tab === 'uret' && uretView === 'image' ? 'block' : 'none' }}>
        <div className="seg seg-accent uret-model-seg">
          <button
            type="button"
            className={imageModel === 'sdxl' ? 'seg-btn seg-btn-active' : 'seg-btn'}
            onClick={() => setImageModel('sdxl')}
          >
            SDXL
          </button>
          <button
            type="button"
            className={imageModel === 'krea2' ? 'seg-btn seg-btn-active' : 'seg-btn'}
            onClick={() => setImageModel('krea2')}
          >
            Krea2 (FLUX)
          </button>
          <button
            type="button"
            className={imageModel === 'qwenedit' ? 'seg-btn seg-btn-active' : 'seg-btn'}
            onClick={() => setImageModel('qwenedit')}
          >
            Edit (Qwen)
          </button>
        </div>
        {/* Both stay mounted for the same reason as the outer tabs — switching
            between model families shouldn't lose an in-progress generation. */}
        <div style={{ display: imageModel === 'sdxl' ? 'block' : 'none' }}>
          <ImageGenerateTab importRequest={imageImportRequest} />
        </div>
        <div style={{ display: imageModel === 'krea2' ? 'block' : 'none' }}>
          <Krea2GenerateTab importRequest={krea2ImportRequest} />
        </div>
        <div style={{ display: imageModel === 'qwenedit' ? 'block' : 'none' }}>
          <QwenEditGenerateTab importRequest={qwenEditImportRequest} />
        </div>
      </div>

      <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
        <SettingsTab active={tab === 'settings'} />
      </div>

      <div style={{ display: tab === 'gallery' ? 'block' : 'none' }}>
        <GalleryLockGate active={tab === 'gallery'}>
          {(requestLock) => <Gallery active={tab === 'gallery'} onSendToCreate={handleImport} onLock={requestLock} />}
        </GalleryLockGate>
      </div>

      <main className="form" style={{ display: tab === 'uret' && uretView === 'video' ? 'flex' : 'none' }}>
        {/* At the top: reachable without scrolling past the whole form. */}
        <button type="button" className="generate-button" disabled={!canGenerate || submitting} onClick={handleGenerate}>
          {isBusy ? '+ Kuyruğa Ekle' : settings.batchCount > 1 ? `Oluştur · ${settings.batchCount}` : 'Oluştur'}
        </button>

        {/* Output first, form fields below — so the current job's progress
            or result is visible the moment this tab opens, without scrolling
            past the whole form to find out whether anything even finished. */}
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
          onOpenViewer={setViewerUrl}
          historyUrls={historyUrls}
        />

        <ImportPngButton onImport={(imported) => setSettings((s) => ({ ...s, ...imported }))} />

        <div className="field">
          <span className="field-label">
            Video modu
            <HelpTip>
              İş akışındaki "Which Model to Use?" seçimi. <b>İlk / son kare</b> (FL2VA): görseller videonun ilk ve son karesidir; ikisi de
              kapalıysa düz metinden üretilir. <b>Referans</b> (REF2VA): görseller videoda görünecek karakter, kıyafet, mekân ya da stil
              için referanstır — kare değil. Prompt onlara &lt;Picture 1&gt;, &lt;Picture 2&gt; diye işaret eder; ✨ Prompt bu modda
              referans formatında yazar.
            </HelpTip>
          </span>
          <div className="seg" role="group" aria-label="Video modu">
            <button
              type="button"
              className={settings.videoMode === 'frames' ? 'seg-btn seg-btn-active' : 'seg-btn'}
              onClick={() => update('videoMode', 'frames')}
            >
              İlk / son kare
            </button>
            <button
              type="button"
              className={settings.videoMode === 'reference' ? 'seg-btn seg-btn-active' : 'seg-btn'}
              // The first-frame alignment line means nothing to the reference
              // node — dropped on the way in.
              onClick={() =>
                setSettings((s) => ({ ...s, videoMode: 'reference', prompt: hasImg2Vid(s.prompt) ? toggleImg2Vid(s.prompt) : s.prompt }))
              }
            >
              Referans
            </button>
          </div>
        </div>

        <div className="picture-frame-row">
          <ImageUploader
            label={settings.videoMode === 'reference' ? 'Referans 1' : 'İlk kare'}
            help={
              settings.videoMode === 'reference'
                ? '<Picture 1> — bir referans görsel (ör. karakter). Videonun karesi değil; prompt ona <Picture 1> diye işaret eder. Kapatmak seçili görseli silmez.'
                : 'Picture 1 — videonun başlangıç karesi. Kapalıyken video düz metinden üretilir (txt2vid). Kapatmak seçili görseli silmez.'
            }
            enabled={settings.inputImageEnabled}
            onToggleEnabled={(enabled) => update('inputImageEnabled', enabled)}
            value={settings.inputImage}
            onChange={(img) => update('inputImage', img)}
          />
          <ImageUploader
            label={settings.videoMode === 'reference' ? 'Referans 2' : 'Son kare'}
            help={
              settings.videoMode === 'reference'
                ? '<Picture 2> — ikinci referans (ör. mekân ya da ikinci karakter). Referans 1 kapalıyken bu <Picture 1> olur.'
                : 'Picture 2 — videonun bitiş karesi. Açıkken video ilk kareden bu kareye doğru ilerler. Kapalıyken video ilk kareden (ya da düz metinden) normal şekilde üretilir.'
            }
            enabled={settings.lastFrameEnabled}
            onToggleEnabled={(enabled) => update('lastFrameEnabled', enabled)}
            value={settings.lastFrameImage}
            onChange={(img) => update('lastFrameImage', img)}
          />
        </div>

        {settings.videoMode === 'reference' && (
          <div className="picture-frame-row">
            {settings.extraRefs.map((ref, i) => (
              <ImageUploader
                key={i}
                label={`Referans ${i + 3}`}
                help={`İsteğe bağlı ${i + 3}. referans (ör. bir eşya, kıyafet ya da başka bir karakter). Prompt açık referanslara sırayla <Picture 1>, <Picture 2>… diye işaret eder — kapalı olan sıradakilerin numarasını kaydırır.`}
                enabled={ref.on}
                onToggleEnabled={(on) => setSettings((s) => ({ ...s, extraRefs: s.extraRefs.map((r, j) => (j === i ? { ...r, on } : r)) }))}
                value={ref.image}
                onChange={(image) => setSettings((s) => ({ ...s, extraRefs: s.extraRefs.map((r, j) => (j === i ? { ...r, image } : r)) }))}
              />
            ))}
          </div>
        )}

        {settings.videoMode === 'reference' && (
          <div className="field">
            <span className="field-label">
              Referans kalitesi
              <HelpTip>
                <b>Hızlı</b> (match): referanslar videonun boyutuna küçültülür. <b>En iyi kimlik</b> (max): referanslar 2048 px kısa kenarda
                kalır — yüz ve ayrıntı en iyi korunur ama üretim birkaç kat yavaşlar.
              </HelpTip>
            </span>
            <div className="seg" role="group" aria-label="Referans kalitesi">
              <button
                type="button"
                className={settings.refImageSize === 'match' ? 'seg-btn seg-btn-active' : 'seg-btn'}
                onClick={() => update('refImageSize', 'match')}
              >
                Hızlı
              </button>
              <button
                type="button"
                className={settings.refImageSize === 'max' ? 'seg-btn seg-btn-active' : 'seg-btn'}
                onClick={() => update('refImageSize', 'max')}
              >
                En iyi kimlik
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <div className="field-label" id="video-prompt-label">
            Prompt
            <HelpTip>
              <b>img2vid</b> (İlk / son kare modunda): prompt'un başına MiniMax'in "ilk kare" cümlesini ekler — ✨ Prompt bunu zaten kendisi
              ekler, elle yazdığın promptlar için. Referans modunda prompt'un summary: kısmı [reference generation] ile başlamalı.
            </HelpTip>
            <PromptGenerator
              library={{ kind: 'video', prompt: settings.prompt, onUse: (p) => update('prompt', p.prompt) }}

              target={settings.videoMode === 'reference' ? 'videoref' : 'video'}
              // Frames mode: the task type follows the wired frames, and the
              // official keyframe line (final shot / duration) is added to
              // every suggestion by the app. Reference mode: the six-section
              // REF2VA format, told which <Picture N> exist.
              context={(() => {
                const seconds = `duration: ${effectiveVideoSeconds(settings.videoLengthSeconds).toFixed(2)} seconds`
                const aspect = settings.aspectRatio ? `; aspect: ${settings.aspectRatio}` : ''
                if (settings.videoMode === 'reference') {
                  const n = referenceImages(settings).length
                  const refs = n === 0 ? 'none' : Array.from({ length: n }, (_, i) => `<Picture ${i + 1}>`).join(', ')
                  return `Task: REF2VA; references: ${refs}; ${seconds}${aspect}`
                }
                const task = videoTask(
                  settings.inputImageEnabled && !!settings.inputImage,
                  settings.lastFrameEnabled && !!settings.lastFrameImage,
                )
                // The aspect ratio only matters without a reference picture
                // (with one, the picture sets the framing).
                return `Task: ${task}; ${seconds}${task === 'T2VA' ? aspect : ''}`
              })()}
              postProcess={
                settings.videoMode === 'reference'
                  ? undefined
                  : (text) =>
                      applyVideoAlignment(
                        text,
                        videoTask(
                          settings.inputImageEnabled && !!settings.inputImage,
                          settings.lastFrameEnabled && !!settings.lastFrameImage,
                        ),
                        settings.videoLengthSeconds,
                      )
              }
              onUse={(text) => update('prompt', text)}
            />
          </div>
          {settings.videoMode === 'frames' && (
            <div className="chip-row chip-row-flush">
              <button
                type="button"
                className={hasImg2Vid(settings.prompt) ? 'chip chip-active' : 'chip'}
                onClick={() => update('prompt', toggleImg2Vid(settings.prompt))}
              >
                img2vid
              </button>
            </div>
          )}
          <textarea
            aria-labelledby="video-prompt-label"
            className="prompt-textarea"
            rows={6}
            value={settings.prompt}
            onChange={(e) => update('prompt', e.target.value)}
            placeholder="Videoda ne olmasını istediğini yaz…"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="video-en-boy-orani">
            En-Boy Oranı
          </label>
          <select
            id="video-en-boy-orani"
            value={settings.aspectRatio}
            onChange={(e) => update('aspectRatio', e.target.value)}
            disabled={objectInfo.loading}
          >
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
            <label className="field-label" htmlFor="video-sure-saniye">
              Süre (saniye)
            </label>
            <NumberField
              id="video-sure-saniye"
              min={1}
              max={30}
              step={1}
              value={settings.videoLengthSeconds}
              onChange={(v) => update('videoLengthSeconds', v)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="video-fps">
              FPS
            </label>
            <NumberField id="video-fps" min={8} max={60} step={1} value={settings.framerate} onChange={(v) => update('framerate', v)} />
          </div>
        </div>

        <SeedField
          seed={settings.seed}
          fixed={settings.fixedSeed}
          onSeedChange={(v) => update('seed', v)}
          onFixedChange={(v) => update('fixedSeed', v)}
        />

        <div className="field">
          <label className="field-label" htmlFor="video-model">
            Model
          </label>
          <select
            id="video-model"
            value={settings.unetName}
            onChange={(e) => update('unetName', e.target.value)}
            disabled={objectInfo.loading}
          >
            {!objectInfo.unetNames.includes(settings.unetName) && <option value={settings.unetName}>{settings.unetName}</option>}
            {objectInfo.unetNames.map((name) => (
              <option key={name} value={name}>
                {modelLabel(name)}
              </option>
            ))}
          </select>
        </div>

        <LoraList
          loras={settings.loras}
          loraNames={objectInfo.loraNames}
          tab="video"
          onChange={updateLora}
          onSendToPrompt={(words) => update('prompt', appendTriggerWords(settings.prompt, words))}
        />

        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="video-megapiksel">
              Megapiksel
              <HelpTip>
                Videonun çözünürlüğü — seçilen en-boy oranında toplam piksel sayısı (milyon). Yükseldikçe kalite de üretim süresi de artar.
              </HelpTip>
            </label>
            <NumberField
              id="video-megapiksel"
              min={0.1}
              max={4}
              step={0.1}
              value={settings.megapixels}
              onChange={(v) => update('megapixels', v)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="video-adim-sayisi">
              Adım Sayısı
            </label>
            <NumberField
              id="video-adim-sayisi"
              min={1}
              max={50}
              step={1}
              value={settings.totalSteps}
              onChange={(v) => update('totalSteps', v)}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="video-batch-count">
            Batch Count
            <HelpTip>
              Arka arkaya üretilecek video sayısı. Video modelinin gerçek batch desteği yok — her video ayrı bir iş olarak kuyruğa eklenir,
              Sabit kapalıysa her birine yeni seed seçilir.
            </HelpTip>
          </label>
          <NumberField
            id="video-batch-count"
            min={1}
            max={20}
            step={1}
            value={settings.batchCount}
            onChange={(v) => update('batchCount', v)}
          />
        </div>

        <CollapsibleSection title="Gelişmiş Ayarlar">
          <div className="field">
            <label className="field-label" htmlFor="video-sampler">
              Sampler
            </label>
            <select
              id="video-sampler"
              value={settings.samplerName}
              onChange={(e) => update('samplerName', e.target.value)}
              disabled={objectInfo.loading}
            >
              {!objectInfo.samplerNames.includes(settings.samplerName) && (
                <option value={settings.samplerName}>{settings.samplerName}</option>
              )}
              {objectInfo.samplerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="video-scheduler">
              Scheduler
            </label>
            <select
              id="video-scheduler"
              value={settings.scheduler}
              onChange={(e) => update('scheduler', e.target.value)}
              disabled={objectInfo.loading}
            >
              {!objectInfo.schedulerNames.includes(settings.scheduler) && <option value={settings.scheduler}>{settings.scheduler}</option>}
              {objectInfo.schedulerNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="video-denoise">
              Denoise
            </label>
            <NumberField id="video-denoise" min={0} max={1} step={0.01} value={settings.denoise} onChange={(v) => update('denoise', v)} />
          </div>
        </CollapsibleSection>

        {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}
      </main>

      <div style={{ display: tab === 'uret' && uretView === 'civitai' ? 'block' : 'none' }}>
        {civitaiVisited && (
          <CivitaiBrowser onSendToCreate={handleImport} onOpenModels={() => goToUret('models')} modelRequest={civitaiModelRequest} />
        )}
      </div>

      <div style={{ display: tab === 'uret' && uretView === 'models' ? 'block' : 'none' }}>
        {modelsVisited && (
          <ModelsView
            active={tab === 'uret' && uretView === 'models'}
            onOpenCivitaiModel={(ref) => {
              setCivitaiModelRequest({ ...ref })
              goToUret('civitai')
            }}
          />
        )}
      </div>

      {/* Not display:none like the other views: that collapses the iframe's
          viewport to zero, which OpenWebUI answers by losing its own scroll
          position in the chat. Parked off-screen at full size instead, so
          from OpenWebUI's side nothing changes while it's hidden. */}
      <div
        style={tab === 'uret' && uretView === 'openwebui' ? undefined : OFFSCREEN_STYLE}
        aria-hidden={!(tab === 'uret' && uretView === 'openwebui')}
      >
        {openWebUiVisited && <OpenWebUiFrame />}
      </div>

      {exitHint && <div className="app-toast">Çıkmak için tekrar geri bas</div>}

      <UretDrawer open={drawerOpen} current={uretView} onSelect={goToUret} onClose={() => setDrawerOpen(false)} />

      {viewerUrl !== null && (
        <GenerationFullscreenViewer
          items={historyUrls.map((url) => ({ url, kind: 'video' as const }))}
          index={historyUrls.indexOf(viewerUrl)}
          onIndexChange={(i) => setViewerUrl(historyUrls[i] ?? null)}
          onClose={() => setViewerUrl(null)}
        />
      )}
    </div>
  )
}
