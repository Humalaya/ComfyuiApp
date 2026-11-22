import { useEffect, useMemo, useState } from 'react'
import {
  clearPromptHistory,
  deleteHistoryEntry,
  deleteSavedPrompt,
  getPromptLibrary,
  savePrompt,
  type PromptHistoryEntry,
  type PromptKind,
  type SavedPrompt,
} from '../api/promptLibraryClient'

export interface PromptLibraryProps {
  kind: PromptKind
  // The box's current text — what "⭐ Şu anki promptu kaydet" saves.
  prompt: string
  // SDXL only: travels with the prompt (saved and restored together).
  negative?: string
  onUse: (picked: { prompt: string; negative?: string }) => void
}

type Tab = 'history' | 'saved'

const TAB_KEY = 'prompt-library-tab'

function when(at: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? `Bugün ${time}`
    : `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${time}`
}

function matches(q: string, ...texts: (string | undefined)[]): boolean {
  const needle = q.trim().toLocaleLowerCase('tr')
  return !needle || texts.some((t) => t?.toLocaleLowerCase('tr').includes(needle))
}

const sameAs = (a: { text: string; negative?: string }, b: { text: string; negative?: string }) =>
  a.text === b.text && (a.negative || '') === (b.negative || '')

// The "📜 Geçmiş" page of the ✨ Prompt pop-up (PromptGenerator.tsx): every
// prompt that was queued (kept on the PC, so the phone and a PC browser share
// it — server/promptLibrary.js) and the ones starred to keep.
export function PromptLibraryPanel({ kind, prompt, negative, onUse }: PromptLibraryProps) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'saved' ? 'saved' : 'history'
    } catch {
      return 'history'
    }
  })
  const [history, setHistory] = useState<PromptHistoryEntry[] | null>(null)
  const [saved, setSaved] = useState<SavedPrompt[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    getPromptLibrary(kind)
      .then((lib) => {
        setHistory(lib.history)
        setSaved(lib.saved)
      })
      .catch((e: Error) => setError(e.message))
  }, [kind])

  function changeTab(t: Tab) {
    setTab(t)
    setConfirmClear(false)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // not remembered — fine
    }
  }

  // Runs one change on the PC, then shows the result (or the error).
  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = (text: string, neg: string | undefined, nm?: string) =>
    act(async () => {
      const item = await savePrompt(kind, text, neg, nm)
      setSaved((list) => [item, ...(list ?? []).filter((s) => s.id !== item.id)])
    })

  const shownHistory = useMemo(() => history?.filter((e) => matches(query, e.text, e.negative)) ?? null, [history, query])
  const shownSaved = useMemo(() => saved?.filter((s) => matches(query, s.name, s.text, s.negative)) ?? null, [saved, query])
  const currentNegative = kind === 'sdxl' ? negative?.trim() || undefined : undefined
  const currentSaved = !!saved?.some((s) => sameAs(s, { text: prompt.trim(), negative: currentNegative }))

  const entryBody = (text: string, neg: string | undefined, title?: string) => (
    <>
      {title && <div className="prompt-lib-name">{title}</div>}
      <div className="prompt-lib-text">{text}</div>
      {neg && (
        <div className="prompt-lib-negative">
          <b>Negatif:</b> {neg}
        </div>
      )}
    </>
  )

  return (
    <div className="prompt-lib">
      <div className="seg">
        <button type="button" className={tab === 'history' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => changeTab('history')}>
          Geçmiş{history ? ` · ${history.length}` : ''}
        </button>
        <button type="button" className={tab === 'saved' ? 'seg-btn seg-btn-active' : 'seg-btn'} onClick={() => changeTab('saved')}>
          ⭐ Kayıtlı{saved ? ` · ${saved.length}` : ''}
        </button>
      </div>

      <div className="search-row">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Promptlarda ara…"
          aria-label="Promptlarda ara"
          enterKeyHint="search"
        />
        {query && (
          <button type="button" className="icon-button" aria-label="Aramayı temizle" onClick={() => setQuery('')}>
            ✕
          </button>
        )}
      </div>

      {error && <div className="field-error">{error}</div>}

      {tab === 'saved' && (
        <div className="prompt-lib-save">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="İsim (isteğe bağlı)"
            aria-label="Kayıt ismi"
            maxLength={80}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !prompt.trim()}
            onClick={() => save(prompt.trim(), currentNegative, name.trim() || undefined).then(() => setName(''))}
          >
            {currentSaved && !name.trim() ? '✓ Kayıtlı' : '⭐ Şu anki promptu kaydet'}
          </button>
        </div>
      )}

      {tab === 'history' ? (
        shownHistory === null ? (
          !error && <div className="spinner" aria-label="Yükleniyor" />
        ) : shownHistory.length === 0 ? (
          <div className="empty-state">
            {query ? 'Eşleşen prompt yok.' : "Henüz geçmiş yok — Üret'e bastığın her prompt buraya kendiliğinden eklenir."}
          </div>
        ) : (
          <ul className="prompt-lib-list">
            {shownHistory.map((e) => {
              const isSaved = !!saved?.some((s) => sameAs(s, e))
              return (
                <li key={`${e.at}-${e.text.slice(0, 40)}`} className="prompt-lib-item">
                  {entryBody(e.text, e.negative)}
                  <div className="prompt-lib-meta">
                    {when(e.at)}
                    {e.count > 1 && ` · ${e.count} kez`}
                  </div>
                  <div className="prompt-lib-actions">
                    <button
                      type="button"
                      className="generate-button prompt-lib-use"
                      onClick={() => onUse({ prompt: e.text, negative: e.negative })}
                    >
                      Kullan
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy || isSaved}
                      onClick={() => save(e.text, e.negative)}
                      aria-label={isSaved ? 'Kayıtlı' : 'Kaydet'}
                      title={isSaved ? 'Kayıtlı' : 'Kaydet'}
                    >
                      {isSaved ? '✓' : '⭐'}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy}
                      aria-label="Geçmişten sil"
                      title="Geçmişten sil"
                      onClick={() =>
                        act(async () => {
                          await deleteHistoryEntry(kind, e.text, e.negative)
                          setHistory((list) => list?.filter((x) => !sameAs(x, e)) ?? null)
                        })
                      }
                    >
                      🗑
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )
      ) : shownSaved === null ? (
        !error && <div className="spinner" aria-label="Yükleniyor" />
      ) : shownSaved.length === 0 ? (
        <div className="empty-state">
          {query ? 'Eşleşen prompt yok.' : "Kayıtlı prompt yok — yukarıdan şu ankini, ya da Geçmiş'ten ⭐ ile birini kaydet."}
        </div>
      ) : (
        <ul className="prompt-lib-list">
          {shownSaved.map((s) => (
            <li key={s.id} className="prompt-lib-item">
              {entryBody(s.text, s.negative, s.name)}
              <div className="prompt-lib-meta">{when(s.at)}</div>
              <div className="prompt-lib-actions">
                <button
                  type="button"
                  className="generate-button prompt-lib-use"
                  onClick={() => onUse({ prompt: s.text, negative: s.negative })}
                >
                  Kullan
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  aria-label="Kaydı sil"
                  title="Kaydı sil"
                  onClick={() =>
                    act(async () => {
                      await deleteSavedPrompt(s.id)
                      setSaved((list) => list?.filter((x) => x.id !== s.id) ?? null)
                    })
                  }
                >
                  🗑
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'history' && !!history?.length && !query && (
        <button
          type="button"
          className={confirmClear ? 'secondary-button prompt-lib-clear prompt-lib-clear-confirm' : 'prompt-gen-link prompt-lib-clear'}
          disabled={busy}
          onClick={() =>
            confirmClear
              ? act(async () => {
                  await clearPromptHistory(kind)
                  setHistory([])
                  setConfirmClear(false)
                })
              : setConfirmClear(true)
          }
        >
          {confirmClear ? `Emin misin? ${history.length} prompt silinecek (kayıtlılar kalır)` : 'Geçmişi temizle'}
        </button>
      )}
    </div>
  )
}
