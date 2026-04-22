import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  defineCacheConfig,
  loadConfigDirectory,
  normalizeCacheConfig,
} from '../src'

const packageEntry = JSON.stringify(fileURLToPath(new URL('../src/index.ts', import.meta.url)))

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-config-cache-'))
  await mkdir(join(root, 'config'), { recursive: true })
  return root
}

describe('@holo-js/config cache normalization', () => {
  it('defines and normalizes cache config with global and per-driver prefixes', () => {
    const cache = defineCacheConfig({
      default: 'redis',
      prefix: ' app ',
      drivers: {
        file: {
          driver: 'file',
          path: ' ./tmp/cache ',
        },
        memory: {
          driver: 'memory',
          maxEntries: '100',
        },
        redis: {
          driver: 'redis',
          connection: ' cache ',
          prefix: ' redis: ',
        },
        database: {
          driver: 'database',
          connection: ' main ',
          table: ' app_cache ',
          lockTable: ' app_cache_locks ',
        },
      },
    })

    expect(Object.isFrozen(cache)).toBe(true)
    expect(normalizeCacheConfig(cache)).toEqual({
      default: 'redis',
      prefix: 'app',
      drivers: {
        file: {
          name: 'file',
          driver: 'file',
          path: './tmp/cache',
          prefix: 'app',
        },
        memory: {
          name: 'memory',
          driver: 'memory',
          maxEntries: 100,
          prefix: 'app',
        },
        redis: {
          name: 'redis',
          driver: 'redis',
          connection: 'cache',
          prefix: 'redis:',
        },
        database: {
          name: 'database',
          driver: 'database',
          connection: 'main',
          table: 'app_cache',
          lockTable: 'app_cache_locks',
          prefix: 'app',
        },
      },
    })
  })

  it('provides defaults and rejects malformed cache config values', () => {
    expect(normalizeCacheConfig()).toEqual({
      default: 'file',
      prefix: '',
      drivers: {
        file: {
          name: 'file',
          driver: 'file',
          path: './storage/framework/cache/data',
          prefix: '',
        },
        memory: {
          name: 'memory',
          driver: 'memory',
          maxEntries: undefined,
          prefix: '',
        },
      },
    })

    expect(() => normalizeCacheConfig({
      default: 'redis',
      drivers: {
        file: {
          driver: 'file',
        },
      },
    })).toThrow('default cache driver "redis" is not configured')

    expect(() => normalizeCacheConfig({
      drivers: {
        '  ': {
          driver: 'file',
        },
      },
    })).toThrow('Cache driver name must be a non-empty string')

    expect(() => normalizeCacheConfig({
      drivers: {
        memory: {
          driver: 'memory',
          maxEntries: 0,
        },
      },
    })).toThrow('maxEntries must be greater than or equal to 1')

    expect(() => normalizeCacheConfig({
      drivers: {
        weird: {
          driver: 's3' as never,
        },
      },
    })).toThrow('Unsupported cache driver')
  })

  it('inherits omitted cache driver connections from top-level redis and database defaults', () => {
    expect(normalizeCacheConfig({
      default: 'redis',
      drivers: {
        redis: {
          driver: 'redis',
        },
        database: {
          driver: 'database',
        },
      },
    }, {
      redis: {
        default: 'cache',
        connections: {
          cache: {
            name: 'cache',
            host: '127.0.0.1',
            port: 6379,
            db: 0,
          },
        },
      },
      database: {
        defaultConnection: 'primary',
        connections: {
          primary: {
            driver: 'sqlite',
            filename: ':memory:',
          },
        },
      },
    })).toEqual({
      default: 'redis',
      prefix: '',
      drivers: {
        redis: {
          name: 'redis',
          driver: 'redis',
          connection: 'cache',
          prefix: '',
        },
        database: {
          name: 'database',
          driver: 'database',
          connection: 'primary',
          table: 'cache',
          lockTable: 'cache_locks',
          prefix: '',
        },
      },
    })
  })

  it('loads config/cache.ts through the shared loader and keeps it out of custom config', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Cache App',
})
`, 'utf8')

    await writeFile(join(root, 'config/cache.ts'), `
import { defineCacheConfig } from ${packageEntry}

export default defineCacheConfig({
  default: 'memory',
  prefix: 'app',
  drivers: {
    memory: {
      driver: 'memory',
      maxEntries: 50,
    },
  },
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
      preferCache: false,
    })

    expect(loaded.cache).toEqual({
      default: 'memory',
      prefix: 'app',
      drivers: {
        memory: {
          name: 'memory',
          driver: 'memory',
          maxEntries: 50,
          prefix: 'app',
        },
      },
    })
    expect(loaded.custom).toEqual({})
    expect(loaded.all.cache.default).toBe('memory')
  })
})
