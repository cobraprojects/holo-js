import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type * as LoaderModule from '../src/loader'
import {
  clearConfigCache,
  config,
  configureConfigRuntime,
  configureEnvRuntime,
  defineAuthConfig,
  defineConfig,
  defineMediaConfig,
  defineQueueConfig,
  defineSessionConfig,
  defineStorageConfig,
  env,
  isEnvPlaceholder,
  loaderInternals,
  loadConfigDirectory,
  loadEnvironment,
  normalizeAppConfig,
  normalizeAppEnv,
  normalizeAuthConfig,
  normalizeDatabaseConfig,
  normalizeQueueConfigForHolo,
  normalizeSessionConfig,
  resetConfigRuntime,
  resolveConfigCachePath,
  resolveEnvPlaceholders,
  resolveAppEnvironment,
  resolveEnvironmentFileOrder,
  useConfig,
  writeConfigCache,
} from '../src'

const tempDirs: string[] = []
const packageEntry = JSON.stringify(resolve(import.meta.dirname, '../src/index.ts'))

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-config-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  return root
}

afterEach(async () => {
  resetConfigRuntime()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/config', () => {
  it('resolves the documented env file order', () => {
    expect(resolveEnvironmentFileOrder('development')).toEqual(['.env', '.env.development', '.env.local'])
    expect(resolveEnvironmentFileOrder('production')).toEqual(['.env', '.env.production', '.env.prod', '.env.local'])
    expect(resolveEnvironmentFileOrder('test')).toEqual(['.env', '.env.test'])
  })

  it('resolves app environments and normalizes invalid values', () => {
    expect(resolveAppEnvironment({ APP_ENV: 'production' })).toBe('production')
    expect(resolveAppEnvironment({ NODE_ENV: 'test' })).toBe('test')
    expect(resolveAppEnvironment({ APP_ENV: 'staging' })).toBe('development')
    expect(normalizeAppEnv('test', 'development')).toBe('test')
    expect(normalizeAppEnv('staging', 'production')).toBe('production')
  })

  it('normalizes database defaults and freezes media and queue config values', () => {
    expect(normalizeDatabaseConfig().defaultConnection).toBe('default')
    expect(normalizeDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
        },
        archive: {
          driver: 'sqlite',
        },
      },
    }).defaultConnection).toBe('primary')

    expect(normalizeDatabaseConfig({
      defaultConnection: 'archive',
      connections: {
        archive: {
          driver: 'sqlite',
        },
      },
    }).defaultConnection).toBe('archive')

    expect(normalizeDatabaseConfig({
      connections: {
        reporting: {
          driver: 'sqlite',
        },
      },
    }).defaultConnection).toBe('reporting')

    expect(normalizeDatabaseConfig({
      connections: {},
    }).defaultConnection).toBe('default')

    const media = defineMediaConfig({
      conversions: ['thumb'],
    })
    expect(media).toEqual({
      conversions: ['thumb'],
    })
    expect(Object.isFrozen(media)).toBe(true)

    const queue = defineQueueConfig({
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })

    expect(queue).toEqual({
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })
    expect(Object.isFrozen(queue)).toBe(true)
    expect(normalizeQueueConfigForHolo().default).toBe('sync')
    expect(normalizeQueueConfigForHolo({
      failed: false,
    }).failed).toBe(false)
    expect(() => normalizeQueueConfigForHolo({
      failed: {
        driver: 'redis' as never,
      },
    })).toThrow('Unsupported failed job store driver "redis"')
    expect(() => normalizeQueueConfigForHolo({
      default: 'missing',
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })).toThrow('default queue connection "missing" is not configured')

    expect(normalizeQueueConfigForHolo({
      connections: {
        redis: {
          driver: 'redis',
          queue: 'emails',
          retryAfter: '120',
          blockFor: 0,
          redis: {
            host: ' redis.internal ',
            port: '6380',
            db: '4',
          },
        },
        database: {
          driver: 'database',
          connection: 'main',
          table: 'jobs',
          queue: 'reports',
          retryAfter: '30',
          sleep: '2',
        },
      },
    }).connections).toMatchObject({
      redis: {
        driver: 'redis',
        queue: 'emails',
        retryAfter: 120,
        blockFor: 0,
        redis: {
          host: 'redis.internal',
          port: 6380,
          db: 4,
        },
      },
      database: {
        driver: 'database',
        connection: 'main',
        table: 'jobs',
        queue: 'reports',
        retryAfter: 30,
        sleep: 2,
      },
    })
    expect(normalizeQueueConfigForHolo({
      failed: {
        driver: 'database',
      },
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            username: ' worker ',
            password: ' secret ',
          },
        },
      },
    })).toMatchObject({
      failed: {
        connection: 'default',
        table: 'failed_jobs',
      },
      connections: {
        redis: {
          redis: {
            username: 'worker',
            password: 'secret',
          },
        },
      },
    })
    expect(normalizeQueueConfigForHolo({
      failed: {
        driver: 'database',
        connection: '',
        table: '',
      },
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            password: '',
            username: '',
          },
        },
      },
    })).toMatchObject({
      failed: {
        connection: 'default',
        table: 'failed_jobs',
      },
      connections: {
        redis: {
          redis: {
            username: undefined,
            password: undefined,
          },
        },
      },
    })
    expect(normalizeQueueConfigForHolo({
      failed: {
        driver: 'database',
        connection: ' main ',
        table: ' failed_jobs_archive ',
      },
      connections: {
        database: {
          driver: 'database',
        },
      },
    })).toMatchObject({
      failed: {
        connection: 'main',
        table: 'failed_jobs_archive',
      },
      connections: {
        database: {
          connection: 'default',
          table: 'jobs',
        },
      },
    })
    expect(() => normalizeQueueConfigForHolo({
      connections: {
        broken: {
          driver: 'redis',
          retryAfter: 'abc',
        } as never,
      },
    })).toThrow('must be an integer')
    expect(() => normalizeQueueConfigForHolo({
      connections: {
        broken: {
          driver: 'redis',
          blockFor: -1,
        },
      },
    })).toThrow('must be greater than or equal to 0')
    expect(() => normalizeQueueConfigForHolo({
      connections: {
        ' ': {
          driver: 'sync',
        },
      },
    })).toThrow('must be a non-empty string')
    expect(() => normalizeQueueConfigForHolo({
      connections: {
        broken: {
          driver: 'sqs' as never,
        },
      },
    })).toThrow('Unsupported queue driver "sqs"')
  })

  it('normalizes string debug flags in app config', () => {
    expect(normalizeAppConfig({
      debug: 'off' as never,
    }).debug).toBe(false)

    expect(normalizeAppConfig({
      debug: ' definitely ' as never,
    }).debug).toBe(true)
  })

  it('loads first-party and custom config files with layered env overrides', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'APP_NAME=Base App\nDB_URL=./base.sqlite\nMAILGUN_SECRET=base-secret\n', 'utf8')
    await writeFile(join(root, '.env.development'), 'APP_NAME=Dev App\nDB_URL=./dev.sqlite\n', 'utf8')
    await writeFile(join(root, '.env.local'), 'MAILGUN_SECRET=local-secret\nREDIS_HOST=redis.local\nREDIS_PORT=6381\nREDIS_DB=4\nQUEUE_NAME=emails\nQUEUE_RETRY_AFTER=120\nQUEUE_BLOCK_FOR=7\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME'),
  paths: {
    models: 'server/models',
  },
})
`, 'utf8')
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig, env } from ${packageEntry}

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: env('DB_URL'),
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig, env } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: env('MAILGUN_SECRET'),
  },
})
`, 'utf8')
    await writeFile(join(root, 'config/queue.ts'), `
import { defineQueueConfig, env } from ${packageEntry}

export default defineQueueConfig({
  default: 'redis',
  connections: {
    redis: {
      driver: 'redis',
      queue: env('QUEUE_NAME', 'default'),
      retryAfter: env('QUEUE_RETRY_AFTER', 90),
      blockFor: env('QUEUE_BLOCK_FOR', 5),
      redis: {
        host: env('REDIS_HOST', '127.0.0.1'),
        port: env('REDIS_PORT', 6379),
        db: env('REDIS_DB', 0),
      },
    },
  },
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      envName: 'development',
      processEnv: {},
    })

    expect(loaded.app.name).toBe('Dev App')
    expect(loaded.database.connections.default).toMatchObject({
      driver: 'sqlite',
      url: './dev.sqlite',
    })
    expect(loaded.custom).toEqual({
      services: {
        mailgun: {
          secret: 'local-secret',
        },
      },
    })
    expect(loaded.queue).toEqual({
      default: 'redis',
      failed: {
        driver: 'database',
        connection: 'default',
        table: 'failed_jobs',
      },
      connections: {
        redis: {
          name: 'redis',
          driver: 'redis',
          queue: 'emails',
          retryAfter: 120,
          blockFor: 7,
          redis: {
            host: 'redis.local',
            port: 6381,
            password: undefined,
            username: undefined,
            db: 4,
          },
        },
      },
    })
    expect(loaded.environment.loadedFiles.map(file => file.split('/').pop())).toEqual([
      '.env',
      '.env.development',
      '.env.local',
    ])
  })

  it('loads process env overrides even when env files are missing', async () => {
    const root = await createProject()

    const environment = await loadEnvironment({
      cwd: root,
      processEnv: {
        APP_ENV: 'test',
        APP_NAME: 'From Process',
      },
    })

    expect(environment.name).toBe('test')
    expect(environment.loadedFiles).toEqual([])
    expect(environment.values.APP_NAME).toBe('From Process')
  })

  it('restores pre-existing process env entries after loading config files', async () => {
    const root = await createProject()
    const previousAppName = process.env.APP_NAME

    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME', 'Fallback App'),
})
`, 'utf8')

    process.env.APP_NAME = 'Original App Name'

    try {
      const loaded = await loadConfigDirectory(root, {
        processEnv: {
          APP_NAME: 'Loaded App Name',
        },
        preferCache: false,
      })

      expect(loaded.app.name).toBe('Loaded App Name')
      expect(process.env.APP_NAME).toBe('Original App Name')
    } finally {
      if (typeof previousAppName === 'string') {
        process.env.APP_NAME = previousAppName
      } else {
        delete process.env.APP_NAME
      }
    }
  })

  it('prefers .env.production over .env.prod and warns when both exist', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'APP_NAME=Base App\n', 'utf8')
    await writeFile(join(root, '.env.production'), 'APP_NAME=Production App\n', 'utf8')
    await writeFile(join(root, '.env.prod'), 'APP_NAME=Alias App\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME'),
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })

    expect(loaded.app.name).toBe('Production App')
    expect(loaded.warnings[0]).toContain('.env.prod')
  })

  it('provides runtime accessors for file-level and string-path access', async () => {
    const loaded = {
      app: {
        name: 'Holo',
      },
      queue: normalizeQueueConfigForHolo(),
      session: normalizeSessionConfig(),
      auth: normalizeAuthConfig(),
      services: {
        mailgun: {
          secret: 'secret',
        },
      },
    }

    configureConfigRuntime(loaded as never)

    expect(useConfig('app')).toEqual({ name: 'Holo' })
    expect(useConfig('queue.default' as never)).toBe('sync')
    expect(useConfig('session.driver' as never)).toBe('file')
    expect(useConfig('auth.defaults.guard' as never)).toBe('web')
    expect(useConfig('services.mailgun.secret' as never)).toBe('secret')
    expect(config('services.mailgun.secret' as never)).toBe('secret')
  })

  it('defineConfig freezes config values and env falls back to provided default', () => {
    const services = defineConfig({
      mailgun: {
        secret: env('MISSING_MAILGUN_SECRET', 'fallback-secret'),
      },
    })

    expect(services.mailgun.secret).toBe('fallback-secret')
    expect(Object.isFrozen(services)).toBe(true)
  })

  it('defineStorageConfig freezes storage config values', () => {
    const storage = defineStorageConfig({
      disks: {
        public: {
          driver: 'local',
          root: 'storage/app/public',
        },
      },
    })

    expect(storage).toEqual({
      disks: {
        public: {
          driver: 'local',
          root: 'storage/app/public',
        },
      },
    })
    expect(Object.isFrozen(storage)).toBe(true)
  })

  it('resolves env values from runtime state, process env, capture mode, and empty fallbacks', () => {
    configureEnvRuntime({
      RUNTIME_MAILER: 'ses',
      APP_DEBUG: 'false',
      APP_PORT: '4000',
      APP_BAD_PORT: 'not-a-number',
      BOOL_ENABLED: 'yes',
      BOOL_INVALID: 'sometimes',
    })

    expect(env('RUNTIME_MAILER', 'smtp')).toBe('ses')
    expect(env<boolean>('APP_DEBUG', true)).toBe(false)
    expect(env<number>('APP_PORT', 3000)).toBe(4000)
    expect(env<number>('APP_BAD_PORT', 3000)).toBe(3000)
    expect(env<boolean>('BOOL_ENABLED', false)).toBe(true)
    expect(env<boolean>('BOOL_INVALID', true)).toBe(true)

    process.env.PROCESS_MAILER = 'postmark'
    process.env.PROCESS_DEBUG = 'off'
    expect(env('PROCESS_MAILER')).toBe('postmark')
    expect(env<boolean>('PROCESS_DEBUG', true)).toBe(false)
    delete process.env.PROCESS_MAILER
    delete process.env.PROCESS_DEBUG

    expect(env('MISSING_WITH_FALLBACK', 'log')).toBe('log')
    expect(env('MISSING_WITHOUT_FALLBACK')).toBe('')

    configureEnvRuntime(undefined, { mode: 'capture' })
    const captured = env('CAPTURED_MAILER', 'smtp') as unknown
    const capturedBoolean = env<boolean>('CAPTURED_DEBUG', true) as unknown
    const uncaptured = env('CAPTURED_NO_FALLBACK') as unknown

    expect(isEnvPlaceholder(captured)).toBe(true)
    expect(isEnvPlaceholder(capturedBoolean)).toBe(true)
    expect(isEnvPlaceholder(uncaptured)).toBe(true)
    expect(resolveEnvPlaceholders(captured, {})).toBe('smtp')
    expect(resolveEnvPlaceholders(capturedBoolean, { CAPTURED_DEBUG: 'false' })).toBe(false)
    expect(resolveEnvPlaceholders(uncaptured, {})).toBe('')

    configureEnvRuntime(undefined)
  })

  it('returns undefined for missing config paths and throws when the runtime is not configured', () => {
    configureConfigRuntime({
      app: {
        name: 'Holo',
      },
    } as never)

    expect(config('app.missing.value' as never)).toBeUndefined()
    resetConfigRuntime()
    expect(() => useConfig('app' as never)).toThrow('Holo config runtime is not configured.')
  })

  it('captures env placeholders and resolves nested arrays and objects', () => {
    configureEnvRuntime(undefined, { mode: 'capture' })

    const placeholderConfig = {
      mail: {
        primary: env('MAIL_DRIVER', 'smtp'),
        fallbacks: [env('MAIL_FALLBACK', 'log')],
      },
    }

    const resolved = resolveEnvPlaceholders(placeholderConfig, {
      MAIL_DRIVER: 'ses',
    })

    expect(resolved).toEqual({
      mail: {
        primary: 'ses',
        fallbacks: ['log'],
      },
    })

    resetConfigRuntime()
    configureEnvRuntime(undefined)
  })

  it('loads canonical app environments and parses exported env file syntax', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'export APP_NAME=\'Quoted App\'\nAPP_KEY=base64:key\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME'),
  key: env('APP_KEY'),
  env: 'test',
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
    })

    expect(loaded.app.name).toBe('Quoted App')
    expect(loaded.app.key).toBe('base64:key')
    expect(loaded.app.env).toBe('test')
  })

  it('normalizes typed env-backed app values from layered env files', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'APP_ENV=production\nAPP_DEBUG=false\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import type { HoloAppEnv } from ${packageEntry}
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  env: env<HoloAppEnv>('APP_ENV', 'development'),
  debug: env<boolean>('APP_DEBUG', true),
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
    })

    expect(loaded.app.env).toBe('production')
    expect(loaded.app.debug).toBe(false)
  })

  it('parses double-quoted env values', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'APP_NAME="Double Quoted App"\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME'),
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
    })

    expect(loaded.app.name).toBe('Double Quoted App')
  })

  it('loads environment files without an explicit processEnv override', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'APP_NAME=Implicit Process Env\n', 'utf8')

    const loaded = await loadEnvironment({
      cwd: root,
    })

    expect(loaded.values.APP_NAME).toBe('Implicit Process Env')
  })

  it('ignores malformed env lines, unsupported config files, and nested directories during discovery', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env'), 'BROKEN_LINE\nAPP_NAME=Valid App\n', 'utf8')
    await mkdir(join(root, 'config/nested'), { recursive: true })
    await writeFile(join(root, 'config/ignored.json'), '{"ignored":true}', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME', 'Fallback App'),
})
`, 'utf8')
    await writeFile(join(root, 'config/services.ts'), `
export const mailgun = {
  secret: 'from-named-export',
}
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
      preferCache: false,
    })

    expect(loaded.app.name).toBe('Valid App')
    expect(loaded.custom).toEqual({
      services: {
        mailgun: {
          secret: 'from-named-export',
        },
      },
    })
    expect(loaded.loadedFiles.some(file => file.endsWith('ignored.json'))).toBe(false)
    expect(loaded.loadedFiles.some(file => file.includes('/nested/'))).toBe(false)
  })

  it('prefers the highest-priority config extension and supports named config exports', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/services.mjs'), 'export default { mailgun: { secret: "stale" } }', 'utf8')
    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig } from ${packageEntry}

export const config = defineConfig({
  mailgun: {
    secret: 'fresh',
  },
})
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
      preferCache: false,
    })

    expect(loaded.custom).toEqual({
      services: {
        mailgun: {
          secret: 'fresh',
        },
      },
    })
    expect(loaded.loadedFiles.some(file => file.endsWith('services.ts'))).toBe(true)
    expect(loaded.loadedFiles.some(file => file.endsWith('services.mjs'))).toBe(false)
  })

  it('ignores transient config import files during discovery', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Valid App',
})
`, 'utf8')
    await writeFile(join(root, 'config/app.__holo_import_1.ts'), `
throw new Error('transient config imports must not be discovered')
`, 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
      preferCache: false,
    })

    expect(loaded.app.name).toBe('Valid App')
    expect(loaded.loadedFiles.some(file => file.includes('.__holo_import_'))).toBe(false)
  })

  it('supports non-transient config imports and prunes legacy transient files outside Vitest mode', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Non transient app',
})
`, 'utf8')
    await writeFile(join(root, 'config/app.__native_test__.ts'), 'export default { name: "legacy" }', 'utf8')

    const previousVitest = process.env.VITEST
    try {
      delete process.env.VITEST
      const loaderModule = await import(`${pathToFileURL(resolve(import.meta.dirname, '../src/loader.ts')).href}?non-transient=${Date.now()}`) as typeof LoaderModule
      const loaded = await loaderModule.loadConfigDirectory(root, {
        processEnv: {},
        preferCache: false,
      })

      expect(loaded.app.name).toBe('Non transient app')
      await expect(readFile(join(root, 'config/app.__native_test__.ts'), 'utf8')).rejects.toThrow()
    } finally {
      if (typeof previousVitest === 'string') {
        process.env.VITEST = previousVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('treats VITEST=1 as transient import mode when loading config modules', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Transient One App',
})
`, 'utf8')

    const previousVitest = process.env.VITEST
    try {
      process.env.VITEST = '1'
      const loaderModule = await import(`${pathToFileURL(resolve(import.meta.dirname, '../src/loader.ts')).href}?transient-one=${Date.now()}`) as typeof LoaderModule
      const loaded = await loaderModule.loadConfigDirectory(root, {
        processEnv: {},
        preferCache: false,
      })

      expect(loaded.app.name).toBe('Transient One App')
      await expect(readFile(join(root, 'config/app.__holo_import_1.ts'), 'utf8')).rejects.toThrow()
    } finally {
      if (typeof previousVitest === 'string') {
        process.env.VITEST = previousVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('treats non-object config exports as empty config values', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/services.ts'), 'export default 123', 'utf8')

    const loaded = await loadConfigDirectory(root, {
      processEnv: {},
      preferCache: false,
    })

    expect(loaded.custom).toEqual({
      services: {},
    })
    expect(loaderInternals.resolveConfigExport(123)).toEqual({})
    expect(loaderInternals.resolveConfigExport({ mailgun: { secret: 'typed' } })).toEqual({
      mailgun: {
        secret: 'typed',
      },
    })
    expect(loaderInternals.getConfigExtensionPriority('services.custom')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('writes and clears a cache artifact without persisting resolved env values', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env.production'), 'APP_NAME=Production App\nMAILGUN_SECRET=top-secret\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME'),
})
`, 'utf8')
    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig, env } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: env('MAILGUN_SECRET'),
  },
})
`, 'utf8')

    const cachePath = await writeConfigCache(root, {
      envName: 'production',
      processEnv: {},
    })

    expect(cachePath).toBe(resolveConfigCachePath(root))
    const cacheContents = await readFile(cachePath, 'utf8')
    expect(cacheContents).toContain('"__holoEnv": true')
    expect(cacheContents).toContain('"MAILGUN_SECRET"')
    expect(cacheContents).not.toContain('top-secret')

    await writeFile(join(root, 'config/services.ts'), 'export default (() => { throw new Error("live import should not run") })()', 'utf8')

    const loaded = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })

    expect(loaded.app.name).toBe('Production App')
    expect(loaded.custom).toEqual({
      services: {
        mailgun: {
          secret: 'top-secret',
        },
      },
    })

    await expect(clearConfigCache(root)).resolves.toBe(true)
    await expect(clearConfigCache(root)).resolves.toBe(false)
  })

  it('does not rewrite the config cache when the contents are unchanged', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: 'stable-secret',
  },
})
`, 'utf8')

    const cachePath = await writeConfigCache(root, {
      envName: 'development',
      processEnv: {},
    })
    const firstContents = await readFile(cachePath, 'utf8')

    await writeConfigCache(root, {
      envName: 'development',
      processEnv: {},
    })

    const secondContents = await readFile(cachePath, 'utf8')
    expect(secondContents).toBe(firstContents)
  })

  it('falls back to live config when the cache is missing, invalid, or for a different environment', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env.production'), 'APP_NAME=Production App\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME', 'Live App'),
})
`, 'utf8')

    const missingCache = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })
    expect(missingCache.app.name).toBe('Production App')

    await mkdir(dirname(resolveConfigCachePath(root)), { recursive: true })
    await writeFile(resolveConfigCachePath(root), '{ invalid json', 'utf8')
    const invalidCache = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })
    expect(invalidCache.app.name).toBe('Production App')

    await writeFile(resolveConfigCachePath(root), JSON.stringify({
      version: 1,
      environment: {},
      configFiles: [],
      config: {},
    }), 'utf8')
    const invalidShapeCache = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })
    expect(invalidShapeCache.app.name).toBe('Production App')

    await writeConfigCache(root, {
      envName: 'development',
      processEnv: {},
    })
    const mismatchedCache = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })
    expect(mismatchedCache.app.name).toBe('Production App')
  })

  it('rejects non-serializable config values during cache generation', async () => {
    const root = await createProject()

    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  broken: {
    run() {},
  },
})
`, 'utf8')

    await expect(writeConfigCache(root, { processEnv: {} })).rejects.toThrow('JSON-serializable')
  })

  it('caches serializable array config values and resolves production aliases without warnings when canonical file is absent', async () => {
    const root = await createProject()

    await writeFile(join(root, '.env.prod'), 'APP_NAME=Alias Production\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: env('APP_NAME'),
})
`, 'utf8')
    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  transports: ['mailgun', 'ses'],
})
`, 'utf8')

    const cachePath = await writeConfigCache(root, {
      envName: 'production',
      processEnv: {},
    })

    const loaded = await loadConfigDirectory(root, {
      envName: 'production',
      processEnv: {},
    })

    expect(cachePath).toBe(resolveConfigCachePath(root))
    expect(loaded.app.name).toBe('Alias Production')
    expect(loaded.warnings).toEqual([])
    expect(loaded.custom).toEqual({
      services: {
        transports: ['mailgun', 'ses'],
      },
    })
  })

  it('normalizes session and auth defaults and freezes their config helpers', () => {
    const session = defineSessionConfig({
      driver: 'file',
      stores: {
        file: {
          driver: 'file',
          path: ' ./tmp/sessions ',
        },
      },
      cookie: {
        path: '/',
        sameSite: 'strict',
        maxAge: '45',
      },
    })
    expect(Object.isFrozen(session)).toBe(true)
    expect(normalizeSessionConfig().driver).toBe('file')
    expect(normalizeSessionConfig(session)).toMatchObject({
      driver: 'file',
      stores: {
        file: {
          driver: 'file',
          path: './tmp/sessions',
        },
      },
      cookie: {
        path: '/',
        sameSite: 'strict',
        maxAge: 45,
      },
    })
    expect(() => normalizeSessionConfig({
      driver: 'missing',
      stores: {
        file: {
          driver: 'file',
        },
      },
    })).toThrow('default session driver "missing" is not configured')
    expect(() => normalizeSessionConfig({
      cookie: {
        sameSite: 'weird' as never,
      },
    })).toThrow('cookie sameSite')

    const auth = defineAuthConfig({
      defaults: {
        guard: 'admin',
        passwords: 'admins',
      },
      guards: {
        admin: {
          driver: 'session',
          provider: 'admins',
        },
      },
      providers: {
        admins: {
          model: 'Admin',
          identifiers: [' email ', 'phone', 'email'],
        },
      },
      passwords: {
        admins: {
          provider: 'admins',
          table: 'admin_resets',
          expire: '30',
          throttle: '15',
        },
      },
      emailVerification: true,
      socialEncryptionKey: ' phase-6-encryption-key ',
      social: {
        google: {
          clientId: ' google-client ',
          clientSecret: ' google-secret ',
          redirectUri: ' https://app.test/auth/google/callback ',
          scopes: ['openid', 'email'],
          guard: 'admin',
          mapToProvider: 'admins',
          encryptTokens: true,
        },
      },
      workos: {
        dashboard: {
          clientId: ' workos-client ',
          apiKey: ' workos-key ',
          cookiePassword: ' cookie-secret ',
          redirectUri: ' https://app.test/auth/workos/callback ',
          sessionCookie: ' workos-session ',
          guard: 'admin',
          mapToProvider: 'admins',
        },
      },
      clerk: {
        admin: {
          publishableKey: ' pk_test ',
          secretKey: ' sk_test ',
          jwtKey: ' jwt-key ',
          apiUrl: ' https://api.clerk.test ',
          frontendApi: ' https://clerk.test ',
          sessionCookie: ' __clerk_session ',
          authorizedParties: [' https://app.test ', 'https://admin.test'],
          guard: 'admin',
          mapToProvider: 'admins',
        },
      },
    })
    expect(Object.isFrozen(auth)).toBe(true)
    expect(normalizeAuthConfig()).toMatchObject({
      defaults: {
        guard: 'web',
      },
      providers: {
        users: {
          identifiers: ['email'],
        },
      },
    })
    expect(normalizeAuthConfig()).not.toHaveProperty('currentUserEndpoint')
    expect(normalizeAuthConfig(auth)).toMatchObject({
      defaults: {
        guard: 'admin',
      },
      guards: {
        admin: {
          driver: 'session',
          provider: 'admins',
        },
      },
      providers: {
        admins: {
          model: 'Admin',
          identifiers: ['email', 'phone'],
        },
      },
      passwords: {
        admins: {
          provider: 'admins',
          table: 'admin_resets',
          expire: 30,
          throttle: 15,
        },
      },
      emailVerification: {
        required: true,
      },
      socialEncryptionKey: 'phase-6-encryption-key',
      social: {
        google: {
          name: 'google',
          clientId: 'google-client',
          clientSecret: 'google-secret',
          redirectUri: 'https://app.test/auth/google/callback',
          scopes: ['openid', 'email'],
          guard: 'admin',
          mapToProvider: 'admins',
          encryptTokens: true,
        },
      },
      workos: {
        dashboard: {
          name: 'dashboard',
          clientId: 'workos-client',
          apiKey: 'workos-key',
          cookiePassword: 'cookie-secret',
          redirectUri: 'https://app.test/auth/workos/callback',
          sessionCookie: 'workos-session',
          guard: 'admin',
          mapToProvider: 'admins',
        },
      },
      clerk: {
        admin: {
          name: 'admin',
          publishableKey: 'pk_test',
          secretKey: 'sk_test',
          jwtKey: 'jwt-key',
          apiUrl: 'https://api.clerk.test',
          frontendApi: 'https://clerk.test',
          sessionCookie: '__clerk_session',
          authorizedParties: ['https://app.test', 'https://admin.test'],
          guard: 'admin',
          mapToProvider: 'admins',
        },
      },
    })
    expect(() => normalizeAuthConfig({
      defaults: {
        guard: 'missing',
      },
    })).toThrow('default auth guard "missing" is not configured')
    expect(() => normalizeAuthConfig({
      defaults: {
        passwords: 'admins',
      },
    })).toThrow('default password broker "admins" is not configured')
    expect(() => normalizeAuthConfig({
      guards: {
        web: {
          driver: 'session',
          provider: 'users',
        },
      },
      providers: {
        users: {
          model: 'User',
        },
      },
      passwords: {
        users: {
          provider: 'admins',
        },
      },
    })).toThrow('password broker "users" references unknown provider "admins"')
    expect(() => normalizeAuthConfig({
      guards: {
        web: {
          driver: 'session',
          provider: 'admins',
        },
      },
      providers: {
        users: {
          model: 'User',
        },
      },
    })).toThrow('references unknown provider "admins"')
    expect(() => normalizeAuthConfig({
      providers: {
        users: {
          model: '   ',
        },
      },
    })).toThrow('model must be a non-empty string')
    expect(() => normalizeAuthConfig({
      providers: {
        users: {
          model: 'User',
          identifiers: ['   '],
        },
      },
    })).toThrow('identifier entries must be non-empty strings')
    expect(() => normalizeAuthConfig({
      guards: {
        web: {
          driver: 'cookie' as never,
          provider: 'users',
        },
      },
    })).toThrow('Unsupported auth guard driver "cookie"')
    expect(() => normalizeAuthConfig({
      social: {
        google: {
          guard: 'admin',
        },
      },
    })).toThrow('references unknown guard "admin"')
    expect(() => normalizeAuthConfig({
      social: {
        google: {
          mapToProvider: 'admins',
        },
      },
    })).toThrow('references unknown provider "admins"')
    expect(() => normalizeAuthConfig({
      workos: {
        dashboard: {
          guard: 'admin',
        },
      },
    })).toThrow('references unknown guard "admin"')
    expect(() => normalizeAuthConfig({
      workos: {
        dashboard: {
          mapToProvider: 'admins',
        },
      },
    })).toThrow('references unknown provider "admins"')
    expect(() => normalizeAuthConfig({
      clerk: {
        admin: {
          guard: 'admin',
        },
      },
    })).toThrow('references unknown guard "admin"')
    expect(() => normalizeAuthConfig({
      clerk: {
        admin: {
          mapToProvider: 'admins',
        },
      },
    })).toThrow('references unknown provider "admins"')
    expect(() => normalizeAuthConfig({
      providers: {
        admins: {
          model: 'Admin',
        },
      },
    })).toThrow('guard "web" references unknown provider "users"')
    expect(() => normalizeAuthConfig({
      providers: {
        admins: {
          model: 'Admin',
        },
      },
      guards: {
        admin: {
          driver: 'session',
          provider: 'admins',
        },
      },
    })).toThrow('password broker "users" references unknown provider "users"')
    expect(normalizeSessionConfig({
      driver: 'database',
      stores: {
        database: {
          driver: 'database',
          connection: 'audit',
          table: 'custom_sessions',
        },
        file: {
          driver: 'file',
          path: './tmp/sessions',
        },
      },
    })).toMatchObject({
      stores: {
        database: {
          driver: 'database',
          connection: 'audit',
          table: 'custom_sessions',
        },
        file: {
          driver: 'file',
          path: './tmp/sessions',
        },
      },
    })
    expect(() => normalizeSessionConfig({
      stores: {
        cache: {
          driver: 'redis',
          connection: 'cache',
          prefix: 'custom:sessions:',
        },
      },
    })).toThrow('Redis-backed session stores are not supported by the portable runtime yet')
    expect(() => normalizeSessionConfig({
      stores: {
        invalid: {
          driver: 'memory' as never,
        },
      },
    })).toThrow('Unsupported session store driver "memory"')
    expect(normalizeSessionConfig({
      stores: {
        first: {
          driver: 'database',
          connection: 'audit',
          table: 'custom_sessions',
        },
      },
      cookie: {
        name: ' holo_session ',
        path: ' /app ',
        domain: ' example.com ',
        secure: true,
        httpOnly: false,
        sameSite: 'strict',
      },
    })).toMatchObject({
      driver: 'first',
      cookie: {
        name: 'holo_session',
        path: '/app',
        domain: 'example.com',
        secure: true,
        httpOnly: false,
        sameSite: 'strict',
      },
      stores: {
        first: {
          connection: 'audit',
          table: 'custom_sessions',
        },
      },
    })
    expect(normalizeSessionConfig({
      absoluteLifetime: '45',
      stores: {
        first: {
          driver: 'database',
          connection: 'audit',
          table: 'custom_sessions',
        },
      },
    })).toMatchObject({
      absoluteLifetime: 45,
      cookie: {
        maxAge: 45,
      },
    })
    expect(normalizeAuthConfig({
      social: {
        custom: {
          runtime: ' @acme/holo-auth-social-custom ',
        },
      },
    })).toMatchObject({
      social: {
        custom: {
          runtime: '@acme/holo-auth-social-custom',
        },
      },
    })
    expect(normalizeAuthConfig({
      socialEncryptionKey: '  social-secret  ',
      emailVerification: {
        required: true,
      },
      personalAccessTokens: {
        defaultAbilities: ['projects.read'],
      },
      providers: {
        users: {
          model: 'User',
        },
      },
      passwords: {
        users: {
          provider: 'users',
          table: 'password_reset_tokens_custom',
          expire: 90,
          throttle: 5,
        },
      },
      social: {
        google: {
          clientId: ' client-id ',
          clientSecret: ' secret ',
          redirectUri: ' https://example.com/callback ',
          scopes: ['openid'],
        },
      },
      workos: {
        dashboard: {
          clientId: ' client ',
          apiKey: ' api ',
          cookiePassword: ' cookie ',
          redirectUri: ' https://example.com/workos ',
          sessionCookie: ' custom-workos ',
        },
      },
      clerk: {
        app: {
          publishableKey: ' pk ',
          secretKey: ' sk ',
          jwtKey: ' jwt ',
          apiUrl: ' https://api.example.com ',
          frontendApi: ' https://clerk.example.com ',
          sessionCookie: ' custom-clerk ',
        },
      },
    })).toMatchObject({
      socialEncryptionKey: 'social-secret',
      emailVerification: {
        required: true,
      },
      personalAccessTokens: {
        defaultAbilities: ['projects.read'],
      },
      providers: {
        users: {
          model: 'User',
        },
      },
      passwords: {
        users: {
          table: 'password_reset_tokens_custom',
          expire: 90,
          throttle: 5,
        },
      },
      social: {
        google: {
          clientId: 'client-id',
          clientSecret: 'secret',
          redirectUri: 'https://example.com/callback',
          scopes: ['openid'],
        },
      },
      workos: {
        dashboard: {
          clientId: 'client',
          apiKey: 'api',
          cookiePassword: 'cookie',
          redirectUri: 'https://example.com/workos',
          sessionCookie: 'custom-workos',
        },
      },
      clerk: {
        app: {
          publishableKey: 'pk',
          secretKey: 'sk',
          jwtKey: 'jwt',
          apiUrl: 'https://api.example.com',
          frontendApi: 'https://clerk.example.com',
          sessionCookie: 'custom-clerk',
        },
      },
    })
    expect(normalizeAuthConfig({
      social: {
        google: {},
      },
      workos: {
        dashboard: {},
      },
      clerk: {
        app: {},
      },
    })).toMatchObject({
      socialEncryptionKey: undefined,
      social: {
        google: {
          runtime: undefined,
          clientId: undefined,
          clientSecret: undefined,
          redirectUri: undefined,
          scopes: [],
        },
      },
      workos: {
        dashboard: {
          clientId: undefined,
          apiKey: undefined,
          cookiePassword: undefined,
          redirectUri: undefined,
          sessionCookie: 'wos-session',
        },
      },
      clerk: {
        app: {
          publishableKey: undefined,
          secretKey: undefined,
          jwtKey: undefined,
          apiUrl: undefined,
          frontendApi: undefined,
          sessionCookie: '__session',
          authorizedParties: [],
        },
      },
    })
  })

  it('refreshes the config cache when config source files change', async () => {
    const root = await createProject()
    const servicesPath = join(root, 'config/services.ts')

    await writeFile(servicesPath, `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: 'first-secret',
  },
})
`, 'utf8')

    await writeConfigCache(root, {
      envName: 'development',
      processEnv: {},
    })

    await writeFile(servicesPath, `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: 'second-secret',
  },
})
`, 'utf8')

    await writeConfigCache(root, {
      envName: 'development',
      processEnv: {},
    })

    const loaded = await loadConfigDirectory(root, {
      envName: 'development',
      processEnv: {},
      preferCache: true,
    })

    expect(loaded.custom).toEqual({
      services: {
        mailgun: {
          secret: 'second-secret',
        },
      },
    })
  })

  it('reloads config source files directly in development without relying on the cache artifact', async () => {
    const root = await createProject()
    const servicesPath = join(root, 'config/services.ts')

    await writeFile(servicesPath, `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: 'first-secret',
  },
})
`, 'utf8')

    const first = await loadConfigDirectory(root, {
      envName: 'development',
      processEnv: {},
      preferCache: false,
    })

    expect(first.custom).toEqual({
      services: {
        mailgun: {
          secret: 'first-secret',
        },
      },
    })

    await writeFile(servicesPath, `
import { defineConfig } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: 'second-secret',
  },
})
`, 'utf8')

    const second = await loadConfigDirectory(root, {
      envName: 'development',
      processEnv: {},
      preferCache: false,
    })

    expect(second.custom).toEqual({
      services: {
        mailgun: {
          secret: 'second-secret',
        },
      },
    })
  })
})
