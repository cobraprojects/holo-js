export async function verifyDecodedImage(_contents: Uint8Array, _mimeType: string): Promise<boolean> {
  throw new Error('[@holo-js/kernel] Server-side image validation must run on Node.js, where images can be fully decoded.')
}
