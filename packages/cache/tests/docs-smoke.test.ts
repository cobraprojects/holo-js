import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

async function readCacheDoc(name: string): Promise<string> {
  return readFile(resolve(root, 'apps/docs/docs/cache', name), 'utf8')
}

describe('cache documentation smoke checks', () => {
  it('covers install flow, drivers, and shared config requirements', async () => {
    const installation = await readFile(resolve(root, 'apps/docs/docs/installation.md'), 'utf8')
    const index = await readCacheDoc('index.md')
    const setup = await readCacheDoc('setup-and-cli.md')
    const config = await readCacheDoc('config-and-drivers.md')

    expect(installation).toContain('cache')
    expect(index).toContain('@holo-js/cache')
    expect(index).toContain('cache.remember(...)')
    expect(index).toContain('query.cache(...)')
    expect(setup).toContain('npx holo install cache')
    expect(setup).toContain('npx holo install cache --driver redis')
    expect(setup).toContain('npx holo install cache --driver database')
    expect(setup).toContain('npx holo cache:table')
    expect(setup).toContain('npx holo cache:clear')
    expect(setup).toContain('npx holo cache:forget dashboard.stats')
    expect(config).toContain("driver: 'memory'")
    expect(config).toContain("driver: 'file'")
    expect(config).toContain("driver: 'redis'")
    expect(config).toContain("driver: 'database'")
    expect(config).toContain("import { defineCacheConfig, env } from '@holo-js/config'")
    expect(config).not.toContain("import { defineCacheConfig, env } from '@holo-js/cache'")
    expect(config).toContain('config/redis.ts')
    expect(config).toContain('@holo-js/cache-redis')
    expect(config).toContain('@holo-js/cache-db')
    expect(config).toContain('CACHE_PREFIX')
  })

  it('covers runtime usage, locking, and query invalidation behavior', async () => {
    const runtime = await readCacheDoc('runtime-and-query-caching.md')
    const commands = await readFile(resolve(root, 'apps/docs/docs/database/commands.md'), 'utf8')

    expect(runtime).toContain('defineCacheKey')
    expect(runtime).toContain('cache.put(reportKey, { total: 42 }, 300)')
    expect(runtime).toContain('cache.add(key, value, ttl)')
    expect(runtime).toContain('cache.put(key, value, ttl)')
    expect(runtime).toContain('cache.remember(')
    expect(runtime).toContain('cache.rememberForever(')
    expect(runtime).toContain('cache.flexible(')
    expect(runtime).toContain('cache.lock(')
    expect(runtime).toContain('.cache(300)')
    expect(runtime).toContain('invalidate: [\'users\', \'db:main:posts\']')
    expect(runtime).toContain('automatic invalidation')
    expect(runtime).toContain('joins')
    expect(runtime).toContain('subquery predicates')
    expect(commands).toContain('npx holo cache:table')
    expect(commands).toContain('npx holo cache:clear')
    expect(commands).toContain('npx holo cache:forget dashboard.stats')
  })
})
