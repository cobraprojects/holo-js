import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import { afterEach, describe, expect, it } from 'vitest'
import { renderCacheConfig, renderCacheEnvFiles } from '../src/project/scaffold'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('cache scaffold', () => {
  it.each(['file', 'redis', 'database'] as const)('loads the %s default and always includes Redis', async (driver) => {
    const root = await mkdtemp(join(tmpdir(), 'holo-cache-scaffold-'))
    tempDirs.push(root)
    await mkdir(join(root, 'config'))
    const config = renderCacheConfig(driver, 'main')
      .replace("'@holo-js/cache'", JSON.stringify(resolve(import.meta.dirname, '../../cache/src/index.ts')))
      .replace("'@holo-js/config'", JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts')))
    await writeFile(join(root, 'config/cache.ts'), config)
    await writeFile(join(root, 'config/redis.ts'), `export default {
  default: 'shared',
  connections: { shared: { host: '127.0.0.1', port: 6379 } },
}`)

    const loaded = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
    expect(loaded.cache.default).toBe(driver)
    expect(loaded.cache.drivers.redis).toMatchObject({ driver: 'redis', connection: 'shared', prefix: '' })

    const overridden = await loadConfigDirectory(root, {
      processEnv: { CACHE_DRIVER: 'redis', CACHE_PREFIX: 'myapp:cache:' },
      preferCache: false,
    })
    expect(overridden.cache.default).toBe('redis')
    expect(overridden.redis.default).toBe('shared')
    for (const configuredDriver of Object.values(overridden.cache.drivers)) {
      expect(configuredDriver.prefix).toBe('myapp:cache:')
    }

    const envFiles = renderCacheEnvFiles(driver)
    expect(envFiles.env).toContain(`CACHE_DRIVER=${driver}`)
    expect(envFiles.example).toContain(`CACHE_DRIVER=${driver}`)
  })
})
