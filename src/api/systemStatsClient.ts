// Ayarlar → 💻 PC durumu — server/systemStats.js.

export interface SystemStats {
  at: number
  cpu: { percent: number; temp: number | null; cores: number; model: string; load: number[] }
  ram: { total: number; used: number }
  swap: { total: number; used: number }
  gpu: {
    name: string
    util: number | null
    vram: { used: number; total: number }
    temp: number | null
    power: number | null
    powerLimit: number | null
    fan: number | null
  } | null
  uptime: number
}

export async function fetchSystemStats(): Promise<SystemStats> {
  const res = await fetch('/api/system/stats', { cache: 'no-store' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `İstek başarısız (${res.status})`)
  }
  return res.json()
}
