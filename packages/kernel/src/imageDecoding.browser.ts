import type { DecodedImageVerification } from './imageDecoding'

export async function verifyDecodedImage(_contents: Uint8Array, _mimeType: string, aspectRatios: readonly (readonly number[])[] = []): Promise<DecodedImageVerification> {
  return { valid: true, aspectRatios: aspectRatios.map(() => true) }
}
