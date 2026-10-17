import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { mediaRuntimeInternals } from '../src'

const fixture = (extension: string) => readFile(new URL(`./fixtures/mime/sample.${extension}`, import.meta.url))

it.each([
  ['wav', 'audio/wav'],
  ['mp3', 'audio/mpeg'],
  ['flac', 'audio/flac'],
  ['ogg', 'audio/ogg; codecs=opus'],
  ['m4a', 'audio/x-m4a'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['avi', 'video/vnd.avi'],
  ['pdf', 'application/pdf'],
])('identifies encoded %s bytes despite a spoofed file name and declaration', async (extension, mimeType) => {
  const upload = new File([await fixture(extension)], 'spoofed.png', { type: 'image/png' })
  const contents = new Uint8Array(await upload.arrayBuffer())
  await expect(mediaRuntimeInternals.inspectMimeType(contents)).resolves.toBe(mimeType)
})

it.each(['gif', 'jpeg', 'png', 'webp'] as const)('identifies encoded %s image bytes', async format => {
  const contents = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#aabbcc' } }).toFormat(format).toBuffer()
  await expect(mediaRuntimeInternals.inspectMimeType(contents)).resolves.toBe(`image/${format}`)
})

it.each([
  new Uint8Array(),
  new Uint8Array([0xff]),
  Buffer.from('RIFF'),
  Buffer.from('ID3'),
  Buffer.from('unrecognized bytes'),
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
])('returns an unknown MIME for insufficient or unrecognized bytes %#', async contents => {
  const upload = new File([contents], 'spoofed.mp4', { type: 'video/mp4' })
  await expect(mediaRuntimeInternals.inspectMimeType(new Uint8Array(await upload.arrayBuffer()))).resolves.toBe('application/octet-stream')
})

it('returns unknown when audio identification requires reading beyond the inspection budget', async () => {
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 3, 127, 118])
  const contents = Buffer.concat([header, Buffer.alloc(65_526), await fixture('mp3')])
  await expect(mediaRuntimeInternals.inspectMimeType(contents)).resolves.toBe('application/octet-stream')
})
