import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { getGalleryLock, lockGallery, unlockGallery } from '../api/outputsClient'
import { useBackHandler } from '../native/backButton'

interface Props {
  // Galeri is the visible tab — the lock state is re-checked each time it
  // becomes visible (another phone/PC may have locked or unlocked it).
  active: boolean
  children: (requestLock: () => void) => ReactNode
}

// Galeri behind its password lock (server/galleryLock.js): while locked only
// the unlock screen is shown — the gallery itself isn't even mounted, so
// nothing of it stays in memory or on screen.
export function GalleryLockGate({ active, children }: Props) {
  const [locked, setLocked] = useState<boolean | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [lockDialog, setLockDialog] = useState(false)

  const check = useCallback(() => {
    getGalleryLock()
      .then((l) => {
        setLocked(l)
        setCheckError(null)
      })
      .catch((e: Error) => setCheckError(e.message))
  }, [])

  useEffect(() => {
    if (!active) return
    check()
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [active, check])

  if (locked === null) {
    return checkError ? (
      <div className="gallery-lock-screen">
        <div className="field-error">{checkError}</div>
        <button type="button" className="secondary-button" onClick={check}>
          Tekrar dene
        </button>
      </div>
    ) : (
      <div className="gallery-lock-screen">
        <div className="spinner" aria-label="Yükleniyor" />
      </div>
    )
  }

  if (locked) return <UnlockScreen onUnlocked={() => setLocked(false)} />

  return (
    <>
      {children(() => setLockDialog(true))}
      {lockDialog && (
        <LockDialog
          onClose={() => setLockDialog(false)}
          onLocked={() => {
            setLockDialog(false)
            setLocked(true)
          }}
        />
      )}
    </>
  )
}

function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      if (!(await unlockGallery(password))) onUnlocked()
    } catch (err) {
      setError((err as Error).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="gallery-lock-screen" onSubmit={submit}>
      <div className="gallery-lock-icon" aria-hidden="true">
        🔒
      </div>
      <div className="gallery-lock-title">Galeri kilitli</div>
      <div className="field gallery-lock-field">
        <label className="field-label" htmlFor="gallery-unlock-password">
          Şifre
        </label>
        <input
          id="gallery-unlock-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          enterKeyHint="done"
        />
      </div>
      {error && <div className="field-error">{error}</div>}
      <button type="submit" className="generate-button gallery-lock-submit" disabled={!password || busy}>
        {busy ? <span className="spinner spinner-small" /> : '🔓 Kilidi aç'}
      </button>
    </form>
  )
}

const MIN_LENGTH = 4

function LockDialog({ onClose, onLocked }: { onClose: () => void; onLocked: () => void }) {
  useBackHandler(true, onClose)
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = password.length < MIN_LENGTH
  const mismatch = repeat.length > 0 && repeat !== password

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (tooShort || repeat !== password || busy) return
    setBusy(true)
    setError(null)
    try {
      if (await lockGallery(password)) onLocked()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Galeriyi kilitle" className="popup-overlay" onClick={() => !busy && onClose()}>
      <form className="media-action-menu gallery-lock-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="gallery-lock-title">🔒 Galeriyi kilitle</div>
        <span className="field-hint">Açmak için bu şifre sorulacak. Kilit her cihazda geçerli (telefon, PC tarayıcısı).</span>
        <div className="field">
          <label className="field-label" htmlFor="gallery-lock-password">
            Şifre
          </label>
          <input
            id="gallery-lock-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="gallery-lock-repeat">
            Şifre (tekrar)
          </label>
          <input
            id="gallery-lock-repeat"
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            enterKeyHint="done"
          />
        </div>
        {password.length > 0 && tooShort && <div className="field-hint">En az {MIN_LENGTH} karakter.</div>}
        {mismatch && <div className="field-error">Şifreler aynı değil.</div>}
        {error && <div className="field-error">{error}</div>}
        <button type="submit" className="generate-button" disabled={tooShort || repeat !== password || busy}>
          {busy ? <span className="spinner spinner-small" /> : '🔒 Kilitle'}
        </button>
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
          Vazgeç
        </button>
      </form>
    </div>
  )
}
