import { useEffect, useRef, useState } from 'react'
import { cancelPromptGen, getPromptGen, startPromptGen, type PromptGenJob } from '../api/promptGenClient'
import { useBackHandler } from '../native/backButton'
import { DEFAULT_PROMPT_GEN_SYSTEM, PROMPT_GEN_LABEL, type PromptGenTarget } from '../workflow/promptGenPresets'

interface Props {
  target: PromptGenTarget
  // Facts the LLM should respect, e.g. the video's length / first frame.
  context?: string
  onUse: (prompt: string) => void
  // Applied to every suggestion before it's shown (video: the official
  // keyframe alignment line, see videoPromptModes.ts).
  postProcess?: (prompt: string) => string
}

const STAGE_TEXT: Record<NonNullable<PromptGenJob['stage']>, string> = {
  waiting: 'Süren üretimin bitmesi bekleniyor…',
  freeing: 'ComfyUI modeli boşaltılıyor…',
  loading: 'Dil modeli yükleniyor…',
  generating: 'Prompt yazılıyor…',
  unloading: 'Dil modeli kapatılıyor…',
}

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // not remembered — fine
  }
}

type View = 'ask' | 'result' | 'revise'

// The ✨ button next to a Prompt box: describe what you want (any
// language), the PC's local LLM writes the prompt in this tab's style
// (see promptGenPresets.ts), you see it first — "Kullan" puts it in the box,
// "Tekrar" asks what to change and revises it. Runs on the PC as a job
// (server/promptgen.js), so the phone locking doesn't lose it; the pop-up
// stays mounted once opened, so closing it doesn't either.
export function PromptGenerator({ target, context, onUse, postProcess }: Props) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  useBackHandler(open, () => setOpen(false))

  return (
    <>
      <button
        type="button"
        className="prompt-gen-button"
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
        aria-label="Prompt üret"
        title="Prompt üret (yapay zekâ)"
      >
        ✨ Üret
      </button>
      {mounted && (
        <div className="popup-overlay prompt-gen-overlay" hidden={!open} onClick={() => setOpen(false)}>
          <div className="prompt-gen" role="dialog" aria-label="Prompt üretici" onClick={(e) => e.stopPropagation()}>
            <PromptGenBody
              target={target}
              context={context}
              postProcess={postProcess}
              onClose={() => setOpen(false)}
              onUse={(text) => {
                onUse(text)
                setOpen(false)
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}

function PromptGenBody({ target, context, onUse, postProcess, onClose }: Props & { onClose: () => void }) {
  // v2: v1 could store an outdated default as if it were the user's own
  // edit (a live code update kept the old text in state, and an effect saved
  // it). Only an actual edit is stored now, and old v1 values are ignored.
  const systemKey = `promptgen:system:v2:${target}`
  const draftKey = `promptgen:draft:${target}`
  // The running job's id and the last suggestion survive a page reload
  // (screen lock + OEM kill, offline-probe reload): reopening picks up.
  const jobKey = `promptgen:job:${target}`
  const resultKey = `promptgen:result:${target}`
  const [request, setRequest] = useState(() => load(draftKey, ''))
  // null = not customized: always the current default (so an updated
  // default shows up without a reload).
  const [customSystem, setCustomSystem] = useState<string | null>(() => load(systemKey, '') || null)
  const system = customSystem ?? DEFAULT_PROMPT_GEN_SYSTEM[target]
  const [showSystem, setShowSystem] = useState(false)
  const [result, setResult] = useState(() => load(resultKey, ''))
  const [view, setView] = useState<View>(() => (load(resultKey, '') ? 'result' : 'ask'))
  const [feedback, setFeedback] = useState('')
  const [job, setJob] = useState<PromptGenJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)

  useEffect(() => save(draftKey, request || null), [draftKey, request])
  function editSystem(text: string) {
    const custom = text === DEFAULT_PROMPT_GEN_SYSTEM[target] ? null : text
    setCustomSystem(custom)
    save(systemKey, custom)
  }
  useEffect(() => save(resultKey, result || null), [resultKey, result])
  useEffect(() => {
    const saved = load(jobKey, '')
    if (saved) poll(saved)
    return () => {
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const running = job?.status === 'running'

  function poll(id: string) {
    pollTimer.current = window.setTimeout(async () => {
      try {
        const j = await getPromptGen(id)
        setJob(j)
        if (j.status === 'running') return poll(id)
        save(jobKey, null)
        if (j.status === 'done' && j.result) {
          setResult(postProcess ? postProcess(j.result) : j.result)
          setFeedback('')
          setView('result')
        } else setError(j.error || 'Üretilemedi.')
      } catch (e) {
        // Gone (panel restarted, or a newer job replaced it).
        save(jobKey, null)
        setJob(null)
        setError((e as Error).message)
      }
    }, 800)
  }

  async function generate(revision: boolean) {
    setError(null)
    try {
      const j = await startPromptGen({
        target,
        system,
        request,
        context,
        ...(revision ? { previous: result, feedback } : {}),
      })
      setJob(j)
      save(jobKey, j.id)
      poll(j.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const customized = system !== DEFAULT_PROMPT_GEN_SYSTEM[target]

  return (
    <>
      <div className="lora-picker-header">
        <span className="prompt-gen-title">✨ Prompt üret</span>
        <span className="prompt-gen-target">{PROMPT_GEN_LABEL[target]}</span>
        <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
      </div>

      {running ? (
        <div className="prompt-gen-running">
          <div className="spinner" aria-label="Çalışıyor" />
          <div className="prompt-gen-stage">{job?.stage ? STAGE_TEXT[job.stage] : 'Başlıyor…'}</div>
          <div className="field-hint">PC'de çalışıyor — kapatsan da devam eder. Kuyruktaki görsel/video işleri bitene kadar bekler.</div>
          {/* Only while it's still waiting / freeing: once the LLM is loading
              or writing, it finishes (a few seconds) and unloads itself. */}
          {(job?.stage === 'waiting' || job?.stage === 'freeing') && (
            <button type="button" className="secondary-button" onClick={() => job && cancelPromptGen(job.id)}>
              İptal
            </button>
          )}
        </div>
      ) : view === 'ask' ? (
        <>
          <label className="prompt-gen-label" htmlFor={`pg-${target}`}>
            Ne istiyorsun?
          </label>
          <textarea
            id={`pg-${target}`}
            className="prompt-textarea"
            rows={5}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="e.g. a red-haired girl reading a book in a cafe on a rainy night"
          />
          <button type="button" className="generate-button" disabled={!request.trim()} onClick={() => generate(false)}>
            ✨ Üret
          </button>
          {result && (
            <button type="button" className="prompt-gen-link" onClick={() => setView('result')}>
              ‹ Son öneriye dön
            </button>
          )}
        </>
      ) : view === 'result' ? (
        <>
          <span className="prompt-gen-label">Öneri</span>
          <textarea
            className="prompt-textarea prompt-gen-result"
            rows={target === 'video' ? 12 : 6}
            value={result}
            onChange={(e) => setResult(e.target.value)}
          />
          <div className="prompt-gen-actions">
            <button type="button" className="generate-button" onClick={() => onUse(result)}>
              Kullan
            </button>
            <button type="button" className="secondary-button" onClick={() => setView('revise')}>
              Tekrar
            </button>
          </div>
          <button type="button" className="prompt-gen-link" onClick={() => setView('ask')}>
            Yeni istek yaz
          </button>
        </>
      ) : (
        <>
          <span className="prompt-gen-label">Öneri</span>
          <div className="prompt-gen-prev">{result}</div>
          <label className="prompt-gen-label" htmlFor={`pg-fb-${target}`}>
            Ne değişsin?
          </label>
          <textarea
            id={`pg-fb-${target}`}
            className="prompt-textarea"
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. add glasses, put a cat next to her, make it daytime"
            autoFocus
          />
          <div className="prompt-gen-actions">
            <button type="button" className="generate-button" disabled={!feedback.trim()} onClick={() => generate(true)}>
              Değiştir
            </button>
            <button type="button" className="secondary-button" onClick={() => setView('result')}>
              Vazgeç
            </button>
          </div>
        </>
      )}

      {error && <div className="field-error">{error}</div>}

      {!running && (
        <div className="prompt-gen-system">
          <button type="button" className="prompt-gen-link" onClick={() => setShowSystem((s) => !s)}>
            {showSystem ? '▾' : '▸'} Talimat{customized ? ' (değiştirildi)' : ''}
          </button>
          {showSystem && (
            <>
              <textarea
                className="prompt-textarea prompt-gen-system-text"
                rows={10}
                value={system}
                onChange={(e) => editSystem(e.target.value)}
              />
              {customized && (
                <button type="button" className="prompt-gen-link" onClick={() => editSystem(DEFAULT_PROMPT_GEN_SYSTEM[target])}>
                  Varsayılana dön
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}
