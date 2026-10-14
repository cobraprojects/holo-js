import { createHash, createHmac } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storageRuntimeInternals } from '../../core/src/storageRuntime'
import type { HoloStorageRuntimeConfig } from '../src'
import type * as StorageRuntimeModule from '../src/runtime/composables/index'

let runtimeConfig: { holoStorage: HoloStorageRuntimeConfig, holo?: { appUrl?: string } }
let backends: Record<string, ReturnType<typeof storageRuntimeInternals.createFileStorageBackend>>
let storageRoot: string
const temporaryDirectories: string[] = []

const {
  Storage,
  configureStorageRuntime,
  createS3TemporaryUrl,
  resetStorageRuntime,
  StoragePaginationError,
  StorageMetadataUnsupportedError,
  useStorage,
} = await import('../src/runtime/composables')

function createBackend(base: string) {
  return storageRuntimeInternals.createFileStorageBackend(join(storageRoot, base.replace('holo:', '')))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function getSigningKey(secretAccessKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function encodeCanonicalUri(pathname: string): string {
  return pathname.replace(/[!'()*]/g, (value) => {
    return `%${value.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

function encodeCanonicalQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

function restoreGlobalProperty(
  property: 'useRuntimeConfig' | 'useStorage',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, property, descriptor)
    return
  }

  Reflect.deleteProperty(globalThis, property)
}

describe('Storage facade', () => {
  it.each(['local', 'public'])('reports persisted byte sizes on the %s disk after runtime reload', async (name) => {
    const disk = Storage.disk(name)
    const backend = backends[`holo:${name}`]
    if (!backend) throw new Error('Missing test storage backend')
    await disk.put('uploads/report.txt', new Uint8Array(96))
    await backend.setMeta?.('uploads:report.txt', { size: 0, mimeType: 'wrong/type' })
    resetStorageRuntime()
    configureStorageRuntime({
      getRuntimeConfig: () => runtimeConfig,
      getStorage: base => createBackend(base),
    })
    const reloaded = useStorage(name)
    await expect(reloaded.stat('uploads/report.txt')).resolves.toEqual({ size: 96, mimeType: null })
    await reloaded.put('empty.txt', '')
    await expect(reloaded.stat('empty.txt')).resolves.toEqual({ size: 0, mimeType: null })
    await expect(reloaded.stat('missing.txt')).resolves.toBeNull()
    await expect(reloaded.stat('uploads')).resolves.toBeNull()
    await expect(reloaded.stat('empty.txt/child')).resolves.toBeNull()
    await reloaded.delete('uploads/report.txt')
    await expect(reloaded.stat('uploads/report.txt')).resolves.toBeNull()
  })

  it('uses the default disk for file metadata', async () => {
    await Storage.put('default.txt', 'é')
    await expect(Storage.stat('default.txt')).resolves.toEqual({ size: 2, mimeType: null })
  })

  it.each(['../private.txt', 'nested/../../private.txt', '..\\private.txt', '/private.txt', 'C:\\private.txt', '', 'file\0.txt'])('rejects unsafe metadata paths: %j', async (path) => {
    await expect(Storage.stat(path)).rejects.toThrow()
  })

  it('rejects metadata reads through symlinks outside the disk root', async () => {
    await Storage.put('inside.txt', 'inside')
    const outside = join(storageRoot, 'private.txt')
    await writeFile(outside, 'private')
    await symlink(outside, join(storageRoot, 'local', 'escape.txt'))
    await expect(Storage.stat('escape.txt')).rejects.toThrow('Storage paths must stay inside')
  })

  it('reports unsupported metadata backends without downloading the file', async () => {
    const backend = backends['holo:local']
    if (!backend) throw new Error('Missing test storage backend')
    backend.getItemStat = undefined
    await expect(Storage.stat('file.txt')).rejects.toBeInstanceOf(StorageMetadataUnsupportedError)
  })

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  beforeEach(async () => {
    resetStorageRuntime()
    storageRoot = await mkdtemp(join(tmpdir(), 'holo-storage-facade-'))
    temporaryDirectories.push(storageRoot)

    runtimeConfig = {
      holoStorage: {
        defaultDisk: 'local',
        diskNames: [
          'local',
          'public',
          'assets',
          'media',
          'publicMedia',
          'pathStyleMedia',
          'legacyPublicLocal',
          'fallbackLocal',
          'noDefault',
          'missingBucketMedia',
          'missingEndpointMedia',
          'missingCredsMedia',
        ],
        routePrefix: '/storage',
        disks: {
          local: {
            name: 'local',
            driver: 'local',
            visibility: 'private',
            root: './storage/app',
          },
          public: {
            name: 'public',
            driver: 'public',
            visibility: 'public',
            root: './storage/app/public',
            url: 'https://app.test/storage',
          },
          assets: {
            name: 'assets',
            driver: 'public',
            visibility: 'public',
            root: './storage/assets',
          },
          media: {
            name: 'media',
            driver: 's3',
            visibility: 'private',
            bucket: 'media-bucket',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'supersecretkey',
            forcePathStyleEndpoint: false,
          },
          publicMedia: {
            name: 'publicMedia',
            driver: 's3',
            visibility: 'public',
            bucket: 'public-bucket',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            accessKeyId: 'AKIAPUBLIC',
            secretAccessKey: 'supersecretpublic',
            sessionToken: 'session-token',
            forcePathStyleEndpoint: false,
          },
          pathStyleMedia: {
            name: 'pathStyleMedia',
            driver: 's3',
            visibility: 'public',
            bucket: 'path-bucket',
            region: 'auto',
            endpoint: 'https://storage.example.com',
            accessKeyId: 'AKIAPATH',
            secretAccessKey: 'supersecretpath',
            forcePathStyleEndpoint: true,
          },
          prefixedMedia: {
            name: 'prefixedMedia',
            driver: 's3',
            visibility: 'public',
            bucket: 'prefixed-bucket',
            region: 'us-east-1',
            endpoint: 'https://gateway.example.com/storage',
            accessKeyId: 'AKIAPREFIXED',
            secretAccessKey: 'supersecretprefixed',
            forcePathStyleEndpoint: true,
          },
          prefixedVirtualHostMedia: {
            name: 'prefixedVirtualHostMedia',
            driver: 's3',
            visibility: 'public',
            bucket: 'virtual-bucket',
            region: 'us-east-1',
            endpoint: 'https://gateway.example.com/storage',
            accessKeyId: 'AKIAVIRTUAL',
            secretAccessKey: 'supersecretvirtual',
            forcePathStyleEndpoint: false,
          },
          legacyPublicLocal: {
            name: 'legacyPublicLocal',
            driver: 'public',
            visibility: 'public',
            root: './storage/legacy-public',
          },
          fallbackLocal: {
            name: 'fallbackLocal',
            driver: 'local',
            visibility: 'private',
          },
          noDefault: {
            name: 'noDefault',
            driver: 'local',
            visibility: 'private',
            root: './storage/no-default',
          },
          missingBucketMedia: {
            name: 'missingBucketMedia',
            driver: 's3',
            visibility: 'private',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            accessKeyId: 'AKIAMISSING',
            secretAccessKey: 'supersecretmissing',
            forcePathStyleEndpoint: false,
          },
          missingEndpointMedia: {
            name: 'missingEndpointMedia',
            driver: 's3',
            visibility: 'private',
            bucket: 'endpoint-missing',
            region: 'us-east-1',
            accessKeyId: 'AKIAENDPOINT',
            secretAccessKey: 'supersecretendpoint',
            forcePathStyleEndpoint: false,
          },
          missingCredsMedia: {
            name: 'missingCredsMedia',
            driver: 's3',
            visibility: 'private',
            bucket: 'creds-missing',
            region: 'us-east-1',
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            forcePathStyleEndpoint: false,
          },
          brokenPublicMedia: {
            name: 'brokenPublicMedia',
            driver: 's3',
            visibility: 'public',
            region: 'us-east-1',
            accessKeyId: 'AKIABROKEN',
            secretAccessKey: 'supersecretbroken',
            forcePathStyleEndpoint: false,
          },
        },
      },
      holo: {
        appUrl: 'https://app.test',
      },
    }

    backends = {
      'holo:local': createBackend('holo:local'),
      'holo:public': createBackend('holo:public'),
      'holo:assets': createBackend('holo:assets'),
      'holo:media': createBackend('holo:media'),
      'holo:publicMedia': createBackend('holo:publicMedia'),
      'holo:pathStyleMedia': createBackend('holo:pathStyleMedia'),
      'holo:prefixedMedia': createBackend('holo:prefixedMedia'),
      'holo:prefixedVirtualHostMedia': createBackend('holo:prefixedVirtualHostMedia'),
      'holo:legacyPublicLocal': createBackend('holo:legacyPublicLocal'),
      'holo:fallbackLocal': createBackend('holo:fallbackLocal'),
      'holo:noDefault': createBackend('holo:noDefault'),
      'holo:missingBucketMedia': createBackend('holo:missingBucketMedia'),
      'holo:missingEndpointMedia': createBackend('holo:missingEndpointMedia'),
      'holo:missingCredsMedia': createBackend('holo:missingCredsMedia'),
      'holo:brokenPublicMedia': createBackend('holo:brokenPublicMedia'),
    }

    configureStorageRuntime({
      getRuntimeConfig: () => runtimeConfig,
      getStorage: (base: string) => {
        const backend = backends[base]
        if (!backend) throw new Error(`Storage backend ${base} is not configured`)
        return backend
      },
    })
  })

  it('exposes the user-facing API from the runtime subpath', () => {
    expect(typeof Storage.disk).toBe('function')
    expect(typeof useStorage).toBe('function')
    expect(typeof createS3TemporaryUrl).toBe('function')
  })

  it('streams bounded chunks and supports create-only writes', async () => {
    const source = async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('streamed')
      yield new TextEncoder().encode('-value')
    }

    await expect(Storage.writeStream('reports/result.bin', source(), { overwrite: false })).resolves.toBe(true)
    await expect(Storage.writeStream('reports/result.bin', source(), { overwrite: false })).resolves.toBe(false)
    const stream = await Storage.readStream('reports/result.bin', { chunkBytes: 4096 })
    const chunks: Uint8Array[] = []
    for await (const chunk of stream ?? []) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('streamed-value')
    await expect(Storage.readStream('reports/result.bin', { chunkBytes: 4095 })).rejects.toThrow('4096 through 1048576')
  })

  it('reads a native read-only directory and rejects writes, then writes a native write-only file without exposing its contents', async () => {
    const directory = join(storageRoot, 'local', 'reports')
    await Storage.put('reports/result.bin', 'read-only')
    await chmod(directory, 0o500)
    try {
      const stream = await Storage.readStream('reports/result.bin')
      const chunks: Uint8Array[] = []
      for await (const chunk of stream ?? []) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe('read-only')
      await expect(Storage.writeStream('reports/blocked.bin', (async function* () { yield Buffer.from('blocked') })())).rejects.toThrow()
    } finally { await chmod(directory, 0o700) }
    const path = join(directory, 'write-only.bin')
    await writeFile(path, 'private', { mode: 0o200 })
    await expect(Storage.get('reports/write-only.bin')).rejects.toThrow('EACCES')
    await expect(Storage.writeStream('reports/write-only.bin', (async function* () { yield Buffer.from('write-only') })())).resolves.toBe(true)
    expect(await Storage.get('reports/write-only.bin')).toBe('write-only')
  })

  it('keeps the package root focused on module exports', async () => {
    const root = await import('../src')

    expect('Storage' in root).toBe(false)
    expect('useStorage' in root).toBe(false)
    expect('createS3TemporaryUrl' in root).toBe(false)
  })

  it('preserves the mounted storage backend surface on useStorage()', async () => {
    const storage = useStorage('local')

    await storage.setItemRaw('legacy:file.txt', 'legacy-value')

    await expect(storage.getItemRaw('legacy:file.txt')).resolves.toEqual(Buffer.from('legacy-value'))
  })

  it('shares explicit runtime bindings across isolated module instances', async () => {
    const isolatedRuntime = await import(
      '../src/runtime/composables/index.ts' + '?isolated-storage-runtime'
    ) as typeof StorageRuntimeModule

    try {
      await expect(isolatedRuntime.useStorage('public').exists('avatars/user-1.txt')).resolves.toBe(false)
      expect(isolatedRuntime.useStorage('public').url('avatars/user-1.txt')).toBe(
        'https://app.test/storage/avatars/user-1.txt',
      )
    } finally {
      isolatedRuntime.resetStorageRuntime()
      configureStorageRuntime({
        getRuntimeConfig: () => runtimeConfig,
        getStorage: (base: string) => {
        const backend = backends[base]
        if (!backend) throw new Error(`Storage backend ${base} is not configured`)
        return backend
      },
      })
    }
  })

  it('removes shared runtime globals when explicit bindings are cleared', () => {
    const runtimeGlobals = globalThis as typeof globalThis & {
      __holoStorageRuntimeBindings__?: unknown
    }

    expect(runtimeGlobals.__holoStorageRuntimeBindings__).toBeDefined()

    configureStorageRuntime(undefined)
    expect(runtimeGlobals.__holoStorageRuntimeBindings__).toBeUndefined()

    configureStorageRuntime({
      getRuntimeConfig: () => runtimeConfig,
      getStorage: (base: string) => {
        const backend = backends[base]
        if (!backend) throw new Error(`Storage backend ${base} is not configured`)
        return backend
      },
    })
  })

  it('falls back to runtime globals when explicit bindings are absent', async () => {
    const backend = createBackend('holo:public')
    const previousUseRuntimeConfig = Object.getOwnPropertyDescriptor(globalThis, 'useRuntimeConfig')
    const previousUseStorage = Object.getOwnPropertyDescriptor(globalThis, 'useStorage')

    Object.defineProperty(globalThis, 'useRuntimeConfig', {
      configurable: true,
      writable: true,
      value: () => runtimeConfig,
    })
    Object.defineProperty(globalThis, 'useStorage', {
      configurable: true,
      writable: true,
      value: () => backend,
    })
    resetStorageRuntime()

    try {
      await expect(useStorage('public').exists('avatars/user-1.txt')).resolves.toBe(false)
      expect(useStorage('public').url('avatars/user-1.txt')).toBe('https://app.test/storage/avatars/user-1.txt')
    } finally {
      restoreGlobalProperty('useRuntimeConfig', previousUseRuntimeConfig)
      restoreGlobalProperty('useStorage', previousUseStorage)
    }
  })

  it('throws when neither explicit bindings nor runtime globals are configured', () => {
    const previousUseRuntimeConfig = Object.getOwnPropertyDescriptor(globalThis, 'useRuntimeConfig')
    const previousUseStorage = Object.getOwnPropertyDescriptor(globalThis, 'useStorage')

    Reflect.deleteProperty(globalThis, 'useRuntimeConfig')
    Reflect.deleteProperty(globalThis, 'useStorage')
    resetStorageRuntime()

    try {
      expect(() => useStorage('local')).toThrow('Storage runtime is not configured')
    } finally {
      restoreGlobalProperty('useRuntimeConfig', previousUseRuntimeConfig)
      restoreGlobalProperty('useStorage', previousUseStorage)
    }
  })

  it('supports the default facade methods end to end', async () => {
    expect(await Storage.get('missing.txt')).toBeNull()
    expect(await Storage.getBytes('missing.txt')).toBeNull()
    expect(await Storage.json('missing.json')).toBeNull()

    await Storage.put(' reports\\daily.txt ', 'ready')
    await Storage.putJson('reports/summary.json', { ok: true })

    expect(await Storage.get('reports/daily.txt')).toBe('ready')
    expect(new TextDecoder().decode((await Storage.getBytes('reports/daily.txt')) ?? new Uint8Array())).toBe('ready')
    expect(await Storage.json<{ ok: boolean }>('reports/summary.json')).toEqual({ ok: true })
    expect(await Storage.exists('reports/daily.txt')).toBe(true)
    expect(await Storage.missing('reports/ghost.txt')).toBe(true)
    expect((await Storage.disk('local').listFiles('reports')).paths).toEqual([
      'reports/daily.txt',
      'reports/summary.json',
    ])
    expect((await Storage.listFiles()).paths).toEqual([
      'reports/daily.txt',
      'reports/summary.json',
    ])
    expect(Storage.path('')).toBe('./storage/app')

    expect(await Storage.copy('reports/daily.txt', 'reports/copied.txt')).toBe(true)
    expect(await Storage.copy('reports/ghost.txt', 'reports/failed.txt')).toBe(false)
    expect(await Storage.move('reports/copied.txt', 'reports/moved.txt')).toBe(true)
    expect(await Storage.move('reports/ghost.txt', 'reports/missing-move.txt')).toBe(false)

    expect(await Storage.delete(['reports/daily.txt', 'reports/summary.json'])).toBe(true)
    expect(await Storage.delete('reports/moved.txt')).toBe(true)
    expect(await Storage.missing('reports/daily.txt')).toBe(true)
    expect(await Storage.missing('reports/summary.json')).toBe(true)
    expect(Storage.path('reports/daily.txt')).toBe('./storage/app/reports/daily.txt')
    expect(Storage.disk('fallbackLocal').path('notes.txt')).toBe('./storage/app/notes.txt')
  })

  it('paginates file listings with disk-bound and directory-bound cursors', async () => {
    await Storage.put('reports/a.txt', 'a')
    await Storage.put('reports/b.txt', 'b')
    await Storage.put('reports/c.txt', 'c')

    const first = await Storage.listFiles('reports', { limit: 2 })
    expect(first.paths).toEqual(['reports/a.txt', 'reports/b.txt'])
    expect(first.nextCursor).toEqual(expect.any(String))
    await expect(Storage.listFiles('reports', {
      cursor: first.nextCursor,
      limit: 2,
    })).resolves.toMatchObject({
      nextCursor: null,
      paths: ['reports/c.txt'],
    })
    await expect(Storage.listFiles('other', {
      cursor: first.nextCursor,
      limit: 2,
    })).rejects.toBeInstanceOf(StoragePaginationError)
    await expect(Storage.disk('public').listFiles('reports', {
      cursor: first.nextCursor,
      limit: 2,
    })).rejects.toBeInstanceOf(StoragePaginationError)
  })

  it('fails closed when a native directory cannot be listed and resumes after its permissions are restored', async () => {
    await Storage.put('reports/private.txt', 'private')
    const directory = join(storageRoot, 'local', 'reports')
    await chmod(directory, 0)
    try { await expect(Storage.listFiles('reports')).rejects.toBeInstanceOf(StoragePaginationError) } finally { await chmod(directory, 0o700) }
    expect((await Storage.listFiles('reports')).paths).toEqual(['reports/private.txt'])
  })

  it('rejects invalid list limits and excludes native symlinks pointing outside the storage root', async () => {
    await expect(Storage.listFiles('', { limit: 0 })).rejects.toBeInstanceOf(StoragePaginationError)
    await expect(Storage.listFiles('', { limit: 1001 })).rejects.toBeInstanceOf(StoragePaginationError)
    const outside = join(storageRoot, 'secret.txt')
    await writeFile(outside, 'secret')
    await Storage.put('safe.txt', 'safe')
    await symlink(outside, join(storageRoot, 'local', 'outside.txt'))
    expect((await Storage.listFiles()).paths).toEqual(['safe.txt'])
    await expect(Storage.get('outside.txt')).rejects.toThrow()
  })

  it('preserves literal colons in file listings', async () => {
    await Storage.put('reports/2024:Q1.txt', 'quarterly-report')

    await expect(Storage.disk('local').listFiles('reports')).resolves.toMatchObject({ paths: [
      'reports/2024:Q1.txt',
    ] })
  })

  it('omits metadata sidecars from file listings', async () => {
    const local = useStorage('local')

    await Storage.put('reports/daily.txt', 'ready')
    if (!local.setMeta) throw new Error('Native metadata storage is unavailable')
    await local.setMeta('reports:daily.txt', 'etag-1')

    await expect(Storage.disk('local').listFiles('reports')).resolves.toMatchObject({ paths: [
      'reports/daily.txt',
    ] })
    await expect(Storage.listFiles()).resolves.toMatchObject({ paths: [
      'reports/daily.txt',
    ] })
  })

  it('handles raw byte conversions across supported storage value shapes', async () => {
    const local = Storage.disk('local')

    await local.put('blob/data.bin', new Blob(['blob-data']))
    expect(await local.get('blob/data.bin')).toBe('blob-data')

    await backends['holo:local']!.setItemRaw('raw:buffer.txt', Buffer.from('buffer-data'))
    await backends['holo:local']!.setItemRaw('raw:arraybuffer.txt', new TextEncoder().encode('array-buffer-data').buffer)
    await backends['holo:local']!.setItemRaw('raw:uint8.txt', new TextEncoder().encode('uint8-data'))

    expect(await local.get('raw/buffer.txt')).toBe('buffer-data')
    expect(new TextDecoder().decode((await local.getBytes('raw/arraybuffer.txt')) ?? new Uint8Array())).toBe('array-buffer-data')
    expect(new TextDecoder().decode((await local.getBytes('raw/uint8.txt')) ?? new Uint8Array())).toBe('uint8-data')
    expect(new TextDecoder().decode((await local.getBytes('blob/data.bin')) ?? new Uint8Array())).toBe('blob-data')
  })

  it('rejects unsupported JavaScript values without creating a native file', async () => {
    await expect(Storage.put('raw/invalid.txt', 0 as never)).rejects.toThrow()
    expect(await Storage.exists('raw/invalid.txt')).toBe(false)
  })

  it('preserves malformed encoded keys when listing backend files', async () => {
    await backends['holo:local']!.setItemRaw('reports:bad%ZZname.txt', new TextEncoder().encode('bad'))

    expect((await Storage.disk('local').listFiles('reports')).paths).toContain('reports/bad%ZZname.txt')
  })

  it('supports explicit disk selection and public local urls', async () => {
    const publicDisk = useStorage('public')
    await publicDisk.put('avatars/user-1.txt', 'ok')

    expect(await publicDisk.exists('avatars/user-1.txt')).toBe(true)
    expect(publicDisk.url('avatars/user-1.txt')).toBe('https://app.test/storage/avatars/user-1.txt')
    expect(Storage.disk('assets').url('avatars/user-2.txt')).toBe('https://app.test/storage/__holo/assets/avatars/user-2.txt')

    runtimeConfig = {
      ...runtimeConfig,
      holoStorage: {
        ...runtimeConfig.holoStorage,
        disks: {
          ...runtimeConfig.holoStorage.disks,
          public: {
            ...runtimeConfig.holoStorage.disks.public!,
            url: undefined,
          },
        },
      },
    }

    expect(Storage.disk('public').url('')).toBe('https://app.test/storage')
  })

  it('builds public local urls without an appUrl when only the route prefix is configured', () => {
    runtimeConfig = {
      holoStorage: {
        ...runtimeConfig.holoStorage,
        disks: {
          ...runtimeConfig.holoStorage.disks,
          public: {
            ...runtimeConfig.holoStorage.disks.public!,
            url: undefined,
          },
        },
      },
    }

    expect(Storage.disk('public').url('avatars/user-1.txt')).toBe('/storage/avatars/user-1.txt')
    expect(Storage.disk('assets').url('avatars/user-2.txt')).toBe('/storage/__holo/assets/avatars/user-2.txt')
  })

  it('encodes reserved characters in generated public urls', () => {
    expect(Storage.disk('public').url('reports/Q1 #1.pdf')).toBe(
      'https://app.test/storage/reports/Q1%20%231.pdf',
    )

    expect(Storage.disk('assets').url('avatars/My File.png')).toBe(
      'https://app.test/storage/__holo/assets/avatars/My%20File.png',
    )

    expect(Storage.disk('publicMedia').url('images/summer #1.jpg')).toBe(
      'https://public-bucket.s3.us-east-1.amazonaws.com/images/summer%20%231.jpg',
    )
  })

  it('rejects traversing segments when generating local paths and public urls', () => {
    expect(() => Storage.disk('local').path('../secret.txt')).toThrow('must not contain')
    expect(() => Storage.disk('public').url('../x.png')).toThrow('must not contain')
    expect(() => Storage.disk('media').path('../exports/report.pdf')).toThrow('must not contain')
  })

  it('rejects traversing segments before backend storage operations', async () => {
    await expect(Storage.put('../secret.txt', 'x')).rejects.toThrow('must not contain')
    await expect(Storage.putJson('../secret.json', { ok: true })).rejects.toThrow('must not contain')
    await expect(Storage.get('../secret.txt')).rejects.toThrow('must not contain')
    await expect(Storage.getBytes('../secret.txt')).rejects.toThrow('must not contain')
    await expect(Storage.exists('../secret.txt')).rejects.toThrow('must not contain')
    await expect(Storage.delete('../secret.txt')).rejects.toThrow('must not contain')
    await expect(Storage.delete(['reports/daily.txt', '../secret.txt'])).rejects.toThrow('must not contain')
    await expect(Storage.copy('../secret.txt', 'reports/copied.txt')).rejects.toThrow('must not contain')
    await expect(Storage.copy('reports/daily.txt', '../secret.txt')).rejects.toThrow('must not contain')
    await expect(Storage.move('../secret.txt', 'reports/moved.txt')).rejects.toThrow('must not contain')
    await expect(Storage.move('reports/daily.txt', '../secret.txt')).rejects.toThrow('must not contain')
    await expect(Storage.listFiles('../')).rejects.toThrow('must not contain')
  })

  it('builds public urls for s3-compatible disks', () => {
    expect(Storage.disk('publicMedia').url('images/photo.jpg')).toBe(
      'https://public-bucket.s3.us-east-1.amazonaws.com/images/photo.jpg',
    )

    expect(Storage.disk('pathStyleMedia').url('images/photo.jpg')).toBe(
      'https://storage.example.com/path-bucket/images/photo.jpg',
    )

    expect(Storage.disk('prefixedMedia').url('images/photo.jpg')).toBe(
      'https://gateway.example.com/storage/prefixed-bucket/images/photo.jpg',
    )

    expect(Storage.disk('prefixedVirtualHostMedia').url('images/photo.jpg')).toBe(
      'https://virtual-bucket.gateway.example.com/storage/images/photo.jpg',
    )
  })

  it('preserves existing query strings when building public urls', () => {
    runtimeConfig = {
      ...runtimeConfig,
      holoStorage: {
        ...runtimeConfig.holoStorage,
        disks: {
          ...runtimeConfig.holoStorage.disks,
          public: {
            ...runtimeConfig.holoStorage.disks.public!,
            url: 'https://cdn.example.com/files?token=abc',
          },
          publicMedia: {
            ...runtimeConfig.holoStorage.disks.publicMedia!,
            endpoint: 'https://gateway.example.com/storage?x=2&x=1',
          },
        },
      },
    }

    expect(Storage.disk('public').url('avatars/user-1.txt')).toBe(
      'https://cdn.example.com/files/avatars/user-1.txt?token=abc',
    )
    expect(Storage.disk('publicMedia').url('images/photo.jpg')).toBe(
      'https://public-bucket.gateway.example.com/storage/images/photo.jpg?x=2&x=1',
    )
  })

  it('rejects invalid url and disk resolution cases', () => {
    expect(() => Storage.url('secret.txt')).toThrow('private')
    expect(() => Storage.disk('media').url('images/photo.jpg')).toThrow('private')
    expect(Storage.disk('legacyPublicLocal').url('images/photo.jpg')).toBe('https://app.test/storage/__holo/legacyPublicLocal/images/photo.jpg')
    expect(() => Storage.disk('brokenPublicMedia').url('images/photo.jpg')).toThrow('does not expose a public URL')
    expect(() => useStorage('unknown')).toThrow('not configured')

    runtimeConfig = {
      ...runtimeConfig,
      holoStorage: {
        ...runtimeConfig.holoStorage,
        defaultDisk: undefined,
      },
    }

    expect(() => useStorage()).toThrow('No disk name provided')
  })

  it('can resolve an explicit disk even if no default disk is configured', async () => {
    runtimeConfig = {
      ...runtimeConfig,
      holoStorage: {
        ...runtimeConfig.holoStorage,
        defaultDisk: undefined,
      },
    }

    await expect(useStorage('public').exists('avatars/user-1.txt')).resolves.toBe(false)
  })

  it('handles disk-specific operations and error cases', async () => {
    const media = Storage.disk('media')

    expect(media.path('exports/report.pdf')).toBe('s3://media-bucket/exports/report.pdf')
    expect(() => Storage.disk('missingBucketMedia').path('exports/report.pdf')).toThrow('requires a bucket')

    expect(() => Storage.disk('public').temporaryUrl('avatars/user-1.txt')).toThrow('configured application key')
    expect(() => Storage.disk('missingBucketMedia').temporaryUrl('exports/report.pdf')).toThrow('requires a bucket')
    expect(() => Storage.disk('missingEndpointMedia').temporaryUrl('exports/report.pdf')).toThrow('requires an endpoint')
    expect(() => Storage.disk('missingCredsMedia').temporaryUrl('exports/report.pdf')).toThrow('requires accessKeyId')

    runtimeConfig = {
      ...runtimeConfig,
      holoStorage: {
        ...runtimeConfig.holoStorage,
        defaultDisk: 'media',
      },
    }

    const signed = Storage.temporaryUrl('exports/report.pdf', { expiresIn: 90 })
    expect(signed).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(Storage.disk('publicMedia').temporaryUrl('')).toContain(
      'https://public-bucket.s3.us-east-1.amazonaws.com/?',
    )
    expect(Storage.disk('prefixedVirtualHostMedia').temporaryUrl('')).toContain(
      'https://virtual-bucket.gateway.example.com/storage?',
    )
  })
})

describe('createS3TemporaryUrl', () => {
  it('supports direct presigning with expiresAt and session tokens', () => {
    const url = createS3TemporaryUrl({
      name: 'publicMedia',
      driver: 's3',
      visibility: 'public',
      bucket: 'public-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAPUBLIC',
      secretAccessKey: 'supersecretpublic',
      sessionToken: 'session-token',
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf', { expiresAt: Date.now() + 120_000 })

    expect(url).toContain('https://public-bucket.s3.us-east-1.amazonaws.com/exports/report.pdf')
    expect(url).toContain('X-Amz-Security-Token=session-token')
    expect(url).toContain('X-Amz-Expires=')
  })

  it('supports path-style s3 endpoints for compatible providers', () => {
    const url = createS3TemporaryUrl({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media',
      region: 'auto',
      endpoint: 'https://storage.example.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: true,
    }, 'exports/report.pdf', { expiresIn: 120 })

    expect(url).toContain('https://storage.example.com/media/exports/report.pdf')
    expect(url).toContain('X-Amz-Expires=120')
  })

  it('RFC3986-encodes reserved path characters when presigning temporary urls', () => {
    const url = createS3TemporaryUrl({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: false,
    }, 'exports/Photo !(1)*\'.jpg', { expiresIn: 120 })

    expect(url).toContain('/exports/Photo%20%21%281%29%2A%27.jpg')
  })

  it('canonicalizes reserved characters in endpoint path prefixes when presigning', () => {
    const url = createS3TemporaryUrl({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage(1)',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: true,
    }, 'exports/report.pdf', { expiresIn: 120 })

    expect(url).toContain('https://gateway.example.com/storage(1)/media-bucket/exports/report.pdf')
  })

  it('preserves endpoint path prefixes when presigning s3-compatible URLs', () => {
    const pathStyleUrl = createS3TemporaryUrl({
      name: 'prefixedMedia',
      driver: 's3',
      visibility: 'public',
      bucket: 'prefixed-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage',
      accessKeyId: 'AKIAPREFIXED',
      secretAccessKey: 'supersecretprefixed',
      forcePathStyleEndpoint: true,
    }, 'exports/report.pdf', { expiresIn: 120 })

    expect(pathStyleUrl).toContain('https://gateway.example.com/storage/prefixed-bucket/exports/report.pdf')

    const virtualHostUrl = createS3TemporaryUrl({
      name: 'prefixedVirtualHostMedia',
      driver: 's3',
      visibility: 'public',
      bucket: 'virtual-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage',
      accessKeyId: 'AKIAVIRTUAL',
      secretAccessKey: 'supersecretvirtual',
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf', { expiresIn: 120 })

    expect(virtualHostUrl).toContain('https://virtual-bucket.gateway.example.com/storage/exports/report.pdf')
  })

  it('sorts duplicate endpoint query parameters when presigning', () => {
    const secretAccessKey = 'supersecretqueryful'
    const url = new URL(createS3TemporaryUrl({
      name: 'queryfulMedia',
      driver: 's3',
      visibility: 'public',
      bucket: 'queryful-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage?x=2&x=1',
      accessKeyId: 'AKIAQUERYFUL',
      secretAccessKey,
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf', { expiresIn: 120 }))

    const amzDate = url.searchParams.get('X-Amz-Date')!
    const credential = decodeURIComponent(url.searchParams.get('X-Amz-Credential')!)
    const credentialScope = credential.split('/').slice(1).join('/')
    const scopeDate = credentialScope.split('/')[0]!
    const canonicalQueryString = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== 'X-Amz-Signature')
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey === rightKey) {
          return leftValue.localeCompare(rightValue)
        }

        return leftKey.localeCompare(rightKey)
      })
      .map(([key, value]) => `${encodeCanonicalQueryComponent(key)}=${encodeCanonicalQueryComponent(value)}`)
      .join('&')
    const canonicalRequest = [
      'GET',
      url.pathname,
      canonicalQueryString,
      `host:${url.host}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const expectedSignature = createHmac('sha256', getSigningKey(secretAccessKey, scopeDate, 'us-east-1'))
      .update([
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256(canonicalRequest),
      ].join('\n'))
      .digest('hex')

    expect(url.searchParams.get('X-Amz-Signature')).toBe(expectedSignature)
  })

  it('RFC3986-encodes endpoint query parameters when presigning', () => {
    const secretAccessKey = 'supersecretquerychars'
    const region = 'us-east-1'
    const responseDisposition = 'attachment; filename=photo(1)!.jpg'
    const url = new URL(createS3TemporaryUrl({
      name: 'queryfulMedia',
      driver: 's3',
      visibility: 'public',
      bucket: 'queryful-bucket',
      region,
      endpoint: `https://gateway.example.com/storage?response-content-disposition=${encodeURIComponent(responseDisposition)}`,
      accessKeyId: 'AKIAQUERYCHARS',
      secretAccessKey,
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf', { expiresIn: 120 }))

    const amzDate = url.searchParams.get('X-Amz-Date')!
    const credential = decodeURIComponent(url.searchParams.get('X-Amz-Credential')!)
    const credentialScope = credential.split('/').slice(1).join('/')
    const scopeDate = credentialScope.split('/')[0]!
    const canonicalQueryString = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== 'X-Amz-Signature')
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey === rightKey) {
          return leftValue.localeCompare(rightValue)
        }

        return leftKey.localeCompare(rightKey)
      })
      .map(([key, value]) => `${encodeCanonicalQueryComponent(key)}=${encodeCanonicalQueryComponent(value)}`)
      .join('&')
    const canonicalRequest = [
      'GET',
      url.pathname,
      canonicalQueryString,
      `host:${url.host}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const expectedSignature = createHmac('sha256', getSigningKey(secretAccessKey, scopeDate, region))
      .update([
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256(canonicalRequest),
      ].join('\n'))
      .digest('hex')

    expect(canonicalQueryString).toContain('response-content-disposition=attachment%3B%20filename%3Dphoto%281%29%21.jpg')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expectedSignature)
  })

  it('RFC3986-encodes reserved filename characters when presigning', () => {
    const accessKeyId = 'AKIASPECIAL'
    const secretAccessKey = 'supersecretreserved'
    const region = 'us-east-1'
    const url = new URL(createS3TemporaryUrl({
      name: 'specialMedia',
      driver: 's3',
      visibility: 'public',
      bucket: 'special-bucket',
      region,
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId,
      secretAccessKey,
      forcePathStyleEndpoint: false,
    }, 'exports/photo (1)!*.jpg', { expiresIn: 120 }))

    const amzDate = url.searchParams.get('X-Amz-Date')!
    const credential = decodeURIComponent(url.searchParams.get('X-Amz-Credential')!)
    const credentialScope = credential.split('/').slice(1).join('/')
    const scopeDate = credentialScope.split('/')[0]!
    const canonicalQueryString = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== 'X-Amz-Signature')
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey === rightKey) {
          return leftValue.localeCompare(rightValue)
        }

        return leftKey.localeCompare(rightKey)
      })
      .map(([key, value]) => `${encodeCanonicalQueryComponent(key)}=${encodeCanonicalQueryComponent(value)}`)
      .join('&')
    const canonicalRequest = [
      'GET',
      encodeCanonicalUri(url.pathname),
      canonicalQueryString,
      `host:${url.host}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const expectedSignature = createHmac('sha256', getSigningKey(secretAccessKey, scopeDate, region))
      .update([
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256(canonicalRequest),
      ].join('\n'))
      .digest('hex')

    expect(url.searchParams.get('X-Amz-Signature')).toBe(expectedSignature)
  })

  it('uses the default expiration when one is not provided', () => {
    const url = createS3TemporaryUrl({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf')

    expect(url).toContain('X-Amz-Expires=300')
  })

  it('rejects invalid presign inputs', () => {
    expect(() => createS3TemporaryUrl({
      name: 'local',
      driver: 'local',
      visibility: 'private',
      root: './storage/app',
    }, 'exports/report.pdf')).toThrow('only supported for s3-compatible disks')

    expect(() => createS3TemporaryUrl({
      name: 'missing',
      driver: 's3',
      visibility: 'private',
      bucket: 'missing-creds',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf')).toThrow('requires accessKeyId')

    expect(() => createS3TemporaryUrl({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf', { expiresAt: 'not-a-date' })).toThrow('requires a valid expiresAt')

    expect(() => createS3TemporaryUrl({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: false,
    }, 'exports/report.pdf', { expiresIn: Number.NaN })).toThrow('requires a finite expiresIn')
  })
})
