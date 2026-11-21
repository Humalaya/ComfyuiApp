import { useEffect, useState } from 'react'
import { fetchStorage, formatBytes, type StorageInfo } from '../api/modelsClient'

interface Props {
  // Bump to re-read (after a download / move / delete). Also re-read
  // whenever `active` turns true (a tab coming into view).
  refreshKey?: unknown
  active?: boolean
}

// The PC's free disk space, with what Modeller / Galeri / İndirilenler take
// of it. Models and outputs share one disk here (the system disk), so it's
// one bar; were they ever on separate disks, each gets its own.
export function DiskUsage({ refreshKey, active = true }: Props) {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    fetchStorage()
      .then((s) => !cancelled && (setInfo(s), setError(false)))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [refreshKey, active])

  if (error && !info) return null
  if (!info) return <div className="disk-usage disk-usage-loading" />

  return (
    <>
      {info.disks.map((d, i) => {
        const used = d.total - d.free
        const low = d.free < info.reserve * 2
        return (
          <div key={i} className="disk-usage">
            <div className="disk-usage-head">
              <span className="disk-usage-title">Disk</span>
              <span className={low ? 'disk-usage-free disk-usage-free-low' : 'disk-usage-free'}>{formatBytes(d.free)} boş</span>
              <span className="disk-usage-total">/ {formatBytes(d.total)}</span>
            </div>
            <div className="disk-usage-bar" role="img" aria-label={`${formatBytes(d.free)} boş`}>
              {d.folders.map((f) => (
                <span key={f.key} className={`disk-usage-seg disk-usage-seg-${f.key}`} style={{ width: `${(f.bytes / d.total) * 100}%` }} />
              ))}
              <span
                className="disk-usage-seg disk-usage-seg-other"
                style={{ width: `${(Math.max(0, used - d.folders.reduce((n, f) => n + f.bytes, 0)) / d.total) * 100}%` }}
              />
            </div>
            <div className="disk-usage-legend">
              {d.folders.map((f) => (
                <span key={f.key} className="disk-usage-legend-item">
                  <span className={`disk-usage-dot disk-usage-seg-${f.key}`} />
                  {f.label} {formatBytes(f.bytes)}
                </span>
              ))}
              <span className="disk-usage-legend-item">
                <span className="disk-usage-dot disk-usage-seg-other" />
                Diğer
              </span>
            </div>
          </div>
        )
      })}
    </>
  )
}
