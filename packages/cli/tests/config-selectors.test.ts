import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfigDirectory, writeConfigCache } from '@holo-js/config'
import { normalizeModuleOptions } from '@holo-js/storage'
import { afterEach, describe, expect, it } from 'vitest'
import { renderBroadcastConfig } from '../src/project/scaffold/config-renderers'
import { renderScaffoldPackageJson } from '../src/project/scaffold/framework'
import {
  renderAuthConfig,
  renderAuthEnvFiles,
  renderCacheConfig,
  renderMailConfig,
  renderQueueConfig,
  renderQueueEnvFiles,
  renderRedisConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldEnvFiles,
  renderSecurityConfig,
  renderSessionConfig,
  renderStorageConfig,
} from '../src/project/scaffold'

const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-config-selectors-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'))
  return root
}

async function writeConfig(root: string, name: string, source: string, overrides?: string): Promise<void> {
  const rendered = source.replace(/'@holo-js\/([^']+)'/g, (_, packageName: string) =>
    JSON.stringify(resolve(import.meta.dirname, `../../${packageName}/src/index.ts`)))
  if (!overrides) {
    await writeFile(join(root, 'config', `${name}.ts`), rendered)
    return
  }
  await writeFile(join(root, 'config', `${name}.ts`), `${rendered.replace('export default ', 'const config = ')}
export default { ...config, ${overrides} }
`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('generated config selectors', () => {
  it.each([false, true])('normalizes blank optional variables with cached config: %s', async (cached) => {
    const root = await createProject()
    await writeConfig(root, 'storage', renderStorageConfig())
    await writeConfig(root, 'redis', renderRedisConfig())
    await writeConfig(root, 'mail', renderMailConfig())
    const processEnv = {
      STORAGE_DEFAULT_DISK: 's3',
      STORAGE_DISKS_S3_ACCESS_KEY_ID: 'key',
      STORAGE_DISKS_S3_SECRET_ACCESS_KEY: 'secret',
      STORAGE_DISKS_S3_BUCKET: 'media',
      STORAGE_DISKS_S3_REGION: '',
      STORAGE_DISKS_S3_ENDPOINT: '',
      STORAGE_DISKS_S3_URL: '',
      STORAGE_DISKS_PUBLIC_ROOT: '',
      REDIS_URL: '',
      REDIS_USERNAME: '',
      REDIS_PASSWORD: '',
      MAIL_USERNAME: '',
      MAIL_PASSWORD: '',
    }
    if (cached) {
      await writeConfigCache(root, { processEnv })
    }
    const loaded = await loadConfigDirectory(root, { processEnv, preferCache: cached })
    const storage = normalizeModuleOptions(loaded.storage)
    expect(storage.disks.s3).toMatchObject({
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      url: undefined,
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'media',
    })
    expect(storage.disks.public?.root).toBe('./storage/app/public')
    expect(loaded.redis.connections.default).toMatchObject({
      host: '127.0.0.1', port: 6379, username: undefined, password: undefined,
    })
    expect(loaded.redis.connections.default).not.toHaveProperty('url')
    expect(loaded.mail.mailers.smtp).toMatchObject({
      host: '127.0.0.1', port: 1025, user: undefined, password: undefined,
    })
    const configured = await loadConfigDirectory(root, {
      processEnv: {
        ...processEnv,
        STORAGE_DISKS_S3_REGION: 'eu-west-1',
        STORAGE_DISKS_S3_ENDPOINT: 'https://objects.example.com',
        STORAGE_DISKS_S3_URL: 'https://cdn.example.com',
        STORAGE_DISKS_PUBLIC_ROOT: './storage/media',
        REDIS_URL: 'rediss://redis.example.com',
        MAIL_USERNAME: 'mailer',
        MAIL_PASSWORD: 'secret',
      },
      preferCache: cached,
    })
    const configuredStorage = normalizeModuleOptions(configured.storage)
    expect(configuredStorage.disks.s3).toMatchObject({
      region: 'eu-west-1', endpoint: 'https://objects.example.com', url: 'https://cdn.example.com',
    })
    expect(configuredStorage.disks.public?.root).toBe('./storage/media')
    expect(configured.redis.connections.default?.url).toBe('rediss://redis.example.com')
    expect(configured.mail.mailers.smtp).toMatchObject({ user: 'mailer', password: 'secret' })
  })

  it.each(['next', 'nuxt', 'sveltekit'] as const)('includes the S3 driver in a %s storage scaffold', framework => {
    const options = {
      projectName: 'Fixture', framework, databaseDriver: 'sqlite', packageManager: 'bun',
      storageDefaultDisk: 'local', optionalPackages: ['storage'],
    } as const
    const enabled = JSON.parse(renderScaffoldPackageJson(options)) as { dependencies: Record<string, string> }
    expect(enabled.dependencies['@holo-js/storage-s3']).toBe(enabled.dependencies['@holo-js/storage'])
    const disabled = JSON.parse(renderScaffoldPackageJson({ ...options, optionalPackages: [] })) as { dependencies: Record<string, string> }
    expect(disabled.dependencies).not.toHaveProperty('@holo-js/storage-s3')
  })

  it('loads the scaffolded S3 disk from documented storage variables', async () => {
    const root = await createProject()
    await writeConfig(root, 'storage', renderStorageConfig())
    const options = {
      projectName: 'Fixture', databaseDriver: 'sqlite', storageDefaultDisk: 'local',
      optionalPackages: ['storage'],
    } as const
    const files = renderScaffoldEnvFiles(options)
    for (const contents of [files.env, files.example]) {
      await writeFile(join(root, '.env'), contents)
      const defaults = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
      expect(defaults.storage.defaultDisk).toBe('local')
      expect(defaults.storage.disks.s3).toEqual({
        driver: 's3', accessKeyId: '', secretAccessKey: '', region: 'us-east-1',
        bucket: '', url: undefined, endpoint: undefined, forcePathStyleEndpoint: false,
      })
      const configured = await loadConfigDirectory(root, {
        processEnv: {
          STORAGE_DEFAULT_DISK: 's3',
          STORAGE_DISKS_PUBLIC_ROOT: './storage/media',
          STORAGE_DISKS_S3_ACCESS_KEY_ID: 'example-key', STORAGE_DISKS_S3_SECRET_ACCESS_KEY: 'example-secret',
          STORAGE_DISKS_S3_REGION: 'eu-west-1', STORAGE_DISKS_S3_BUCKET: 'media',
          STORAGE_DISKS_S3_URL: 'https://cdn.example.com', STORAGE_DISKS_S3_ENDPOINT: 'https://objects.example.com',
          STORAGE_DISKS_S3_FORCE_PATH_STYLE_ENDPOINT: 'true',
        },
        preferCache: false,
      })
      expect(configured.storage.defaultDisk).toBe('s3')
      expect(configured.storage.disks.public?.root).toBe('./storage/media')
      expect(configured.storage.disks.s3).toEqual({
        driver: 's3', accessKeyId: 'example-key', secretAccessKey: 'example-secret',
        region: 'eu-west-1', bucket: 'media', url: 'https://cdn.example.com',
        endpoint: 'https://objects.example.com', forcePathStyleEndpoint: true,
      })
    }
    const withoutStorage = renderScaffoldEnvFiles({ ...options, optionalPackages: [] })
    expect(withoutStorage.env).not.toContain('STORAGE_')
    expect(withoutStorage.example).not.toContain('STORAGE_')
  })

  it.each(['sync', 'redis', 'database'] as const)('selects a queue connection with the %s installer fallback', async (driver) => {
    const root = await createProject()
    await writeConfig(root, 'redis', renderRedisConfig())
    await writeConfig(root, 'queue', renderQueueConfig({ driver }), `
connections: { ...config.connections, alternate: { driver: 'sync' } },
`)
    const defaults = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
    expect(defaults.queue.default).toBe(driver)
    const overridden = await loadConfigDirectory(root, {
      processEnv: { QUEUE_CONNECTION: 'alternate' }, preferCache: false,
    })
    expect(overridden.queue.default).toBe('alternate')
    expect(renderQueueEnvFiles(driver).env).toContain(`QUEUE_CONNECTION=${driver}`)
    expect(renderQueueEnvFiles(driver).example).toContain('QUEUE_CONNECTION=')
  })

  it.each(['sqlite', 'mysql', 'postgres'] as const)('reads DB_DRIVER and DB_CONNECTION for a %s scaffold', async (databaseDriver) => {
    const root = await createProject()
    await writeConfig(root, 'database', renderScaffoldDatabaseConfig({ databaseDriver, projectName: 'Fixture' }), `
connections: { ...config.connections, alternate: { driver: 'sqlite', url: ':memory:' } },
`)
    const defaults = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
    expect(defaults.database.defaultConnection).toBe('main')
    expect(defaults.database.connections.main).toMatchObject({ driver: databaseDriver })
    const overridden = await loadConfigDirectory(root, {
      processEnv: { DB_DRIVER: 'postgres', DB_CONNECTION: 'alternate' }, preferCache: false,
    })
    expect(overridden.database.defaultConnection).toBe('alternate')
    expect(overridden.database.connections.main).toMatchObject({ driver: 'postgres' })
  })

  it('selects the shared Redis connection and rate-limit driver from the environment', async () => {
    const root = await createProject()
    await writeConfig(root, 'redis', renderRedisConfig(), `
connections: { ...config.connections, alternate: { host: '127.0.0.1', port: 6380 } },
`)
    await writeConfig(root, 'security', renderSecurityConfig())
    await writeConfig(root, 'cache', renderCacheConfig())
    await writeConfig(root, 'queue', renderQueueConfig({ driver: 'redis' }))
    const defaults = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
    expect(defaults.redis.default).toBe('default')
    expect(defaults.security.rateLimit.driver).toBe('file')
    const overridden = await loadConfigDirectory(root, {
      processEnv: { REDIS_CONNECTION: 'alternate', RATE_LIMIT_DRIVER: 'redis' }, preferCache: false,
    })
    expect(overridden.redis.default).toBe('alternate')
    expect(overridden.security.rateLimit.driver).toBe('redis')
    expect(overridden.security.rateLimit.redis.connection).toBe('alternate')
    expect(overridden.cache.drivers.redis).toMatchObject({ connection: 'alternate' })
    expect(overridden.queue.connections.redis).toMatchObject({ connection: 'alternate', redis: { port: 6380 } })
  })

  it.each(['esm', 'cjs'] as const)('selects auth defaults in %s configs', async (format) => {
    const root = await createProject()
    if (format === 'esm') {
      await writeConfig(root, 'auth', renderAuthConfig(), `
guards: { ...config.guards, api: { driver: 'token', provider: 'users' } },
passwords: { ...config.passwords, alternate: { provider: 'users' } },
`)
    } else {
      await writeFile(join(root, 'config/auth.cjs'), `${renderAuthConfig({}, 'cjs')}
module.exports.guards.api = { driver: 'token', provider: 'users' }
module.exports.passwords.alternate = { provider: 'users' }
`)
    }
    const defaults = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
    expect(defaults.auth.defaults).toEqual({ guard: 'web', passwords: 'users' })
    const overridden = await loadConfigDirectory(root, {
      processEnv: { AUTH_GUARD: 'api', AUTH_PASSWORD_BROKER: 'alternate' }, preferCache: false,
    })
    expect(overridden.auth.defaults).toEqual({ guard: 'api', passwords: 'alternate' })
    expect(renderAuthEnvFiles().env).toContain('AUTH_GUARD=web')
    expect(renderAuthEnvFiles().example).toContain('AUTH_PASSWORD_BROKER=')
  })

  it('keeps existing storage, mail, broadcast, and session selectors working', async () => {
    const root = await createProject()
    await writeConfig(root, 'storage', renderStorageConfig())
    await writeConfig(root, 'mail', renderMailConfig())
    await writeConfig(root, 'broadcast', renderBroadcastConfig('esm', false, true))
    await writeConfig(root, 'session', renderSessionConfig())
    const loaded = await loadConfigDirectory(root, {
      processEnv: {
        STORAGE_DEFAULT_DISK: 'public', MAIL_MAILER: 'log',
        BROADCAST_CONNECTION: 'log', SESSION_DRIVER: 'database',
      },
      preferCache: false,
    })
    expect(loaded.storage.defaultDisk).toBe('public')
    expect(loaded.mail.default).toBe('log')
    expect(loaded.broadcast.default).toBe('log')
    expect(loaded.session.driver).toBe('database')
  })

  it('includes selectors in scaffolded env files only for selected packages', () => {
    const options = { projectName: 'Fixture', databaseDriver: 'sqlite', storageDefaultDisk: 'local' } as const
    const base = renderScaffoldEnvFiles(options)
    expect(base.env).toContain('DB_DRIVER=sqlite')
    expect(base.env).toContain('DB_CONNECTION=main')
    expect(base.env).toContain('REDIS_CONNECTION=default')
    expect(base.env).not.toContain('QUEUE_CONNECTION=')
    expect(base.env).not.toContain('RATE_LIMIT_DRIVER=')
    const enabled = renderScaffoldEnvFiles({ ...options, optionalPackages: ['queue', 'security', 'auth'] })
    for (const key of ['QUEUE_CONNECTION', 'RATE_LIMIT_DRIVER', 'AUTH_GUARD', 'AUTH_PASSWORD_BROKER']) {
      expect(enabled.env).toContain(`${key}=`)
      expect(enabled.example).toContain(`${key}=`)
      expect(enabled.env.split('\n').filter(line => line.startsWith(`${key}=`))).toHaveLength(1)
    }
  })
})
