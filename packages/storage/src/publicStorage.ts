import { Readable } from 'node:stream'
import { type FileHandle, open, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { type FileContentInspection, fileContentSampleBytes, inspectFileContent } from '@holo-js/kernel/file-content'
import { localStoragePathInternals } from '@holo-js/kernel'
import { normalizeModuleOptions, type RuntimeDiskConfig, type HoloStorageRuntimeConfig } from './config'
import type { NormalizedHoloStorageConfig } from './config'
import { isTemporaryLocalStorageRequest, resolveTemporaryLocalStorageRequest } from './temporaryLocalStorage'

const NAMED_PUBLIC_DISK_ROUTE_SEGMENT = '__holo'

type PublicLocalDisk = RuntimeDiskConfig & {
  driver: 'local' | 'public'
  visibility: 'public'
  root: string
}

type ResolvedPublicStorageRequest = {
  disk: PublicLocalDisk
  absolutePath: string
}

type PublicStorageResponseHeaders = {
  readonly 'content-disposition'?: string
  readonly 'content-type': string
  readonly 'x-content-type-options': string
}

function normalizeRequestPath(value: string): string[] | null {
  try {
    return value.split('/').map(segment => decodeURIComponent(segment.trim())).filter(Boolean)
  } catch {
    return null
  }
}

function isPublicLocalDisk(disk: RuntimeDiskConfig | undefined): disk is PublicLocalDisk {
  return Boolean(disk && disk.visibility === 'public' && disk.driver !== 's3' && typeof disk.root === 'string')
}

function resolveAbsolutePath(projectRoot: string, disk: PublicLocalDisk, fileSegments: string[]): string | null {
  const root = resolve(projectRoot, disk.root)
  const absolutePath = resolve(root, ...fileSegments)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    return null
  }

  return absolutePath
}

function withCharset(mimeType: string): string {
  return mimeType.startsWith('text/') || mimeType === 'application/json' ? `${mimeType}; charset=utf-8` : mimeType
}

function resolvePublicFileHeaders({ mimeType, passive }: FileContentInspection): PublicStorageResponseHeaders {
  if (!mimeType || !passive) {
    return {
      'content-disposition': 'attachment',
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    }
  }

  return {
    'content-type': withCharset(mimeType),
    'x-content-type-options': 'nosniff',
  }
}

async function inspectLocalFile(file: FileHandle, path: string): Promise<FileContentInspection> {
  const sample = new Uint8Array(fileContentSampleBytes)
  const { bytesRead } = await file.read(sample, 0, sample.length, 0)
  return inspectFileContent(sample.subarray(0, bytesRead), path)
}

function createMissingFileResponse(): Response {
  return new Response('Storage file not found.', { status: 404 })
}

type ByteRange = { start: number, end: number }

function resolveByteRange(request: Request, size: number): ByteRange | 'unsatisfiable' | null {
  if (request.method !== 'GET' || request.headers.has('if-range') || size === 0) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.get('range')?.trim() ?? '')
  if (!match || (!match[1] && !match[2])) return null
  const length = BigInt(size)
  if (!match[1]) {
    const suffix = BigInt(match[2]!)
    if (suffix === 0n) return 'unsatisfiable'
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 }
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : length - 1n
  if (match[2] && end < start) return null
  if (start >= length) return 'unsatisfiable'
  return { start: Number(start), end: Number(end < length ? end : length - 1n) }
}

async function createLocalStorageFileResponse(projectRoot: string, disk: RuntimeDiskConfig & { root: string }, absolutePath: string, request: Request, privateFile = false): Promise<Response | null> {
  const root = await realpath(resolve(projectRoot, disk.root))
  const file = await open(absolutePath, 'r')
  let streaming = false
  try {
    const opened = await file.stat()
    const path = await realpath(absolutePath)
    if (path === root || !path.startsWith(`${root}${sep}`)) return null
    const resolvedFile = await stat(path)
    if (opened.dev !== resolvedFile.dev || opened.ino !== resolvedFile.ino || !opened.isFile()) return null
    const headers = new Headers(resolvePublicFileHeaders(await inspectLocalFile(file, path)))
    headers.set('accept-ranges', 'bytes')
    if (privateFile) headers.set('cache-control', 'private, no-store')
    const range = resolveByteRange(request, opened.size)
    if (range === 'unsatisfiable') {
      headers.set('content-range', `bytes */${opened.size}`)
      headers.set('content-length', '0')
      return new Response(null, { status: 416, headers })
    }
    const { start, end } = range ?? { start: 0, end: opened.size - 1 }
    headers.set('content-length', String(end - start + 1))
    if (range) headers.set('content-range', `bytes ${start}-${end}/${opened.size}`)
    const status = range ? 206 : 200
    if (request.method === 'HEAD' || opened.size === 0) return new Response(null, { status, headers })
    const body = Readable.toWeb(file.createReadStream({ start, end, highWaterMark: 65_536 }))
    const response = new Response(body as ReadableStream<Uint8Array>, { status, headers })
    streaming = true
    return response
  } finally {
    if (!streaming) await file.close()
  }
}

function resolveRouteSegments(routePath: string): string[] | null {
  const segments = normalizeRequestPath(routePath)
  return segments?.length ? segments : null
}

function areValidFileSegments(segments: readonly string[]): boolean {
  return segments.length > 0
    && !segments.at(-1)?.endsWith('$')
    && segments.every(segment => localStoragePathInternals.segmentProblem(segment) === null)
}

function resolveDefaultPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {
  const disk = isPublicLocalDisk(config.disks.public) ? config.disks.public : undefined
  if (!disk || !areValidFileSegments(segments)) {
    return null
  }

  const absolutePath = resolveAbsolutePath(projectRoot, disk, segments)
  return absolutePath ? { disk, absolutePath } : null
}

function usesReservedNamedDiskNamespace(segments: string[]): boolean {
  return segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT
}

function resolveNamedPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {
  const namedPublicDisks = Object.values(config.disks).filter((disk): disk is PublicLocalDisk => isPublicLocalDisk(disk) && disk.name !== 'public')
  const usesReservedNamespace = segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT
  const diskName = usesReservedNamespace ? segments[1] : segments[0]
  const disk = namedPublicDisks.find(candidate => candidate.name === diskName)
  if (!disk) {
    return null
  }

  const fileSegments = usesReservedNamespace ? segments.slice(2) : segments.slice(1)
  if (!areValidFileSegments(fileSegments)) {
    return null
  }

  const absolutePath = resolveAbsolutePath(projectRoot, disk, fileSegments)
  return absolutePath ? { disk, absolutePath } : null
}

function resolvePublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {
  if (usesReservedNamedDiskNamespace(segments)) {
    return resolveNamedPublicStorageRequest(projectRoot, config, segments) ?? resolveDefaultPublicStorageRequest(projectRoot, config, segments)
  }

  return resolveDefaultPublicStorageRequest(projectRoot, config, segments) ?? resolveNamedPublicStorageRequest(projectRoot, config, segments)
}

function resolveFallbackPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[], attemptedDiskName: string): ResolvedPublicStorageRequest | null {
  if (usesReservedNamedDiskNamespace(segments)) {
    return null
  }

  const candidates = [
    resolveDefaultPublicStorageRequest(projectRoot, config, segments),
    resolveNamedPublicStorageRequest(projectRoot, config, segments),
  ]

  return candidates.find(candidate => candidate && candidate.disk.name !== attemptedDiskName) ?? null
}

export async function createPublicStorageResponse(projectRoot: string, storageConfig: NormalizedHoloStorageConfig, request: Request, appKey?: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return createMissingFileResponse()
  const normalized = normalizeModuleOptions({
    defaultDisk: storageConfig.defaultDisk,
    routePrefix: storageConfig.routePrefix,
    disks: storageConfig.disks,
  })
  const url = new URL(request.url)
  const host = request.headers.get('host')
  if (host) {
    try {
      const authority = new URL(`${url.protocol}//${host}`)
      if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) return createMissingFileResponse()
      url.host = authority.host
    } catch {
      return createMissingFileResponse()
    }
  }
  if (isTemporaryLocalStorageRequest(normalized, url)) {
    const entry = resolveTemporaryLocalStorageRequest(projectRoot, normalized, url, appKey, request.method)
    if (!entry) return createMissingFileResponse()
    try {
      return await createLocalStorageFileResponse(projectRoot, entry.disk, entry.absolutePath, request, true) ?? createMissingFileResponse()
    } catch {
      return createMissingFileResponse()
    }
  }
  const pathname = url.pathname
  const routePath = pathname.startsWith(normalized.routePrefix) ? pathname.slice(normalized.routePrefix.length) : pathname
  const segments = resolveRouteSegments(routePath)

  if (!segments) {
    return createMissingFileResponse()
  }

  const resolvedRequest = resolvePublicStorageRequest(projectRoot, normalized, segments)
  if (!resolvedRequest) {
    return createMissingFileResponse()
  }

  const tryRead = async (entry: ResolvedPublicStorageRequest): Promise<Response | null> => {
    try {
      return await createLocalStorageFileResponse(projectRoot, entry.disk, entry.absolutePath, request)
    } catch {
      return null
    }
  }

  const primary = await tryRead(resolvedRequest)
  if (primary) {
    return primary
  }

  const fallback = resolveFallbackPublicStorageRequest(projectRoot, normalized, segments, resolvedRequest.disk.name)
  return fallback ? ((await tryRead(fallback)) ?? createMissingFileResponse()) : createMissingFileResponse()
}
