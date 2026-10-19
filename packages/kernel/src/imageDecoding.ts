export const imageDecodingLimits = Object.freeze({
  maximumDecodedPixels: 40_000_000,
  maximumFrames: 1_000,
})

export interface DecodedImageVerification {
  readonly valid: boolean
  readonly aspectRatios: readonly boolean[]
}

export async function verifyDecodedImage(_contents: Uint8Array, _mimeType: string, _aspectRatios: readonly (readonly number[])[] = []): Promise<DecodedImageVerification> {
  throw new Error('[@holo-js/kernel] Server-side image validation must run on Node.js, where images can be fully decoded.')
}
