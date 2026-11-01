import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import { afterEach, describe, expect, it } from 'vitest'
import { renderCacheConfig, renderCacheEnvFiles, renderRedisConfig } from '../src/project/scaffold'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('cache scaffold', () => {
  it('places the scaffolded cache on a dedicated Redis database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-cache-scaffold-'))
    tempDirs.push(root)
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/cache.ts'), renderCacheConfig('redis')
      .replace("'@holo-js/cache'", JSON.stringify(resolve(import.meta.dirname, '../../cache/src/index.ts')))
      .replace("'@holo-js/config'", JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))))
    await writeFile(join(root, 'config/redis.ts'), renderRedisConfig()
      .replace("'@holo-js/config'", JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts')))
      .replace("'@holo-js/kernel'", JSON.stringify(resolve(import.meta.dirname, '../../kernel/src/index.ts'))))

    const loaded = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })

    expect(loaded.cache.drivers.redis).toMatchObject({ driver: 'redis', connection: 'cache' })
    expect(loaded.redis.connections.cache).toMatchObject({ db: 1 })
    expect(loaded.redis.connections.default).toMatchObject({ db: 0 })
  })

  it.each([
    ['file', ['file', 'memory']],
    ['database', ['file', 'memory', 'database']],
    ['redis', ['file', 'memory', 'redis']],
  ] as const)('configures only the stores the %s driver needs', async (driver, expectedStores) => {
    const root = await mkdtemp(join(tmpdir(), 'holo-cache-scaffold-'))
    tempDirs.push(root)
    await mkdir(join(root, 'config'))
    const config = renderCacheConfig(driver, 'main')
      .replace("'@holo-js/cache'", JSON.stringify(resolve(import.meta.dirname, '../../cache/src/index.ts')))
      .replace("'@holo-js/config'", JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts')))
    await writeFile(join(root, 'config/cache.ts'), config)
    await writeFile(join(root, 'config/redis.ts'), `export default {
  default: 'shared',
  connections: { shared: { host: '127.0.0.1', port: 6379 }, cache: { host: '127.0.0.1', port: 6379, db: 1 } },
}`)

    const loaded = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
    expect(loaded.cache.default).toBe(driver)
    expect(Object.keys(loaded.cache.drivers).sort()).toEqual([...expectedStores].sort())

    const overridden = await loadConfigDirectory(root, {
      processEnv: { CACHE_PREFIX: 'myapp:cache:' },
      preferCache: false,
    })
    for (const configuredDriver of Object.values(overridden.cache.drivers)) {
      expect(configuredDriver.prefix).toBe('myapp:cache:')
    }

    const envFiles = renderCacheEnvFiles(driver)
    expect(envFiles.env).toContain(`CACHE_DRIVER=${driver}`)
    expect(envFiles.example).toContain(`CACHE_DRIVER=${driver}`)
  })
})
