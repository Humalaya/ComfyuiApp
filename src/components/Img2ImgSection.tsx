import { useState } from 'react'
import { IMG2IMG_DEFAULT_DENOISE, sizeForImage, type InputImageRef } from '../workflow/img2img'
import { HelpTip } from './HelpTip'
import { ImageUploader } from './ImageUploader'
import { NumberField } from './NumberField'

interface Props {
  idPrefix: string
  enabled: boolean
  image: InputImageRef | null
  denoise: number
  width: number
  height: number
  // One patch per change, so turning it on/off can move denoise along.
  onChange: (patch: { img2img?: boolean; inputImage?: InputImageRef | null; denoise?: number; width?: number; height?: number }) => void
}

// The SDXL / Krea2 tabs' "start from a picture" block (img2img.ts). Switched
// on, the sampler starts from the picture; "Değişim" (the sampler's denoise)
// says how much of it is redrawn. Switching it off puts denoise back to 1 —
// below 1 without a picture only leaves noise in the image.
export function Img2ImgSection({ idPrefix, enabled, image, denoise, width, height, onChange }: Props) {
  const [sizing, setSizing] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)

  return (
    <div className="img2img-section">
      <ImageUploader
        wide
        label="Görselden üret (img2img)"
        help={`Açıkken üretim boş tuval yerine bu görselden başlar. Görsel ${width}×${height} boyutuna ortadan kırpılarak ölçeklenir — kırpılmasın istersen "Boyutu görselden al". Değişim oranı ne kadarının yeniden çizileceğini belirler.`}
        enabled={enabled}
        onToggleEnabled={(on) =>
          onChange(on ? { img2img: true, ...(denoise >= 1 ? { denoise: IMG2IMG_DEFAULT_DENOISE } : {}) } : { img2img: false, denoise: 1 })
        }
        value={image}
        onChange={(img) => onChange({ inputImage: img })}
      />
      {enabled && (
        <div className="field-row img2img-controls">
          <div className="field">
            <label className="field-label" htmlFor={`${idPrefix}-img2img-denoise`}>
              Değişim oranı
              <HelpTip>
                0.3 civarı görsele çok yakın kalır (renk, ışık, küçük düzeltmeler), 0.5–0.6 kompozisyonu koruyup ayrıntıları yeniden çizer,
                0.8+ neredeyse yeni bir görsel olur. 1 = görseli tamamen yok sayar.
              </HelpTip>
            </label>
            <NumberField
              id={`${idPrefix}-img2img-denoise`}
              min={0.05}
              max={1}
              step={0.05}
              value={denoise}
              onChange={(v) => onChange({ denoise: Math.min(1, Math.max(0, v)) })}
            />
          </div>
          <div className="field img2img-size">
            <button
              type="button"
              className="secondary-button"
              disabled={!image || sizing}
              onClick={async () => {
                if (!image) return
                setSizing(true)
                setSizeError(null)
                try {
                  onChange(await sizeForImage(image, { width, height }))
                } catch (e) {
                  setSizeError((e as Error).message)
                } finally {
                  setSizing(false)
                }
              }}
            >
              {sizing ? '…' : '📐 Boyutu görselden al'}
            </button>
            {sizeError && <div className="field-error">{sizeError}</div>}
          </div>
        </div>
      )}
      {enabled && !image && <div className="field-hint">Görsel seçilmezse normal (boş tuvalden) üretilir.</div>}
    </div>
  )
}
