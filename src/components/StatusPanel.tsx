import { useRef } from 'react'
import type { Eta, GenerationResult, GenerationStatus, SamplingProgress } from '../hooks/useComfyGeneration'

interface Props {
  status: GenerationStatus
  currentNodeTitle: string | null
  totalNodeCount: number
  executedNodeCount: number
  samplingProgress: SamplingProgress | null
  elapsedSeconds: number
  totalElapsedSeconds: number | null
  eta: Eta
  error: string | null
  result: GenerationResult | null
  connectionLost: boolean
  onCancel: () => void
}

function formatEta(eta: Eta): string | null {
  if (eta === null) return null
  if (eta === 'calculating') return 'Hesaplanıyor…'
  return `~${eta} sn`
}

export function StatusPanel({
  status,
  currentNodeTitle,
  totalNodeCount,
  executedNodeCount,
  samplingProgress,
  elapsedSeconds,
  totalElapsedSeconds,
  eta,
  error,
  result,
  connectionLost,
  onCancel,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)

  if (status === 'idle') return null

  if (status === 'error') {
    return (
      <div className="status-panel status-panel-error">
        <div className="status-title">Hata</div>
        <div className="field-error">{error}</div>
      </div>
    )
  }

  if (status === 'done' && result) {
    return (
      <div className="status-panel status-panel-done">
        <div className="status-title">✓ Üretim Tamamlandı</div>
        {totalElapsedSeconds !== null && <div className="status-row">Toplam süre: {totalElapsedSeconds} sn</div>}
        <button type="button" className="secondary-button" onClick={() => videoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          Sonucu Görüntüle
        </button>
        <video ref={videoRef} className="result-video" src={result.url} controls autoPlay loop playsInline />
      </div>
    )
  }

  // queued / running
  const isSampling = samplingProgress !== null
  const pct = isSampling
    ? Math.round((samplingProgress.value / Math.max(samplingProgress.max, 1)) * 100)
    : totalNodeCount > 0
      ? Math.round((executedNodeCount / totalNodeCount) * 100)
      : 0
  const etaLabel = formatEta(eta)

  return (
    <div className="status-panel">
      <div className="status-title">{status === 'queued' ? 'Sırada bekleniyor…' : 'Oluşturuluyor…'}</div>

      {connectionLost && (
        <div className="status-warning">⚠ ComfyUI'ye ulaşılamıyor — sunucu kapalı veya çökmüş olabilir. Yeniden denenmeye devam ediliyor…</div>
      )}

      <div className="status-stage">
        {isSampling ? (
          <>
            Sampling {samplingProgress.value} / {samplingProgress.max}
          </>
        ) : (
          currentNodeTitle && <>İşleniyor: {currentNodeTitle}</>
        )}
      </div>

      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="status-row status-row-right">{pct}%</div>

      <div className="status-row">
        <span>Geçen süre</span>
        <span>{elapsedSeconds} sn</span>
      </div>
      {etaLabel && (
        <div className="status-row">
          <span>Kalan süre</span>
          <span>{etaLabel}</span>
        </div>
      )}

      <button type="button" className="generate-button generate-button-cancel" onClick={onCancel}>
        İptal Et
      </button>
    </div>
  )
}
