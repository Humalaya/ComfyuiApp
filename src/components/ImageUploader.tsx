import { useRef, useState } from 'react'
import { uploadImage, viewUrl } from '../api/comfyClient'
import type { GenerationSettings } from '../workflow/fieldMap'

type ImageRef = GenerationSettings['inputImage']

interface Props {
  label: string
  hint: string
  enabled: boolean
  onToggleEnabled: (enabled: boolean) => void
  value: ImageRef
  onChange: (image: ImageRef) => void
}

// Backs both "Picture 1" (first_frame) and "Picture 2" (last_frame) on the
// video tab — see fieldMap.ts's GenerationSettings for why each needs its
// own on/off switch, not just "is an image picked": MiniMaxH3ImageToVideo's
// first_frame/last_frame are optional IMAGE inputs with no "off" value of
// their own, so txt2vid vs img2vid vs first-last-frame interpolation is
// purely about which of these are wired at all — the switch lets you turn
// one off without losing the picked image, in case you want to A/B the same
// prompt with and without it.
export function ImageUploader({ label, hint, enabled, onToggleEnabled, value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setUploading(true)
    setError(null)
    try {
      const res = await uploadImage(file, file.name)
      onChange({ filename: res.name, subfolder: res.subfolder, type: res.type })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const previewUrl = value ? viewUrl(value.filename, value.subfolder, value.type) : null

  return (
    <div className="field">
      <div className="picture-frame-header">
        <span className="field-label">{label}</span>
        <button
          type="button"
          className={enabled ? 'switch switch-on' : 'switch'}
          onClick={() => onToggleEnabled(!enabled)}
          aria-pressed={enabled}
          aria-label={label}
        >
          <span className="switch-knob" />
        </button>
      </div>

      {enabled ? (
        <>
          <div className="image-uploader" onClick={() => inputRef.current?.click()}>
            {previewUrl ? (
              <img src={previewUrl} alt={label} className="image-preview" />
            ) : (
              <div className="image-placeholder">{uploading ? 'Yükleniyor…' : 'Fotoğraf seç / çek'}</div>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
              e.target.value = ''
            }}
          />
          {error && <div className="field-error">{error}</div>}
          {value && (
            <button type="button" className="secondary-button" onClick={() => onChange(null)}>
              ✕ Kaldır
            </button>
          )}
        </>
      ) : (
        <span className="field-hint">{hint}</span>
      )}
    </div>
  )
}
