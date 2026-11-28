import { modelLabel } from '../utils/modelLabel'

// A ComfyUI model list's entry, or the saved one shown as missing.
export function ModelSelect({
  id,
  value,
  names,
  loading,
  onChange,
  note,
}: {
  id: string
  value: string
  names: string[]
  loading: boolean
  onChange: (v: string) => void
  // Extra text after an entry's name, e.g. "✗ Krea2 ile uyumsuz".
  note?: (name: string) => string
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}>
      {!names.includes(value) && <option value={value}>{value ? `${modelLabel(value)} (yok)` : '(yok)'}</option>}
      {names.map((name) => (
        <option key={name} value={name}>
          {modelLabel(name)}
          {note?.(name) ? ` · ${note(name)}` : ''}
        </option>
      ))}
    </select>
  )
}
