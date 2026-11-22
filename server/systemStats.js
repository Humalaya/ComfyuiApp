// Ayarlar → "💻 PC durumu": live CPU / RAM / swap / GPU numbers for the
// phone, read from /proc, /sys/class/hwmon and nvidia-smi. Polled every
// couple of seconds while that screen is open; each read is cheap (nvidia-smi
// ~50 ms), and readings are reused for a second so several open clients
// don't multiply the work.
import fs from 'node:fs/promises'
import os from 'node:os'
import { execFile } from 'node:child_process'

const CACHE_MS = 1000

// CPU busy % comes from the difference between two /proc/stat readings —
// the previous request's reading (or one taken 250 ms earlier on the very
// first call).
let lastCpu = null

async function readCpuTimes() {
  const line = (await fs.readFile('/proc/stat', 'utf8')).split('\n', 1)[0]
  const v = line.trim().split(/\s+/).slice(1).map(Number)
  const idle = v[3] + (v[4] || 0) // idle + iowait
  const total = v.reduce((a, b) => a + b, 0)
  return { idle, total }
}

async function cpuPercent() {
  if (!lastCpu) {
    lastCpu = await readCpuTimes()
    await new Promise((r) => setTimeout(r, 250))
  }
  const now = await readCpuTimes()
  const dTotal = now.total - lastCpu.total
  const dIdle = now.idle - lastCpu.idle
  lastCpu = now
  return dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0
}

async function memInfo() {
  const kv = {}
  for (const line of (await fs.readFile('/proc/meminfo', 'utf8')).split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) kv[m[1]] = Number(m[2]) * 1024
  }
  return {
    ram: { total: kv.MemTotal, used: kv.MemTotal - kv.MemAvailable },
    swap: { total: kv.SwapTotal, used: kv.SwapTotal - kv.SwapFree },
  }
}

// CPU package temperature: k10temp (AMD, Tctl) or coretemp (Intel).
async function cpuTemp() {
  try {
    for (const dir of await fs.readdir('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${dir}`
      const name = (await fs.readFile(`${base}/name`, 'utf8').catch(() => '')).trim()
      if (name !== 'k10temp' && name !== 'coretemp') continue
      const v = Number(await fs.readFile(`${base}/temp1_input`, 'utf8'))
      if (Number.isFinite(v)) return v / 1000
    }
  } catch {
    // no sensor
  }
  return null
}

function gpuInfo() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const f = stdout
          .split('\n')[0]
          .split(',')
          .map((x) => x.trim())
        const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
        resolve({
          name: f[0],
          util: n(f[1]),
          vram: { used: n(f[2]) * 1024 * 1024, total: n(f[3]) * 1024 * 1024 },
          temp: n(f[4]),
          power: n(f[5]),
          powerLimit: n(f[6]),
          fan: n(f[7]),
        })
      },
    )
  })
}

let cached = null

async function readStats() {
  const [cpu, mem, temp, gpu] = await Promise.all([cpuPercent(), memInfo(), cpuTemp(), gpuInfo()])
  return {
    at: Date.now(),
    cpu: { percent: cpu, temp, cores: os.cpus().length, model: os.cpus()[0]?.model?.trim() ?? '', load: os.loadavg() },
    ...mem,
    gpu,
    uptime: os.uptime(),
  }
}

export function registerSystemStatsRoutes(app) {
  app.get('/api/system/stats', async (_req, res) => {
    try {
      if (!cached || Date.now() - cached.at > CACHE_MS) cached = await readStats()
      res.set('Cache-Control', 'no-store')
      res.json(cached)
    } catch (err) {
      console.error('[output-server] system stats:', err)
      res.status(500).json({ error: 'PC durumu okunamadı.' })
    }
  })
}
