import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import type { HoloStorageRuntimeConfig, RuntimeDiskConfig } from './config'
import { localStoragePathInternals } from '@holo-js/kernel'

const temporaryRouteSegment = '__holo_private'

type LocalDisk = RuntimeDiskConfig & { driver: 'local' | 'public', root: string }

function signature(url: URL, expires: string, appKey: string): Buffer {
  return createHmac('sha256', appKey).update(JSON.stringify(['holo-storage-local-v1', url.origin, url.pathname, expires])).digest()
}

function isLocalDisk(disk: RuntimeDiskConfig | undefined): disk is LocalDisk {
  return Boolean(disk && disk.driver !== 's3' && typeof disk.root === 'string')
}

function isSafeSegment(segment: string): boolean {
  return localStoragePathInternals.segmentProblem(segment) === null
}

export function createTemporaryLocalStorageUrl(
  disk: RuntimeDiskConfig,
  path: string,
  config: HoloStorageRuntimeConfig & { appUrl?: string, appKey?: string },
  expiresIn: number,
): string {
  if (!isLocalDisk(disk)) throw new Error('[Holo Storage] Temporary local URLs require a local disk.')
  if (!config.appKey) throw new Error('[Holo Storage] Temporary local URLs require the configured application key.')
  if (!config.appUrl) throw new Error('[Holo Storage] Temporary local URLs require the configured application URL.')
  const fileSegments = path.split('/')
  if (fileSegments.filter(Boolean).at(-1)?.endsWith('$')) {
    throw new Error('[Holo Storage] Local file names ending in "$" are reserved for metadata.')
  }
  if (!fileSegments.every(isSafeSegment)) throw new Error('[Holo Storage] Invalid temporary local storage path.')
  const segments = [disk.name, ...fileSegments]
  const url = new URL(config.appUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('[Holo Storage] Temporary local URLs require an HTTP application URL.')
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${config.routePrefix.replace(/^\/+|\/+$/gu, '')}/${temporaryRouteSegment}/${segments.map(encodeURIComponent).join('/')}`
  url.search = ''
  url.hash = ''
  const expires = String(Math.floor(Date.now() / 1000) + expiresIn)
  url.searchParams.set('expires', expires)
  url.searchParams.set('signature', signature(url, expires, config.appKey).toString('hex'))
  return url.toString()
}

export function isTemporaryLocalStorageRequest(config: HoloStorageRuntimeConfig, url: URL): boolean {
  return url.pathname.startsWith(`${config.routePrefix.replace(/\/+$/u, '')}/${temporaryRouteSegment}/`)
}

export function resolveTemporaryLocalStorageRequest(
  projectRoot: string,
  config: HoloStorageRuntimeConfig,
  routedUrl: URL,
  visitorUrl: URL,
  appKey: string | undefined,
  method = 'GET',
): { disk: LocalDisk, absolutePath: string } | null {
  if (!appKey || !['GET', 'HEAD'].includes(method) || !isTemporaryLocalStorageRequest(config, routedUrl)) return null
  if (visitorUrl.searchParams.size !== 2) return null
  const expires = visitorUrl.searchParams.get('expires')
  const suppliedSignature = visitorUrl.searchParams.get('signature')
  if (!expires || !/^[1-9]\d*$/u.test(expires) || !Number.isSafeInteger(Number(expires)) || Number(expires) <= Math.floor(Date.now() / 1000)) return null
  if (!suppliedSignature || !/^[a-f0-9]{64}$/u.test(suppliedSignature)) return null
  if (!timingSafeEqual(Buffer.from(suppliedSignature, 'hex'), signature(visitorUrl, expires, appKey))) return null
  const prefix = `${config.routePrefix.replace(/\/+$/u, '')}/${temporaryRouteSegment}/`
  let segments: string[]
  try {
    segments = routedUrl.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  const [diskName, ...fileSegments] = segments
  if (fileSegments.length === 0 || fileSegments.at(-1)?.endsWith('$') || !fileSegments.every(isSafeSegment)) return null
  const disk = diskName && Object.hasOwn(config.disks, diskName) ? config.disks[diskName] : undefined
  if (!isLocalDisk(disk)) return null
  const root = resolve(projectRoot, disk.root)
  return { disk: { ...disk, root }, absolutePath: resolve(root, ...fileSegments) }
}
