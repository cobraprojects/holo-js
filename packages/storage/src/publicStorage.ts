import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { normalizeModuleOptions, type RuntimeDiskConfig, type HoloStorageRuntimeConfig } from './config'
import type { NormalizedHoloStorageConfig } from '@holo-js/config'

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

function resolveAbsolutePath(projectRoot: string, disk: PublicLocalDisk, fileSegments: string[]): string | null {
  const root = resolve(projectRoot, disk.root)
  const absolutePath = resolve(root, ...fileSegments)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    return null
  }

  return absolutePath
}

function resolveContentType(absolutePath: string): string {
  switch (extname(absolutePath).toLowerCase()) {
    case '.avif': return 'image/avif'
    case '.css': return 'text/css; charset=utf-8'
    case '.gif': return 'image/gif'
    case '.html': return 'text/html; charset=utf-8'
    case '.jpeg':
    case '.jpg': return 'image/jpeg'
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.mp3': return 'audio/mpeg'
    case '.pdf': return 'application/pdf'
    case '.png': return 'image/png'
    case '.svg': return 'image/svg+xml'
    case '.txt': return 'text/plain; charset=utf-8'
    case '.webp': return 'image/webp'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

function createMissingFileResponse(): Response {
  return new Response('Storage file not found.', { status: 404 })
}

function resolveRouteSegments(routePath: string): string[] | null {
  const segments = normalizeRequestPath(routePath)
  if (segments.length === 0 || segments.includes('..')) {
    return null
  }

  return segments
}

function resolveDefaultPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {
  const disk = isPublicLocalDisk(config.disks.public) ? config.disks.public : undefined
  if (!disk) {
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
  const disk = diskName ? namedPublicDisks.find(candidate => candidate.name === diskName) : undefined
  if (!disk) {
    return null
  }

  const fileSegments = usesReservedNamespace ? segments.slice(2) : segments.slice(1)
  if (fileSegments.length === 0) {
    return null
  }

  const absolutePath = resolveAbsolutePath(projectRoot, disk, fileSegments)
  return absolutePath ? { disk, absolutePath } : null
}

function resolvePublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, routePath: string): ResolvedPublicStorageRequest | null {
  const segments = resolveRouteSegments(routePath)
  if (!segments) {
    return null
  }

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

export async function createPublicStorageResponse(projectRoot: string, storageConfig: NormalizedHoloStorageConfig, request: Request): Promise<Response> {
  const normalized = normalizeModuleOptions({
    defaultDisk: storageConfig.defaultDisk,
    routePrefix: storageConfig.routePrefix,
    disks: storageConfig.disks,
  })
  const pathname = new URL(request.url).pathname
  const routePath = pathname.startsWith(normalized.routePrefix) ? pathname.slice(normalized.routePrefix.length) : pathname
  const segments = resolveRouteSegments(routePath)

  if (!segments) {
    return createMissingFileResponse()
  }

  const resolvedRequest = resolvePublicStorageRequest(projectRoot, normalized, routePath)
  if (!resolvedRequest) {
    return createMissingFileResponse()
  }

  const tryRead = async (entry: ResolvedPublicStorageRequest): Promise<Response | null> => {
    try {
      const resolvedRoot = await realpath(resolve(projectRoot, entry.disk.root))
      const resolvedPath = await realpath(entry.absolutePath)
      if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
        return null
      }

      const contents = await readFile(entry.absolutePath)
      return new Response(contents, {
        status: 200,
        headers: { 'content-type': resolveContentType(entry.absolutePath) },
      })
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
