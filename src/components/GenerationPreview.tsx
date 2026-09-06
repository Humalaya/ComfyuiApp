interface Props {
  previewUrl: string | null
  progress: { value: number; max: number } | null
}

// A live, low-res snapshot of the current (still noisy) sampling step —
// Forge shows the same thing during its own generations. previewUrl comes
// from ComfyUI's binary WS preview frames (see comfyClient.ts's
// connectComfySocket); nothing renders until the first one actually arrives,
// since ComfyUI only sends these once --preview-method is enabled server-
// side and a sampler node is genuinely mid-step.
export function GenerationPreview({ previewUrl, progress }: Props) {
  if (!previewUrl) return null

  return (
    <div className="gen-preview">
      <img src={previewUrl} alt="" className="gen-preview-img" />
      {progress && (
        <div className="gen-preview-step">
          Adım {progress.value} / {progress.max}
        </div>
      )}
    </div>
  )
}
