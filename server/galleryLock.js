// Galeri kilidi: "Kilitle" sets a password and from then on every
// /api/outputs route except /sources answers 423 until "Kilidi aç" is called
// with the same password, which removes the lock again. Enforced here,
// server-side, so it isn't just hidden in one app: a browser on another PC
// or a direct URL gets nothing either.
//
// Only a scrypt hash is stored (server/cache/gallery-lock.json). Forgotten
// password: delete that file on the PC, then restart the service.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'gallery-lock.json')
const MIN_LENGTH = 4
const MAX_LENGTH = 200
// Wrong passwords: after MAX_FAILS in a row, unlocking pauses for
// PAUSE_MS so the password can't be guessed by a quick loop on the LAN.
const MAX_FAILS = 5
const PAUSE_MS = 60_000

let lock = null // { salt, hash } while locked
let fails = 0
let pausedUntil = 0

try {
  const saved = JSON.parse(await fs.readFile(LOCK_PATH, 'utf8'))
  if (typeof saved?.salt === 'string' && typeof saved?.hash === 'string') lock = saved
} catch {
  // no lock file: unlocked
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

function readPassword(req) {
  const pw = req.body?.password
  return typeof pw === 'string' ? pw : ''
}

export function registerGalleryLockRoutes(app) {
  // Before the /api/outputs routes, so they're all covered.
  app.use('/api/outputs', (req, res, next) => {
    if (!lock || req.path === '/sources') return next()
    res.status(423).json({ error: 'Galeri kilitli.', locked: true })
  })

  app.get('/api/gallery-lock', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ locked: !!lock })
  })

  app.post('/api/gallery-lock/lock', async (req, res) => {
    if (lock) return res.json({ locked: true })
    const password = readPassword(req)
    if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
      return res.status(400).json({ error: `Şifre en az ${MIN_LENGTH} karakter olmalı.` })
    }
    try {
      const salt = crypto.randomBytes(16).toString('hex')
      const next = { salt, hash: (await hashPassword(password, salt)).toString('hex') }
      await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true })
      await fs.writeFile(LOCK_PATH, JSON.stringify(next), { mode: 0o600 })
      lock = next
      fails = 0
      console.log('[output-server] gallery locked')
      res.json({ locked: true })
    } catch (err) {
      console.error('[output-server] gallery lock failed:', err)
      res.status(500).json({ error: 'Kilit kaydedilemedi.' })
    }
  })

  app.post('/api/gallery-lock/unlock', async (req, res) => {
    if (!lock) return res.json({ locked: false })
    const wait = pausedUntil - Date.now()
    if (wait > 0) {
      return res.status(429).json({ error: `Çok fazla yanlış deneme. ${Math.ceil(wait / 1000)} sn sonra tekrar dene.` })
    }
    try {
      const given = await hashPassword(readPassword(req), lock.salt)
      const expected = Buffer.from(lock.hash, 'hex')
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        fails += 1
        if (fails >= MAX_FAILS) {
          fails = 0
          pausedUntil = Date.now() + PAUSE_MS
          return res.status(429).json({ error: `Çok fazla yanlış deneme. ${PAUSE_MS / 1000} sn sonra tekrar dene.` })
        }
        return res.status(403).json({ error: 'Şifre yanlış.' })
      }
      await fs.rm(LOCK_PATH, { force: true })
      lock = null
      fails = 0
      console.log('[output-server] gallery unlocked')
      res.json({ locked: false })
    } catch (err) {
      console.error('[output-server] gallery unlock failed:', err)
      res.status(500).json({ error: 'Kilit açılamadı.' })
    }
  })
}
