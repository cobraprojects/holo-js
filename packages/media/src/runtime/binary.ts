import { basename, extname } from 'node:path'
import type { StorageContent } from '@holo-js/storage/runtime'
import type { MediaConversionFormat } from '../definitions/conversions'

export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
})

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
])

const SHARP_OUTPUT_FORMATS = new Set([
  'avif',
  'jpeg',
  'jpg',
  'png',
  'webp',
])

export type BinaryContent = Exclude<StorageContent, string>

export function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('-')

  return sanitized || 'media.bin'
}

export function inferMimeType(fileName: string, explicit?: string): string | undefined {
  if (explicit?.trim()) {
    return explicit.trim()
  }

  const extension = extname(fileName).replace(/^\./, '').toLowerCase()
  return MIME_TYPES[extension]
}

export function getExtension(fileName: string): string | undefined {
  const extension = extname(fileName).replace(/^\./, '').toLowerCase()
  return extension || undefined
}

export function getDisplayName(fileName: string, explicit?: string): string {
  if (explicit?.trim()) {
    return explicit.trim()
  }

  return basename(fileName, extname(fileName))
}

export async function toBinaryContent(value: BinaryContent): Promise<Uint8Array | Buffer> {
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  return value
}

export async function toBuffer(value: BinaryContent): Promise<Buffer> {
  const content = await toBinaryContent(value)
  return Buffer.isBuffer(content) ? content : Buffer.from(content)
}

export function getContentSize(value: BinaryContent): number {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.byteLength
  }

  return (value as Blob).size
}

export function isImageSource(mimeType?: string | null, extension?: string | null): boolean {
  if (mimeType?.trim().toLowerCase().startsWith('image/')) {
    return true
  }

  return extension ? IMAGE_EXTENSIONS.has(extension.trim().toLowerCase()) : false
}

export function normalizeOutputFormat(
  extension?: string,
  conversionFormat?: MediaConversionFormat,
): MediaConversionFormat {
  if (conversionFormat) {
    return conversionFormat
  }

  const normalized = extension?.trim().toLowerCase()
  if (normalized && SHARP_OUTPUT_FORMATS.has(normalized)) {
    return normalized as MediaConversionFormat
  }

  return 'png'
}

export function replaceFileExtension(fileName: string, extension: string): string {
  const baseName = basename(fileName, extname(fileName)) || 'media'
  return `${baseName}.${extension}`
}
