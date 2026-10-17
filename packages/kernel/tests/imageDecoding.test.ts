import { afterEach, describe, expect, it, vi } from 'vitest'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

afterEach(() => {
  vi.doUnmock('sharp')
  vi.resetModules()
})

describe('server-side image decoding', () => {
  it('asks for the optional sharp package instead of weakening image validation', async () => {
    vi.doMock('sharp', () => {
      throw Object.assign(new Error('Cannot find package \'sharp\''), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const { verifyDecodedImage } = await import('../src/imageDecoding.node')
    await expect(verifyDecodedImage(pngPixel, 'image/png')).rejects.toThrow(
      '[@holo-js/kernel] Server-side image validation requires the optional "sharp" package. Install sharp in your application.',
    )
  })
})
