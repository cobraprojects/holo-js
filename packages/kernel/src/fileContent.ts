export type FileContentInspection = {
  readonly mimeType: string | null
  readonly passive: boolean
}

export const fileContentSampleBytes = 65_536

const mimeTypesByExtension: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xml: 'application/xml',
})

const passiveDocumentMimeTypes = new Set([
  'application/json',
  'application/pdf',
  'text/css',
  'text/csv',
  'text/markdown',
  'text/plain',
])

function isPassiveMimeType(mimeType: string | null): boolean {
  if (!mimeType) return false
  return passiveDocumentMimeTypes.has(mimeType)
    || (/^(?:image|audio|video|font)\//u.test(mimeType) && !mimeType.endsWith('+xml'))
}

export function mimeTypeFromFileName(fileName: string): string | null {
  const baseName = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
  const separator = baseName.lastIndexOf('.')
  if (separator < 1) return null
  return mimeTypesByExtension[baseName.slice(separator + 1).toLowerCase()] ?? null
}

export async function inspectFileContent(sample: Uint8Array, fileName?: string): Promise<FileContentInspection> {
  const { fileTypeFromBuffer, supportedMimeTypes } = await import('file-type')
  const detectableMimeTypes: ReadonlySet<string> = supportedMimeTypes
  const detected = await fileTypeFromBuffer(sample.subarray(0, fileContentSampleBytes)).catch(() => undefined)
  const named = fileName ? mimeTypeFromFileName(fileName) : null
  const mimeType = detected?.mime ?? (named && !detectableMimeTypes.has(named) ? named : null)
  return { mimeType, passive: isPassiveMimeType(mimeType) }
}
