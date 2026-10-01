// Model dropdowns list ComfyUI's full relative paths
// ("Images/waiIllustriousSDXL_v170.safetensors") — the extension is just
// noise on a phone-width select; the folder stays since it tells families apart.
export function modelLabel(name: string): string {
  return name.replace(/\.(safetensors|ckpt|pt|pth|gguf|sft|bin)$/i, '')
}
