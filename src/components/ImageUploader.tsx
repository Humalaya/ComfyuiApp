import { useRef, useState } from 'react'
import { uploadImage, viewUrl } from '../api/comfyClient'
import type { GenerationSettings } from '../workflow/fieldMap'
import { HelpTip } from './HelpTip'
import { readClipboardImage } from '../native/clipboardImage'

type ImageRef = GenerationSettings['inputImage']

interface Props {
  label: string
  help: string
  // Omit both for a required picture (Anime2Real's input): no switch, always on.
  enabled?: boolean
  onToggleEnabled?: (enabled: boolean) => void
  value: ImageRef
  onChange: (image: ImageRef) => void
  // Full-width use (Anime2Real): a short box showing the whole picture,
  // instead of the tall cropped one meant for two side by side.
  wide?: boolean
}

// Backs both "Picture 1" (first_frame) and "Picture 2" (last_frame) on the
// video tab — see fieldMap.ts's GenerationSettings for why each needs its
// own on/off switch, not just "is an image picked": MiniMaxH3ImageToVideo's
// first_frame/last_frame are optional IMAGE inputs with no "off" value of
// their own, so txt2vid vs img2vid vs first-last-frame interpolation is
// purely about which of these are wired at all — the switch lets you turn
// one off without losing the picked image, in case you want to A/B the same
// prompt with and without it.
export function ImageUploader({ label, help, enabled = true, onToggleEnabled, value, onChange, wide = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File | Blob, name = (file as File).name) {
    setUploading(true)
    setError(null)
    try {
      const res = await uploadImage(file, name)
      onChange({ filename: res.name, subfolder: res.subfolder, type: res.type })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function pasteFromClipboard() {
    setError(null)
    try {
      const blob = await readClipboardImage()
      await handlePasted(blob)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function handlePasted(blob: Blob) {
    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    return handleFile(blob, `pasted_${Date.now()}.${ext}`)
  }

  const previewUrl = value ? viewUrl(value.filename, value.subfolder, value.type) : null

  return (
    <div className="field">
      <div className="picture-frame-header">
        <span className="field-label">
          {label}
          <HelpTip>{help}</HelpTip>
        </span>
        {onToggleEnabled && (
          <button
            type="button"
            className={enabled ? 'switch switch-on' : 'switch'}
            onClick={() => onToggleEnabled(!enabled)}
            aria-pressed={enabled}
            aria-label={label}
          >
            <span className="switch-knob" />
          </button>
        )}
      </div>

      {enabled && (
        <>
          <div
            className={wide ? 'image-uploader image-uploader-wide' : 'image-uploader'}
            onClick={() => inputRef.current?.click()}
            // Ctrl+V on a computer, once the box has focus.
            tabIndex={0}
            onPaste={(e) => {
              const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
              if (file) {
                e.preventDefault()
                handlePasted(file)
              }
            }}
          >
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
          <div className="image-uploader-actions">
            <button type="button" className="secondary-button" onClick={pasteFromClipboard} disabled={uploading}>
              📋 Yapıştır
            </button>
            {value && (
              <button type="button" className="secondary-button" onClick={() => onChange(null)}>
                ✕ Kaldır
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
