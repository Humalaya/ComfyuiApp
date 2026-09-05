import { useRef, useState } from 'react'
import { uploadImage, viewUrl } from '../api/comfyClient'
import type { GenerationSettings } from '../workflow/fieldMap'

interface Props {
  value: GenerationSettings['inputImage']
  onChange: (image: GenerationSettings['inputImage']) => void
}

export function ImageUploader({ value, onChange }: Props) {
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
      <label className="field-label">Girdi Görseli</label>
      <div className="image-uploader" onClick={() => inputRef.current?.click()}>
        {previewUrl ? (
          <img src={previewUrl} alt="Girdi görseli" className="image-preview" />
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
    </div>
  )
}
