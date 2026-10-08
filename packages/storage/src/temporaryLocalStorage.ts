import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import type { HoloStorageRuntimeConfig, RuntimeDiskConfig } from './config'

const temporaryRouteSegment = '__holo_private'

type LocalDisk = RuntimeDiskConfig & { driver: 'local' | 'public', root: string }

function signature(url: URL, expires: string, appKey: string): Buffer {
  return createHmac('sha256', appKey).update(JSON.stringify(['holo-storage-local-v1', url.origin, url.pathname, expires])).digest()
}

function isLocalDisk(disk: RuntimeDiskConfig | undefined): disk is LocalDisk {
  return Boolean(disk && disk.driver !== 's3' && typeof disk.root === 'string')
}

function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !/[\\/]/u.test(segment) && !segment.includes('\u0000')
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
  const segments = [disk.name, ...path.split('/')]
  if (!segments.every(isSafeSegment)) throw new Error('[Holo Storage] Invalid temporary local storage path.')
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
  url: URL,
  appKey: string | undefined,
  method = 'GET',
): { disk: LocalDisk, absolutePath: string } | null {
  if (!appKey || !['GET', 'HEAD'].includes(method) || !isTemporaryLocalStorageRequest(config, url)) return null
  if (url.searchParams.size !== 2) return null
  const expires = url.searchParams.get('expires')
  const suppliedSignature = url.searchParams.get('signature')
  if (!expires || !/^[1-9]\d*$/u.test(expires) || !Number.isSafeInteger(Number(expires)) || Number(expires) <= Math.floor(Date.now() / 1000)) return null
  if (!suppliedSignature || !/^[a-f0-9]{64}$/u.test(suppliedSignature)) return null
  if (!timingSafeEqual(Buffer.from(suppliedSignature, 'hex'), signature(url, expires, appKey))) return null
  const prefix = `${config.routePrefix.replace(/\/+$/u, '')}/${temporaryRouteSegment}/`
  let segments: string[]
  try {
    segments = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  if (segments.length < 2 || !segments.every(isSafeSegment)) return null
  const [diskName, ...fileSegments] = segments
  const disk = diskName ? config.disks[diskName] : undefined
  if (!isLocalDisk(disk)) return null
  const root = resolve(projectRoot, disk.root)
  return { disk: { ...disk, root }, absolutePath: resolve(root, ...fileSegments) }
}

export const storageRuntimeInternals = Object.freeze({
  isTemporaryLocalStorageRequest,
  resolveTemporaryLocalStorageRequest,
})
