import { useRef, useState } from 'react'
import { extractPromptFromPng, extractSettingsFromPrompt } from '../workflow/pngImport'
import type { GenerationSettings } from '../workflow/fieldMap'

interface Props {
  onImport: (settings: Partial<GenerationSettings>) => void
}

interface ImportSummary {
  foundFields: string[]
  missingFields: string[]
}

export function ImportPngButton({ onImport }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    setSummary(null)
    try {
      const prompt = await extractPromptFromPng(file)
      const { settings, foundFields, missingFields } = extractSettingsFromPrompt(prompt)
      if (foundFields.length === 0) {
        throw new Error('Bu PNG bu workflow ile üretilmemiş gibi görünüyor — tanınan hiçbir ayar bulunamadı.')
      }
      onImport(settings)
      setSummary({ foundFields, missingFields })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <button type="button" className="secondary-button import-png-button" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? 'PNG okunuyor…' : '📥 PNG\'den Ayarları İçe Aktar'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />
      {error && <div className="field-error">{error}</div>}
      {summary && (
        <div className="import-summary">
          <div className="import-summary-ok">✓ Dolduruldu: {summary.foundFields.join(', ')}</div>
          {summary.missingFields.length > 0 && (
            <div className="import-summary-missing">✗ Bulunamadı: {summary.missingFields.join(', ')}</div>
          )}
        </div>
      )}
    </div>
  )
}
