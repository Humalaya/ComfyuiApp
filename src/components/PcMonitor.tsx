import { useEffect, useState } from 'react'
import { fetchSystemStats, type SystemStats } from '../api/systemStatsClient'
import { formatBytes } from '../api/modelsClient'

const POLL_MS = 2000

// Bar color by how full / hot it is.
function level(percent: number): 'ok' | 'warn' | 'high' {
  return percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok'
}

function tempLevel(c: number | null, warn: number, high: number): string {
  if (c === null) return ''
  return c >= high ? ' pc-mon-hot' : c >= warn ? ' pc-mon-warm' : ''
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div className="pc-mon-meter">
      <div className="pc-mon-meter-head">
        <span className="pc-mon-label">{label}</span>
        <span className="pc-mon-value">{detail}</span>
      </div>
      <div className="pc-mon-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <div className={`pc-mon-fill pc-mon-fill-${level(p)}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  )
}

function uptimeText(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d} g ${h} sa` : h > 0 ? `${h} sa ${m} dk` : `${m} dk`
}

// Ayarlar → live CPU / RAM / swap / GPU / VRAM of the PC, refreshed every
// 2 s while the Ayarlar tab is the visible one (and the app is in front).
export function PcMonitor({ active }: { active: boolean }) {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let timer = 0
    let stopped = false
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const s = await fetchSystemStats()
          if (!stopped) {
            setStats(s)
            setError(null)
          }
        } catch (e) {
          if (!stopped) setError((e as Error).message)
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [active])

  return (
    <section className="settings-section">
      <div className="settings-section-title">💻 PC durumu</div>
      {error && <div className="field-error">{error}</div>}
      {!stats && !error && <div className="field-hint">Yükleniyor…</div>}
      {stats && (
        <div className="pc-mon">
          <Meter label="CPU" percent={stats.cpu.percent} detail={`%${Math.round(stats.cpu.percent)} · ${stats.cpu.cores} çekirdek`} />
          <Meter
            label="RAM"
            percent={(stats.ram.used / stats.ram.total) * 100}
            detail={`${formatBytes(stats.ram.used)} / ${formatBytes(stats.ram.total)}`}
          />
          {stats.swap.total > 0 && (
            <Meter
              label="Swap"
              percent={(stats.swap.used / stats.swap.total) * 100}
              detail={`${formatBytes(stats.swap.used)} / ${formatBytes(stats.swap.total)}`}
            />
          )}
          {stats.gpu ? (
            <>
              <Meter label="GPU" percent={stats.gpu.util ?? 0} detail={`%${stats.gpu.util ?? '?'}`} />
              <Meter
                label="VRAM"
                percent={(stats.gpu.vram.used / stats.gpu.vram.total) * 100}
                detail={`${formatBytes(stats.gpu.vram.used)} / ${formatBytes(stats.gpu.vram.total)}`}
              />
            </>
          ) : (
            <div className="field-hint">Ekran kartı bilgisi alınamadı (nvidia-smi).</div>
          )}
          <div className="pc-mon-chips">
            {stats.cpu.temp !== null && (
              <span className={`pc-mon-chip${tempLevel(stats.cpu.temp, 75, 88)}`}>CPU {Math.round(stats.cpu.temp)}°C</span>
            )}
            {stats.gpu?.temp != null && <span className={`pc-mon-chip${tempLevel(stats.gpu.temp, 75, 85)}`}>GPU {stats.gpu.temp}°C</span>}
            {stats.gpu?.power != null && (
              <span className="pc-mon-chip">
                {Math.round(stats.gpu.power)} W{stats.gpu.powerLimit ? ` / ${Math.round(stats.gpu.powerLimit)} W` : ''}
              </span>
            )}
            {stats.gpu?.fan != null && <span className="pc-mon-chip">Fan %{stats.gpu.fan}</span>}
            <span className="pc-mon-chip">Açık {uptimeText(stats.uptime)}</span>
          </div>
          <div className="pc-mon-names">
            {stats.cpu.model}
            {stats.gpu ? ` · ${stats.gpu.name}` : ''}
          </div>
        </div>
      )}
    </section>
  )
}
