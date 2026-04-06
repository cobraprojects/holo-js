import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { RuntimeDiskConfig, HoloStorageRuntimeConfig } from '@holo-js/storage'
import { useRuntimeConfig } from '#imports'

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

function normalizeRequestPath(value: string): string[] {
  return value
    .split('/')
    .map((segment) => {
      const trimmed = segment.trim()
      if (!trimmed) {
        return trimmed
      }

      try {
        return decodeURIComponent(trimmed)
      } catch {
        return trimmed
      }
    })
    .filter(Boolean)
}

function isPublicLocalDisk(disk: RuntimeDiskConfig | undefined): disk is PublicLocalDisk {
  return Boolean(disk && disk.visibility === 'public' && disk.driver !== 's3' && typeof disk.root === 'string')
}

function isMissingFileError(error: unknown): error is Error & { code: string } {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined

  return Boolean(
    error
    && typeof error === 'object'
    && (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR'),
  )
}

function resolveAbsolutePath(disk: PublicLocalDisk, fileSegments: string[]): string | null {
  const root = resolve(disk.root)
  const absolutePath = resolve(root, ...fileSegments)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    return null
  }

  return absolutePath
}

function resolveContentType(absolutePath: string): string {
  switch (extname(absolutePath).toLowerCase()) {
    case '.avif':
      return 'image/avif'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.gif':
      return 'image/gif'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.mp3':
      return 'audio/mpeg'
    case '.pdf':
      return 'application/pdf'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.webp':
      return 'image/webp'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}

function createMissingFileError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = 'ENOENT'
  return error
}

function isPathWithinRoot(root: string, absolutePath: string): boolean {
  return absolutePath === root || absolutePath.startsWith(`${root}${sep}`)
}

async function readPublicFile(
  event: unknown,
  disk: PublicLocalDisk,
  absolutePath: string,
): Promise<Buffer> {
  const resolvedRoot = await realpath(resolve(disk.root))
  const resolvedPath = await realpath(absolutePath)

  if (!isPathWithinRoot(resolvedRoot, resolvedPath)) {
    throw createMissingFileError('Storage file not found.')
  }

  const contents = await readFile(absolutePath)
  setResponseHeader(event, 'content-type', resolveContentType(absolutePath))
  return contents
}

function resolveRouteSegments(routePath: string): string[] | null {
  const segments = normalizeRequestPath(routePath)
  if (segments.length === 0 || segments.includes('..')) {
    return null
  }

  return segments
}

function resolveDefaultPublicStorageRequest(
  config: HoloStorageRuntimeConfig,
  segments: string[],
): ResolvedPublicStorageRequest | null {
  const disk = isPublicLocalDisk(config.disks.public) ? config.disks.public : undefined
  if (!disk) {
    return null
  }

  const absolutePath = resolveAbsolutePath(disk, segments)
  if (!absolutePath) {
    return null
  }

  return { disk, absolutePath }
}

function usesReservedNamedDiskNamespace(segments: string[]): boolean {
  return segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT
}

function resolveNamedPublicStorageRequest(
  config: HoloStorageRuntimeConfig,
  segments: string[],
): ResolvedPublicStorageRequest | null {
  const namedPublicDisks = Object.values(config.disks).filter((disk): disk is PublicLocalDisk => {
    return isPublicLocalDisk(disk) && disk.name !== 'public'
  })

  const usesReservedNamespace = segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT
  const diskName = usesReservedNamespace ? segments[1] : segments[0]
  const disk = diskName
    ? namedPublicDisks.find(candidate => candidate.name === diskName)
    : undefined
  if (!disk) {
    return null
  }

  const fileSegments = usesReservedNamespace ? segments.slice(2) : segments.slice(1)
  if (fileSegments.length === 0) {
    return null
  }

  const absolutePath = resolveAbsolutePath(disk, fileSegments)
  if (!absolutePath) {
    return null
  }

  return { disk, absolutePath }
}

export function resolvePublicStorageRequest(
  config: HoloStorageRuntimeConfig,
  routePath: string,
): ResolvedPublicStorageRequest | null {
  const segments = resolveRouteSegments(routePath)
  if (!segments) {
    return null
  }

  if (usesReservedNamedDiskNamespace(segments)) {
    return resolveNamedPublicStorageRequest(config, segments)
      ?? resolveDefaultPublicStorageRequest(config, segments)
  }

  return resolveDefaultPublicStorageRequest(config, segments)
    ?? resolveNamedPublicStorageRequest(config, segments)
}

function resolveFallbackPublicStorageRequest(
  config: HoloStorageRuntimeConfig,
  segments: string[],
  attemptedDiskName: string,
): ResolvedPublicStorageRequest | null {
  if (usesReservedNamedDiskNamespace(segments)) {
    return null
  }

  const candidates = [
    resolveDefaultPublicStorageRequest(config, segments),
    resolveNamedPublicStorageRequest(config, segments),
  ]

  return candidates.find(candidate => candidate && candidate.disk.name !== attemptedDiskName) ?? null
}

export default defineEventHandler(async (event: unknown) => {
  const runtimeConfig = useRuntimeConfig() as { holoStorage: HoloStorageRuntimeConfig }
  const { holoStorage } = runtimeConfig
  const pathname = getRequestURL(event).pathname
  const routePath = pathname.startsWith(holoStorage.routePrefix)
    ? pathname.slice(holoStorage.routePrefix.length)
    : pathname
  const segments = resolveRouteSegments(routePath)

  if (!segments) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Storage file not found.',
    })
  }

  const resolved = resolvePublicStorageRequest(holoStorage, routePath)

  if (!resolved) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Storage file not found.',
    })
  }

  try {
    return await readPublicFile(event, resolved.disk, resolved.absolutePath)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }

    const fallback = resolveFallbackPublicStorageRequest(holoStorage, segments, resolved.disk.name)
    if (fallback) {
      try {
        return await readPublicFile(event, fallback.disk, fallback.absolutePath)
      } catch (fallbackError) {
        if (!isMissingFileError(fallbackError)) {
          throw fallbackError
        }
      }
    }

    throw createError({
      statusCode: 404,
      statusMessage: 'Storage file not found.',
    })
  }
})
