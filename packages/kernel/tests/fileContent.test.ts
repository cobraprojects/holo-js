import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { fileContentSampleBytes, inspectFileContent, mimeTypeFromFileName } from '../src/fileContent'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const text = (value: string) => new TextEncoder().encode(value)
const fixture = (extension: string) => readFile(new URL(`./fixtures/mime/sample.${extension}`, import.meta.url))

describe('file content inspection', () => {
  it('identifies recognised bytes regardless of the file name', async () => {
    await expect(inspectFileContent(pngPixel, 'notes.txt')).resolves.toEqual({ mimeType: 'image/png', passive: true })
    await expect(inspectFileContent(pngPixel)).resolves.toEqual({ mimeType: 'image/png', passive: true })
  })

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
  ])('identifies encoded %s bytes behind a spoofed image name', async (extension, mimeType) => {
    await expect(inspectFileContent(await fixture(extension), 'spoofed.png')).resolves.toEqual({ mimeType, passive: true })
  })

  it.each([
    new Uint8Array(),
    new Uint8Array([0xff]),
    text('RIFF'),
    text('ID3'),
  ])('reports insufficient bytes behind a forgeable name as unknown %#', async (contents) => {
    await expect(inspectFileContent(contents, 'spoofed.mp4')).resolves.toEqual({ mimeType: null, passive: false })
  })

  it('reports unknown when identification needs bytes beyond the inspection sample', async () => {
    const header = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 3, 127, 118])
    const contents = Buffer.concat([header, Buffer.alloc(fileContentSampleBytes - header.length), await fixture('mp3')])
    await expect(inspectFileContent(contents, 'spoofed.mp4')).resolves.toEqual({ mimeType: null, passive: false })
  })

  it('treats script-capable content as active even behind a passive name', async () => {
    const xhtml = text('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>')
    await expect(inspectFileContent(xhtml, 'avatar.png')).resolves.toEqual({ mimeType: 'application/xml', passive: false })
  })

  it('refuses a forgeable extension whose bytes do not match', async () => {
    await expect(inspectFileContent(text('not really a picture'), 'cat.png')).resolves.toEqual({ mimeType: null, passive: false })
    await expect(inspectFileContent(text('quarterly numbers'), 'report.pdf')).resolves.toEqual({ mimeType: null, passive: false })
  })

  it('uses the extension for formats without recognisable bytes', async () => {
    await expect(inspectFileContent(text('id,name\n1,Ava'), 'people.CSV')).resolves.toEqual({ mimeType: 'text/csv', passive: true })
    await expect(inspectFileContent(text('{"ok":true}'), 'data.json')).resolves.toEqual({ mimeType: 'application/json', passive: true })
    await expect(inspectFileContent(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg')).resolves.toEqual({ mimeType: 'image/svg+xml', passive: false })
    await expect(inspectFileContent(text('<p>hi</p>'), 'page.html')).resolves.toEqual({ mimeType: 'text/html', passive: false })
    await expect(inspectFileContent(text('plain'), 'archive')).resolves.toEqual({ mimeType: null, passive: false })
  })

  it('inspects only the leading sample of large content', async () => {
    const large = new Uint8Array(fileContentSampleBytes * 4)
    large.set(pngPixel)
    await expect(inspectFileContent(large, 'large.png')).resolves.toEqual({ mimeType: 'image/png', passive: true })
  })

  it('maps file names to MIME types from one shared table', () => {
    expect(mimeTypeFromFileName('photo.JPG')).toBe('image/jpeg')
    expect(mimeTypeFromFileName('notes.md')).toBe('text/markdown')
    expect(mimeTypeFromFileName('font.woff2')).toBe('font/woff2')
    expect(mimeTypeFromFileName('index.htm')).toBe('text/html')
    expect(mimeTypeFromFileName('archive')).toBeNull()
    expect(mimeTypeFromFileName('.env')).toBeNull()
  })
})
