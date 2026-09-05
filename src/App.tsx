import { useEffect, useState } from 'react'
import { ImageUploader } from './components/ImageUploader'
import { NumberField } from './components/NumberField'
import { ImportPngButton } from './components/ImportPngButton'
import { LoraList } from './components/LoraList'
import { StatusPanel } from './components/StatusPanel'
import { Gallery } from './components/Gallery'
import { useObjectInfo } from './hooks/useObjectInfo'
import { useComfyGeneration } from './hooks/useComfyGeneration'
import { getDefaultSettings, type GenerationSettings, type LoraSlot } from './workflow/fieldMap'
import { loadSettings, saveSettings } from './storage/settingsStorage'

type Tab = 'create' | 'gallery'

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000_000)
}

export default function App() {
  const [tab, setTab] = useState<Tab>('create')
  // Restores whatever was last saved (prompt, seed, model, LoRAs, input
  // image reference, ...) so a reload — screen lock, OEM background kill,
  // manual refresh — doesn't wipe the form back to scratch. Only a true
  // first-ever launch (nothing saved yet) falls back to the workflow
  // template's defaults, and only then does the seed get randomized — once
  // something is saved, the seed is whatever the user left it at, same as
  // every other field.
  const [settings, setSettings] = useState<GenerationSettings>(() => loadSettings() ?? { ...getDefaultSettings(), seed: randomSeed() })
  const [queue, setQueue] = useState<GenerationSettings[]>([])
  const objectInfo = useObjectInfo()
  const gen = useComfyGeneration()

  const isBusy = gen.status === 'queued' || gen.status === 'running'

  // Debounced so rapid-fire changes (typing in the prompt textarea) don't
  // hit localStorage on every keystroke — a few hundred ms of lag before a
  // reload would recover the very latest keystroke is an acceptable
  // trade-off for not writing on every single one.
  useEffect(() => {
    const timer = setTimeout(() => saveSettings(settings), 400)
    return () => clearTimeout(timer)
  }, [settings])

  // Drains the queue one item at a time: the moment the active generation
  // reaches a terminal state — done, errored, or manually cancelled (which
  // also lands on 'idle') — immediately start the next queued job. The
  // just-finished result isn't lost when this happens — it's already saved
  // in ComfyUI's output folder (visible in the Galeri tab) and its own
  // completion notification already fired; this just means the on-screen
  // status panel moves on instead of sitting idle. Cancelling one queued job
  // this way skips it and moves on rather than getting the whole queue stuck
  // (there'd be no other trigger to drain it afterwards).
  useEffect(() => {
    if ((gen.status === 'done' || gen.status === 'error' || gen.status === 'idle') && queue.length > 0) {
      const [next, ...rest] = queue
      setQueue(rest)
      gen.generate(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.status])

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

  const canGenerate = settings.prompt.trim().length > 0 && settings.inputImage !== null

  function handleGenerate() {
    // ComfyUI's "easy seed" node has no server-side randomize behavior of its
    // own — it just uses whatever seed value it's given. So unless the user
    // pinned it, a fresh seed is picked here, right before submitting, and
    // the field is updated so it's clear which seed this generation actually used.
    const toSend = settings.fixedSeed ? settings : { ...settings, seed: randomSeed() }
    if (!settings.fixedSeed) setSettings((s) => ({ ...s, seed: toSend.seed }))
    if (isBusy) {
      setQueue((q) => [...q, toSend])
    } else {
      gen.generate(toSend)
    }
  }

  function removeFromQueue(index: number) {
    setQueue((q) => q.filter((_, i) => i !== index))
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>MiniMax H3 Mobil Kontrol</h1>
        <nav className="tabs">
          <button className={tab === 'create' ? 'tab tab-active' : 'tab'} onClick={() => setTab('create')}>
            Oluştur
          </button>
          <button className={tab === 'gallery' ? 'tab tab-active' : 'tab'} onClick={() => setTab('gallery')}>
            Galeri
          </button>
        </nav>
      </header>

      {/* Both tabs stay permanently mounted (just hidden via display:none)
          instead of one being conditionally unmounted — Gallery previously
          lost its scroll position, selected source and current folder every
          time you switched away and back, since unmounting it threw all of
          that state away. */}
      <div style={{ display: tab === 'gallery' ? 'block' : 'none' }}>
        <Gallery
          onSendToCreate={(imported) => {
            // fixedSeed is already set to true inside pngImport.ts whenever a
            // seed was actually recognized, so this merge doesn't need to
            // special-case it.
            setSettings((s) => ({ ...s, ...imported }))
            setTab('create')
          }}
        />
      </div>

      <main className="form" style={{ display: tab === 'create' ? 'flex' : 'none' }}>
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
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              value={settings.videoLengthSeconds}
              onChange={(e) => update('videoLengthSeconds', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label className="field-label">FPS</label>
            <input
              type="number"
              min={8}
              max={60}
              step={1}
              value={settings.framerate}
              onChange={(e) => update('framerate', Number(e.target.value))}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label">Seed</label>
          <div className="seed-row">
            <input type="number" value={settings.seed} onChange={(e) => update('seed', Number(e.target.value))} />
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
            <input
              type="number"
              min={1}
              max={50}
              step={1}
              value={settings.totalSteps}
              onChange={(e) => update('totalSteps', Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field">
          <label className="field-label">Denoise ({settings.denoise.toFixed(2)})</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settings.denoise}
            onChange={(e) => update('denoise', Number(e.target.value))}
          />
        </div>

        {objectInfo.error && <div className="field-error">ComfyUI'den model listeleri alınamadı: {objectInfo.error}</div>}

        <button type="button" className="generate-button" disabled={!canGenerate} onClick={handleGenerate}>
          {isBusy ? '+ Kuyruğa Ekle' : 'Oluştur'}
        </button>

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

        <StatusPanel
          status={gen.status}
          currentNodeTitle={gen.currentNodeTitle}
          totalNodeCount={gen.totalNodeCount}
          executedNodeCount={gen.executedNodeCount}
          samplingProgress={gen.samplingProgress}
          elapsedSeconds={gen.elapsedSeconds}
          totalElapsedSeconds={gen.totalElapsedSeconds}
          eta={gen.eta}
          error={gen.error}
          result={gen.result}
          connectionLost={gen.connectionLost}
          recovering={gen.recovering}
          wsStatus={gen.wsStatus}
          onCancel={() => gen.cancel()}
        />
      </main>
    </div>
  )
}
