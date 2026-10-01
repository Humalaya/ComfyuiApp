import { canShare, shareText } from '../utils/shareText'
import { useBackHandler } from '../native/backButton'

interface Props {
  title: string | null
  text: string | null
  onClose: () => void
  onSendToCreate?: () => void
  sendSettingsLabel?: string
  sendingSettings?: boolean
  onSendImageOnly?: () => void
  sendingImage?: boolean
}

// Shows the extracted PNG metadata directly — no download of the image
// needed. Two independent actions apply to the Create screen:
// "Ayarları Gönder" carries over whatever settings could be recognized from
// the metadata *together with this exact PNG* as the input image (only
// shown when something was actually found), while "Resmi Gönder" sends only
// the image, untouched by any settings — the two are separate on purpose,
// since e.g. a Forge image has a usable picture but no settings this
// workflow can map. A share button hands the raw text to the phone's native
// share sheet when available. The textarea itself is always there as a
// manual fallback (tap, select-all, copy) since navigator.share/clipboard
// can be unavailable on this app's plain-http/LAN origin.
export function MetadataModal({ title, text, onClose, onSendToCreate, sendSettingsLabel, sendingSettings, onSendImageOnly, sendingImage }: Props) {
  useBackHandler(text !== null, onClose)
  if (text === null) return null

  const busy = !!sendingSettings || !!sendingImage

  async function handleShare() {
    await shareText(title ?? 'Metadata', text!)
  }

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="metadata-modal" onClick={(e) => e.stopPropagation()}>
        <div className="metadata-modal-header">
          <span className="metadata-modal-title" title={title ?? undefined}>
            {title ?? 'Metadata'}
          </span>
          <button type="button" className="popup-close-inline" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>

        <textarea className="metadata-textarea" readOnly value={text} onClick={(e) => e.currentTarget.select()} />

        <div className="metadata-modal-actions">
          {canShare() && (
            <button type="button" className="secondary-button" onClick={handleShare} disabled={busy}>
              📤 Paylaş
            </button>
          )}
          {onSendToCreate && (
            <button type="button" className="secondary-button metadata-send-button" onClick={onSendToCreate} disabled={busy}>
              {sendingSettings ? 'Gönderiliyor…' : (sendSettingsLabel ?? '📝 Ayarları Gönder')}
            </button>
          )}
          {onSendImageOnly && (
            <button type="button" className="secondary-button metadata-send-button" onClick={onSendImageOnly} disabled={busy}>
              {sendingImage ? 'Gönderiliyor…' : '🖼️ Sadece Resmi Gönder'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
