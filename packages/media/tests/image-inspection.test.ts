import sharp from 'sharp'
import { expect, it } from 'vitest'
import { mediaRuntimeInternals } from '../src'

const image = () => sharp({ create: { width: 3, height: 2, channels: 3, background: '#aabbcc' } })

it.each(['gif', 'jpeg', 'png', 'webp'] as const)('inspects real %s pixel data and reports its format and dimensions', async format => {
  const contents = await image().toFormat(format).toBuffer()
  await expect(mediaRuntimeInternals.inspectImage(contents)).resolves.toEqual({ mimeType: `image/${format}`, width: 3, height: 2, pages: 1 })
})

it('rejects corrupt compressed pixels even when image metadata remains readable', async () => {
  const contents = await image().png().toBuffer()
  const pixelData = contents.indexOf('IDAT')
  expect(pixelData).toBeGreaterThan(0)
  contents.fill(0, pixelData + 4, pixelData + 8)
  await expect(sharp(contents).metadata()).resolves.toMatchObject({ width: 3, height: 2 })
  await expect(mediaRuntimeInternals.inspectImage(contents)).rejects.toThrow('Image could not be decoded')
})

it('rejects empty input and signatures without decodable images', async () => {
  for (const contents of [new Uint8Array(), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array([0xff, 0xd8, 0xff])]) {
    await expect(mediaRuntimeInternals.inspectImage(contents)).rejects.toThrow('Image could not be decoded')
  }
})

it('enforces the decoded pixel limit', async () => {
  const contents = await image().png().toBuffer()
  await expect(mediaRuntimeInternals.inspectImage(contents, 6)).resolves.toMatchObject({ width: 3, height: 2 })
  await expect(mediaRuntimeInternals.inspectImage(contents, 5)).rejects.toThrow('Image could not be decoded')
})

it('counts every animation frame toward the decoded pixel limit', async () => {
  const pixels = Buffer.alloc(36, 200).fill(100, 18)
  const contents = await sharp(pixels, { raw: { width: 3, height: 4, channels: 3, pageHeight: 2 } }).gif({ delay: [100, 200] }).toBuffer()
  await expect(mediaRuntimeInternals.inspectImage(contents, 12)).resolves.toEqual({ mimeType: 'image/gif', width: 3, height: 2, pages: 2 })
  await expect(mediaRuntimeInternals.inspectImage(contents, 6)).rejects.toThrow('Image could not be decoded')
})

it('rejects active vector content rather than approving it as a raster image', async () => {
  const contents = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="red"/></svg>')
  await expect(mediaRuntimeInternals.inspectImage(contents)).rejects.toThrow('Image could not be decoded')
})
