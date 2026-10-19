import type { Metadata, default as sharp } from 'sharp'
import { imageDecodingLimits, type DecodedImageVerification } from './imageDecoding'

export { imageDecodingLimits }

const decodedFormatMatchers: Readonly<Record<string, (metadata: Metadata) => boolean>> = Object.freeze({
  'image/avif': metadata => metadata.format === 'heif' && metadata.compression === 'av1',
  'image/gif': metadata => metadata.format === 'gif',
  'image/jpeg': metadata => metadata.format === 'jpeg',
  'image/png': metadata => metadata.format === 'png',
  'image/tiff': metadata => metadata.format === 'tiff',
  'image/webp': metadata => metadata.format === 'webp',
})

function isMissingModule(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || isMissingModule(error.cause)
}

async function loadSharp(): Promise<typeof sharp> {
  try {
    return (await import('sharp')).default
  } catch (error) {
    if (!isMissingModule(error)) throw error
    throw new Error('[@holo-js/kernel] Server-side image validation requires the optional "sharp" package. Install sharp in your application.', { cause: error })
  }
}

function skipSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0
    offset += 1
    if (size === 0) return offset
    offset += size
  }
  return null
}

function colorTableBytes(flags: number): number {
  return (flags & 0x80) === 0 ? 0 : 3 * (1 << ((flags & 0x07) + 1))
}

function hasCompleteGifStructure(bytes: Uint8Array): boolean {
  let offset: number | null = 13 + colorTableBytes(bytes[10] ?? 0)
  while (offset !== null && offset < bytes.length) {
    const introducer = bytes[offset]
    if (introducer === 0x3b) return true
    if (introducer === 0x21) {
      offset = skipSubBlocks(bytes, offset + 2)
    } else if (introducer === 0x2c) {
      offset = skipSubBlocks(bytes, offset + 10 + colorTableBytes(bytes[offset + 9] ?? 0) + 1)
    } else {
      return false
    }
  }
  return false
}

export async function verifyDecodedImage(contents: Uint8Array, mimeType: string, aspectRatios: readonly (readonly number[])[] = []): Promise<DecodedImageVerification> {
  const invalid: DecodedImageVerification = { valid: false, aspectRatios: [] }
  const matchesDecodedFormat = decodedFormatMatchers[mimeType]
  if (!matchesDecodedFormat) return invalid
  if (mimeType === 'image/gif' && !hasCompleteGifStructure(contents)) return invalid
  const decode = await loadSharp()
  try {
    const image = decode(contents, { animated: true, failOn: 'warning', limitInputPixels: imageDecodingLimits.maximumDecodedPixels })
    const metadata = await image.metadata()
    if (!matchesDecodedFormat(metadata) || (metadata.pages ?? 1) > imageDecodingLimits.maximumFrames) return invalid
    await image.stats()
    const width = metadata.width
    const height = metadata.pageHeight ?? metadata.height
    if (!width || !height) return invalid
    const precision = 1 / (Math.max((width + height) / 2, height) + 1)
    return {
      valid: true,
      aspectRatios: aspectRatios.map(ratios => ratios.some(ratio => Math.abs(ratio - width / height) <= precision)),
    }
  } catch {
    return invalid
  }
}
