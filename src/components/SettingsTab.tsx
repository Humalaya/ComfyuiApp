import { useCallback, useEffect, useState } from 'react'
import { HelpTip } from './HelpTip'
import {
  fetchStartAllStatus,
  fetchSwapModels,
  loadSwapModel,
  shutdownMachine,
  suspendMachine,
  startStack,
  stopStack,
  unloadSwapModel,
  type StartAllStatus,
  type SwapModel,
} from '../api/systemClient'

interface Props {
  // Only poll while the tab is actually on screen — App.tsx keeps every tab
  // mounted (display:none), so without this the Settings tab would keep
  // hitting llama-swap and running port probes every few seconds forever in
  // the background.
  active: boolean
}

const POLL_MS = 3000

export function SettingsTab({ active }: Props) {
  const [models, setModels] = useState<SwapModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [busyModels, setBusyModels] = useState<Record<string, boolean>>({})

  const [stack, setStack] = useState<StartAllStatus | null>(null)
  const [stackError, setStackError] = useState<string | null>(null)
  const [stackBusy, setStackBusy] = useState(false)

  // Two-step so a stray tap can't put the box to sleep or power it off —
  // the first press only arms that action.
  const [powerArmed, setPowerArmed] = useState<'suspend' | 'shutdown' | null>(null)
  const [powerBusy, setPowerBusy] = useState(false)
  const [powerError, setPowerError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetchSwapModels()
      setModels(r.models)
      setModelsError(null)
    } catch (e) {
      setModelsError((e as Error).message)
    }
    try {
      setStack(await fetchStartAllStatus())
      setStackError(null)
    } catch (e) {
      setStackError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [active, refresh])

  // Leaving the tab disarms the confirm — coming back to a pre-armed
  // "Evet" button would be a nasty surprise.
  useEffect(() => {
    if (!active) setPowerArmed(null)
  }, [active])

  async function toggleModel(m: SwapModel) {
    setBusyModels((b) => ({ ...b, [m.id]: true }))
    try {
      if (m.running) await unloadSwapModel(m.id)
      else await loadSwapModel(m.id)
      await refresh()
    } catch (e) {
      setModelsError((e as Error).message)
    } finally {
      setBusyModels((b) => ({ ...b, [m.id]: false }))
    }
  }

  async function runStackAction(fn: () => Promise<unknown>) {
    setStackBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setStackError((e as Error).message)
    } finally {
      setStackBusy(false)
    }
  }

  async function doPower(action: 'suspend' | 'shutdown') {
    setPowerBusy(true)
    setPowerError(null)
    try {
      await (action === 'suspend' ? suspendMachine() : shutdownMachine())
      // No refresh — the machine (and this server) is going away.
    } catch (e) {
      setPowerError((e as Error).message)
      setPowerBusy(false)
      setPowerArmed(null)
    }
  }

  return (
    <div className="form settings-tab">
      <section className="settings-section">
        <div className="settings-section-title">🧠 Modeller (llama-swap)</div>
        {modelsError && <div className="field-error">{modelsError}</div>}
        {!models && !modelsError && <div className="field-hint">Yükleniyor…</div>}
        {models && models.length === 0 && <div className="empty-state">Model bulunamadı.</div>}
        {models?.map((m) => {
          const loading = m.state === 'loading' || m.state === 'starting'
          return (
            <div key={m.id} className="settings-row">
              <div className="settings-row-main">
                <span className="settings-row-name" title={m.id}>
                  {m.name}
                </span>
                <span className="settings-row-sub">{loading ? 'yükleniyor…' : m.running ? 'açık' : 'kapalı'}</span>
              </div>
              <button
                type="button"
                className={m.running ? 'switch switch-on' : 'switch'}
                aria-pressed={m.running}
                aria-label={m.running ? 'Kapat' : 'Aç'}
                disabled={busyModels[m.id]}
                onClick={() => toggleModel(m)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          )
        })}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">🎬 ComfyUI (start-all.sh)</div>
        {stackError && <div className="field-error">{stackError}</div>}
        <div className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">{stack?.comfyUp ? 'ComfyUI çalışıyor' : 'ComfyUI kapalı'}</span>
            <span className="settings-row-sub">
              {stack?.comfyUp ? 'port 8188 açık' : 'port 8188 kapalı'}
              {stack?.running ? ' · bu panelden başlatıldı' : ''}
            </span>
          </div>
          <span className={stack?.comfyUp ? 'settings-dot settings-dot-on' : 'settings-dot'} aria-hidden="true" />
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={stackBusy || !!stack?.running}
            onClick={() => runStackAction(startStack)}
          >
            ▶ Başlat
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={stackBusy || !stack?.running}
            onClick={() => runStackAction(stopStack)}
          >
            ■ Durdur
          </button>
        </div>
        <span className="field-hint">
          "Durdur" yalnızca bu panelden başlatılan kopyayı kapatır. Panel zaten start-all.sh ile açıldıysa tekrar
          başlatmak port çakışması yapar — o durumda önce mevcut stack'i durdur.
        </span>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          ⏻ Bilgisayar
          <HelpTip>
            <b>Uyut:</b> bilgisayar uykuya geçer; ComfyUI ve yüklü modeller olduğu gibi kalır, birkaç saniyede geri gelir. Uyandırmak
            için uygulamayı aç — bilgisayara ulaşamayınca çıkan ekrandaki "Bilgisayarı uyandır" düğmesi evdeki uyandırıcı telefona
            haber verir (Tailscale açıkken her yerden çalışır). ComfyUI'de iş varken uyutmaz.
            <br />
            <br />
            <b>Kapat:</b> her şeyi kapatır — ComfyUI, bu panel ve llama-swap dahil.
          </HelpTip>
        </div>
        {powerError && <div className="field-error">{powerError}</div>}
        {powerArmed === null ? (
          <div className="settings-actions">
            <button type="button" className="secondary-button" onClick={() => setPowerArmed('suspend')}>
              ☾ Uyut
            </button>
            <button type="button" className="secondary-button danger-button" onClick={() => setPowerArmed('shutdown')}>
              ⏻ Kapat
            </button>
          </div>
        ) : (
          <div className="settings-actions">
            <button
              type="button"
              className={powerArmed === 'shutdown' ? 'secondary-button danger-button' : 'secondary-button'}
              disabled={powerBusy}
              onClick={() => doPower(powerArmed)}
            >
              {powerBusy
                ? powerArmed === 'suspend'
                  ? 'Uyutuluyor…'
                  : 'Kapatılıyor…'
                : powerArmed === 'suspend'
                  ? 'Evet, uyut'
                  : 'Evet, kapat'}
            </button>
            <button type="button" className="secondary-button" disabled={powerBusy} onClick={() => setPowerArmed(null)}>
              Vazgeç
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
