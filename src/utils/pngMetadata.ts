// Reads tEXt/zTXt chunks straight out of a PNG's bytes in the browser — no
// upload to any server needed. ComfyUI writes its "prompt" (API workflow) and
// "workflow" (UI graph) as uncompressed tEXt chunks by default, which is all
// this needs to handle; zTXt (zlib-compressed) is supported too in case a
// PNG was re-saved by a tool that compresses its text chunks.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export async function readPngTextChunks(file: Blob): Promise<Record<string, string>> {
  const buf = new Uint8Array(await file.arrayBuffer())

  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new Error('Seçilen dosya geçerli bir PNG değil.')
    }
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const decoder = new TextDecoder('latin1') // PNG text chunks are Latin-1 by spec
  const chunks: Record<string, string> = {}

  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset)
    const type = decoder.decode(buf.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > buf.length) break

    if (type === 'tEXt') {
      const chunk = buf.subarray(dataStart, dataEnd)
      const nul = chunk.indexOf(0)
      if (nul !== -1) {
        chunks[decoder.decode(chunk.subarray(0, nul))] = decoder.decode(chunk.subarray(nul + 1))
      }
    } else if (type === 'zTXt') {
      const chunk = buf.subarray(dataStart, dataEnd)
      const nul = chunk.indexOf(0)
      if (nul !== -1) {
        const key = decoder.decode(chunk.subarray(0, nul))
        const compressed = chunk.subarray(nul + 2) // skip null + compression-method byte
        try {
          chunks[key] = await inflateZlib(compressed)
        } catch {
          // Compression Streams API unavailable or data malformed — skip this chunk.
        }
      }
    } else if (type === 'IEND') {
      break
    }

    offset = dataEnd + 4 // skip CRC
  }

  return chunks
}

// Picks the human-shareable metadata text out of a PNG's chunks, regardless
// of which tool wrote it: A1111/Forge stores a single "parameters" block
// (prompt, negative prompt, sampler/seed/etc as a plain-text summary — this
// is already exactly what people paste around to reproduce an image), while
// ComfyUI stores the full API workflow as JSON under "prompt". Returns null
// if neither is present so the caller can show a clear "not found" message
// instead of sharing an empty string.
export function extractShareableMetadataText(chunks: Record<string, string>): string | null {
  if (chunks.parameters) return chunks.parameters
  if (chunks.prompt) return chunks.prompt
  return null
}

// A1111/Forge's "parameters" block has no structured fields to map onto this
// app's (unrelated) MiniMax H3 node graph — but the positive prompt itself is
// still worth carrying over. It's whatever comes before "Negative prompt:"
// (or before the trailing "Steps: ..." settings line, if there's no negative
// prompt section), which is the standard A1111 layout.
export function extractA1111PositivePrompt(parameters: string): string {
  const negIdx = parameters.indexOf('\nNegative prompt:')
  if (negIdx !== -1) return parameters.slice(0, negIdx).trim()
  const stepsMatch = parameters.match(/\nSteps:\s/)
  if (stepsMatch?.index !== undefined) return parameters.slice(0, stepsMatch.index).trim()
  return parameters.trim()
}

async function inflateZlib(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unsupported')
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buf = await new Response(stream).arrayBuffer()
  return new TextDecoder('latin1').decode(buf)
}
