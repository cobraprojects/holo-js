import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyEnvOverrides,
  buildStorageConfig,
  normalizeDiskConfig,
  normalizeModuleOptions,
  normalizeStorageDriver,
  storageInternals,
} from '../src'
import type { DiskConfig } from '../src'

describe('normalizeStorageDriver', () => {
  it('maps local disks', () => {
    expect(normalizeStorageDriver('local')).toBe('local')
    expect(normalizeStorageDriver('public')).toBe('public')
    expect(normalizeStorageDriver('s3')).toBe('s3')
  })
})

describe('applyEnvOverrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('applies string overrides to disk config', () => {
    vi.stubEnv('STORAGE_DISKS_PUBLIC_ROOT', '/srv/storage/public')
    vi.stubEnv('STORAGE_DISKS_PUBLIC_URL', 'https://cdn.example.com')

    const merged = applyEnvOverrides('public', {
      driver: 'public',
      root: './storage/app/public',
    })

    expect(merged.root).toBe('/srv/storage/public')
    expect(merged.url).toBe('https://cdn.example.com')
  })

  it('parses boolean env overrides', () => {
    vi.stubEnv('STORAGE_DISKS_MEDIA_FORCE_PATH_STYLE_ENDPOINT', '1')

    const merged = applyEnvOverrides('media', {
      driver: 's3',
      bucket: 'media',
      region: 'us-east-1',
    })

    expect(merged.forcePathStyleEndpoint).toBe(true)
  })

  it('accepts yes and on boolean env overrides', () => {
    vi.stubEnv('STORAGE_DISKS_MEDIA_FORCE_PATH_STYLE_ENDPOINT', 'yes')
    expect(applyEnvOverrides('media', {
      driver: 's3',
      bucket: 'media',
      region: 'us-east-1',
    }).forcePathStyleEndpoint).toBe(true)

    vi.stubEnv('STORAGE_DISKS_MEDIA_FORCE_PATH_STYLE_ENDPOINT', 'on')
    expect(applyEnvOverrides('media', {
      driver: 's3',
      bucket: 'media',
      region: 'us-east-1',
    }).forcePathStyleEndpoint).toBe(true)
  })
})

describe('normalizeDiskConfig', () => {
  it('builds local/private disk defaults', () => {
    expect(normalizeDiskConfig('local', { driver: 'local' })).toEqual({
      name: 'local',
      driver: 'local',
      visibility: 'private',
      root: './storage/app',
      url: undefined,
    })
  })

  it('preserves explicit local disk urls when provided', () => {
    expect(normalizeDiskConfig('downloads', {
      driver: 'local',
      root: './storage/downloads',
      url: 'https://files.example.com/downloads',
    })).toEqual({
      name: 'downloads',
      driver: 'local',
      visibility: 'private',
      root: './storage/downloads',
      url: 'https://files.example.com/downloads',
    })
  })

  it('builds public disk defaults', () => {
    expect(normalizeDiskConfig('public', { driver: 'public' })).toEqual({
      name: 'public',
      driver: 'public',
      visibility: 'public',
      root: './storage/app/public',
      url: undefined,
    })
  })

  it('rejects local disks marked public', () => {
    expect(() => normalizeDiskConfig('assets', {
      driver: 'local',
      visibility: 'public',
    })).toThrow('Local disks must remain private')
  })

  it('normalizes s3 disks with explicit endpoints', () => {
    expect(normalizeDiskConfig('media', {
      driver: 's3',
      bucket: 'media',
      region: 'auto',
      endpoint: 'https://storage.example.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    })).toEqual({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      url: undefined,
      bucket: 'media',
      region: 'auto',
      endpoint: 'https://storage.example.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: undefined,
      forcePathStyleEndpoint: false,
    })
  })

  it('preserves optional s3 fields when they are provided explicitly', () => {
    expect(normalizeDiskConfig('cdn', {
      driver: 's3',
      bucket: 'cdn-bucket',
      region: 'us-east-1',
      endpoint: 'https://cdn.example.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: 'session-token',
      url: 'https://cdn.example.com/public',
    })).toEqual({
      name: 'cdn',
      driver: 's3',
      visibility: 'private',
      url: 'https://cdn.example.com/public',
      bucket: 'cdn-bucket',
      region: 'us-east-1',
      endpoint: 'https://cdn.example.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: 'session-token',
      forcePathStyleEndpoint: false,
    })
  })

  it('fills in s3 defaults when optional fields are omitted', () => {
    expect(normalizeDiskConfig('archive', {
      driver: 's3',
    })).toEqual({
      name: 'archive',
      driver: 's3',
      visibility: 'private',
      url: undefined,
      bucket: undefined,
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
      forcePathStyleEndpoint: false,
    })
  })
})

describe('buildStorageConfig', () => {
  it('maps local/public disks to fs drivers', () => {
    expect(buildStorageConfig({
      name: 'local',
      driver: 'local',
      visibility: 'private',
      root: './storage/app',
    })).toEqual({
      driver: 'fs',
      base: './storage/app',
    })
  })

  it('falls back to the default root when an fs-style disk root is absent', () => {
    expect(buildStorageConfig({
      name: 'public',
      driver: 'public',
      visibility: 'public',
    })).toEqual({
      driver: 'fs',
      base: './storage/app/public',
    })
  })

  it('maps s3 disks to s3 drivers', () => {
    expect(buildStorageConfig({
      name: 'media',
      driver: 's3',
      visibility: 'private',
      bucket: 'media',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyleEndpoint: true,
    })).toEqual({
      driver: 's3',
      bucket: 'media',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: undefined,
      forcePathStyleEndpoint: true,
    })
  })
})

describe('normalizeModuleOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('provides defaults when no disks are configured', () => {
    const config = normalizeModuleOptions({}, {})

    expect(config.defaultDisk).toBe('local')
    expect(config.diskNames).toEqual(['local', 'public'])
    expect(config.disks.local?.driver).toBe('local')
    expect(config.disks.public?.driver).toBe('public')
  })

  it('merges existing module disks and preserves explicit defaults', () => {
    const existing = {
      defaultDisk: 'assets',
      routePrefix: '/files',
      disks: {
        assets: {
          driver: 'public',
          visibility: 'public',
          root: './storage/assets',
        } satisfies DiskConfig,
      },
    }

    const config = normalizeModuleOptions({}, existing)

    expect(config.defaultDisk).toBe('assets')
    expect(config.routePrefix).toBe('/files')
    expect(config.disks.assets).toEqual({
      name: 'assets',
      driver: 'public',
      visibility: 'public',
      root: './storage/assets',
      url: undefined,
    })
  })

  it('leaves implicit public disk urls dynamic so route prefixes resolve at runtime', () => {
    const config = normalizeModuleOptions({
      routePrefix: '/files',
      disks: {
        assets: {
          driver: 'public',
        },
      },
    }, {})

    expect(config.routePrefix).toBe('/files')
    expect(config.disks.assets).toEqual({
      name: 'assets',
      driver: 'public',
      visibility: 'public',
      root: './storage/app/public',
      url: undefined,
    })
  })

  it('rejects invalid public visibility on local disks during module normalization', () => {
    expect(() => normalizeModuleOptions({
      disks: {
        assets: {
          driver: 'local',
          visibility: 'public',
        },
      },
    }, {})).toThrow('Local disks must remain private')
  })

  it('prefers env and module options when resolving the default disk', () => {
    vi.stubEnv('STORAGE_DEFAULT_DISK', 'media')

    const config = normalizeModuleOptions({
      defaultDisk: 'public',
      disks: {
        media: {
          driver: 's3',
          bucket: 'media',
          region: 'us-east-1',
        },
      },
    }, {
      defaultDisk: 'local',
    })

    expect(config.defaultDisk).toBe('media')
  })

  it('fails when an explicit default disk name is missing', () => {
    expect(() => normalizeModuleOptions({
      defaultDisk: 'missing',
      disks: {
        media: {
          driver: 's3',
          bucket: 'media',
          region: 'us-east-1',
        },
      },
    }, {})).toThrow('default disk "missing" is not configured')
  })

  it('normalizes blank route prefixes back to the storage default', () => {
    const config = normalizeModuleOptions({
      routePrefix: '/',
    }, {})

    expect(config.routePrefix).toBe('/storage')
  })

  it('falls back to the first configured disk when no local disk exists', () => {
    const config = normalizeModuleOptions({
      disks: {
        media: {
          driver: 's3',
          bucket: 'media',
          region: 'us-east-1',
        },
      },
    }, {})

    expect(config.defaultDisk).toBe('media')
  })

  it('covers module merge and nitro application helpers directly', () => {
    expect(storageInternals.normalizeRoutePrefix('files/')).toBe('/files')
    expect(storageInternals.normalizeRoutePrefix(undefined)).toBe('/storage')
    expect(storageInternals.mergeModuleOptions({
      routePrefix: '/files',
      disks: {
        local: {
          driver: 'local',
        },
      },
    }, {
      defaultDisk: 'media',
      disks: {
        media: {
          driver: 's3',
          bucket: 'media',
          region: 'us-east-1',
        },
      },
    })).toEqual({
      defaultDisk: 'media',
      routePrefix: '/files',
      disks: {
        local: {
          driver: 'local',
        },
        media: {
          driver: 's3',
          bucket: 'media',
          region: 'us-east-1',
        },
      },
    })
    expect(storageInternals.mergeModuleOptions({
      defaultDisk: 'local',
      disks: {
        local: {
          driver: 'local',
        },
      },
    }, {})).toEqual({
      defaultDisk: 'local',
      routePrefix: undefined,
      disks: {
        local: {
          driver: 'local',
        },
      },
    })
    expect(storageInternals.mergeModuleOptions(undefined, {})).toEqual({
      defaultDisk: undefined,
      routePrefix: undefined,
      disks: undefined,
    })

    expect(storageInternals.hasPublicLocalDisk({
      defaultDisk: 'local',
      diskNames: ['local'],
      routePrefix: '/storage',
      disks: {
        local: {
          name: 'local',
          driver: 'local',
          visibility: 'private',
        },
      },
    })).toBe(false)
    expect(storageInternals.hasPublicLocalDisk({
      defaultDisk: 'public',
      diskNames: ['public', 'media'],
      routePrefix: '/storage',
      disks: {
        public: {
          name: 'public',
          driver: 'public',
          visibility: 'public',
          root: './storage/app/public',
        },
        media: {
          name: 'media',
          driver: 's3',
          visibility: 'public',
          bucket: 'media',
          region: 'us-east-1',
          endpoint: 'https://s3.us-east-1.amazonaws.com',
        },
      },
    })).toBe(true)

    const opts = {
      nitro: {},
      runtimeConfig: {},
      build: { transpile: [] as string[] },
    } as never
    storageInternals.applyNitroStorageConfig(opts, {
      defaultDisk: 'media',
      diskNames: ['media'],
      routePrefix: '/storage',
      disks: {
        media: {
          name: 'media',
          driver: 's3',
          visibility: 'private',
          bucket: 'media',
          region: 'us-east-1',
          endpoint: 'https://s3.us-east-1.amazonaws.com',
        },
      },
    }, './runtime/drivers/s3')

    expect((opts as { nitro: { storage: Record<string, unknown> } }).nitro.storage).toEqual({
      'holo:media': {
        driver: './runtime/drivers/s3',
        bucket: 'media',
        region: 'us-east-1',
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        accessKeyId: undefined,
        secretAccessKey: undefined,
        sessionToken: undefined,
        forcePathStyleEndpoint: undefined,
      },
    })

    const optsWithExistingNitro = {
      nitro: {
        storage: {},
      },
      runtimeConfig: {},
      build: { transpile: [] as string[] },
    } as never
    storageInternals.applyNitroStorageConfig(optsWithExistingNitro, {
      defaultDisk: 'local',
      diskNames: ['local'],
      routePrefix: '/storage',
      disks: {
        local: {
          name: 'local',
          driver: 'local',
          visibility: 'private',
          root: './storage/app',
        },
      },
    }, './runtime/drivers/s3')

    expect((optsWithExistingNitro as { nitro: { storage: Record<string, unknown> } }).nitro.storage).toEqual({
      'holo:local': {
        driver: 'fs',
        base: './storage/app',
      },
    })
  })
})
