import { useRef } from 'react'
import type { ComfyConnectionStatus } from '../api/comfyClient'
import type { Eta, GenerationResult, GenerationStatus, SamplingProgress } from '../hooks/useComfyGeneration'
import { GenerationPreview } from './GenerationPreview'
import { ResultCarousel } from './ResultCarousel'

interface Props {
  status: GenerationStatus
  currentNodeTitle: string | null
  totalNodeCount: number
  executedNodeCount: number
  samplingProgress: SamplingProgress | null
  previewUrl: string | null
  elapsedSeconds: number
  totalElapsedSeconds: number | null
  eta: Eta
  error: string | null
  result: GenerationResult | null
  connectionLost: boolean
  recovering: boolean
  wsStatus: ComfyConnectionStatus
  onCancel: () => void
  // Opens GenerationFullscreenViewer at this url — see App.tsx's
  // viewerUrl/completedResults.
  onOpenViewer: (url: string) => void
  // Every file across the whole session's history, most recent first
  // (App.tsx's completedResults, mapped down to plain urls) — shown as a
  // small thumbnail strip regardless of status, so browsing past results
  // never depends on which state the current job happens to be in.
  historyUrls: string[]
}

function wsStatusLabel(status: ComfyConnectionStatus): string | null {
  if (status === 'reconnecting') return 'Bağlantı: yeniden bağlanılıyor…'
  if (status === 'connecting') return 'Bağlantı: bağlanılıyor…'
  return null // 'open' — nothing worth mentioning
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
  previewUrl,
  elapsedSeconds,
  totalElapsedSeconds,
  eta,
  error,
  result,
  connectionLost,
  recovering,
  wsStatus,
  onCancel,
  onOpenViewer,
  historyUrls,
}: Props) {
  const resultRef = useRef<HTMLDivElement>(null)

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
        <button type="button" className="secondary-button" onClick={() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          Sonucu Görüntüle
        </button>
        <div ref={resultRef}>
          <ResultCarousel key={result.promptId} urls={historyUrls} kind="video" onOpen={onOpenViewer} />
        </div>
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
  const wsLabel = wsStatusLabel(wsStatus)

  return (
    <div className="status-panel">
      <div className="status-panel-header-row">
        <div className="status-title">{status === 'queued' ? 'Sırada bekleniyor…' : 'Oluşturuluyor…'}</div>
        <ResultCarousel urls={historyUrls} kind="video" onOpen={onOpenViewer} compact />
      </div>

      {connectionLost && (
        <div className="status-warning">⚠ ComfyUI'ye ulaşılamıyor — sunucu kapalı veya çökmüş olabilir. Yeniden denenmeye devam ediliyor…</div>
      )}

      {/* No fine-grained progress survives a page reload (screen lock, OEM
          background kill, refresh) — a recovered job only knows *that* it's
          running, not which node or sampling step it's on. Showing a fake 0%
          bar here would look like a stalled/broken generation, so this shows
          a neutral message instead until a live WS update (or completion)
          arrives. */}
      {recovering ? (
        <div className="status-stage">Üretim arka planda devam ediyor — ilerleme bilgisi yeniden bağlanınca gelecek…</div>
      ) : (
        <>
          <div className="status-stage">
            {isSampling ? (
              <>
                Sampling {samplingProgress.value} / {samplingProgress.max}
              </>
            ) : (
              currentNodeTitle && <>İşleniyor: {currentNodeTitle}</>
            )}
          </div>

          {/* progress omitted here — the "Sampling X / Y" line just above
              already says this; GenerationPreview's own step line is only
              needed on the image tabs, which don't otherwise show one. */}
          <GenerationPreview previewUrl={previewUrl} progress={null} />

          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="status-row status-row-right">{pct}%</div>
        </>
      )}

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
      {wsLabel && <div className="field-hint">{wsLabel}</div>}

      <button type="button" className="generate-button generate-button-cancel" onClick={onCancel}>
        İptal Et
      </button>
    </div>
  )
}
