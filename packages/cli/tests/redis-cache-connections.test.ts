import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderRedisCacheConnectionLines } from '../src/project/scaffold/config-renderers'
import {
  assertRedisCacheConnectionsAvailable,
  resolveRequiredRedisConnections,
} from '../src/project/scaffold/redis-cache-connections'

const moduleFormats = [
  { extension: 'ts', moduleFormat: 'esm' },
  { extension: 'mts', moduleFormat: 'esm' },
  { extension: 'js', moduleFormat: 'esm' },
  { extension: 'mjs', moduleFormat: 'esm' },
  { extension: 'cts', moduleFormat: 'cjs' },
  { extension: 'cjs', moduleFormat: 'cjs' },
] as const

const envImportLines = {
  esm: "import { env } from '@holo-js/config'",
  cjs: "const { env } = require('@holo-js/config')",
} as const

const combinedEnvImportLines = {
  esm: "import { env, loadConfigDirectory } from '@holo-js/config'",
  cjs: "const { env, loadConfigDirectory } = require('@holo-js/config')",
} as const

function redisSource(moduleFormat: 'esm' | 'cjs', envImport: 'none' | 'alone' | 'combined'): string {
  const envLines = envImport === 'none'
    ? []
    : [envImport === 'alone' ? envImportLines[moduleFormat] : combinedEnvImportLines[moduleFormat]]
  const body = "defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: 6379, db: 0 } } })"
  if (moduleFormat === 'cjs') {
    return [
      "const { defineRedisConfig } = require('@holo-js/kernel')",
      ...envLines,
      '',
      `module.exports = ${body}`,
      '',
    ].join('\n')
  }
  return [
    "import { defineRedisConfig } from '@holo-js/kernel'",
    ...envLines,
    '',
    `export default ${body}`,
    '',
  ].join('\n')
}

function failureOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the check to refuse')
}

describe('redis cache connection check', () => {
  describe.each(moduleFormats)('in a .$extension config', ({ extension, moduleFormat }) => {
    it.each(['none', 'alone', 'combined'] as const)('with env import %s', (envImport) => {
      const source = redisSource(moduleFormat, envImport)
      const path = `/project/config/redis.${extension}`
      const redisConfig = { path, source, connections: ['default'] }
      const required = ['cache']

      const message = failureOf(() => assertRedisCacheConnectionsAvailable({ redisConfig, requiredConnections: required }))
      expect(message).toContain('cache: {')
      if (moduleFormat === 'cjs') {
        expect(message).toContain('db: Number(process.env.REDIS_CACHE_DB || 1),')
        expect(message).not.toContain('env(')
        expect(message).not.toContain('require(')
        expect(message).not.toContain('also add this import')
      } else if (envImport === 'none') {
        expect(message).toContain(envImportLines.esm)
      } else {
        expect(message).not.toContain('also add this import')
      }
    })

    it('accepts a config that defines the cache connection', () => {
      expect(() => assertRedisCacheConnectionsAvailable({
        redisConfig: { path: `/project/config/redis.${extension}`, source: redisSource(moduleFormat, 'alone'), connections: ['default', 'cache'] },
        requiredConnections: ['cache'],
      })).not.toThrow()
    })

    it('names a store connection the config lacks without printing the cache snippet', () => {
      const message = failureOf(() => assertRedisCacheConnectionsAvailable({
        redisConfig: { path: `/project/config/redis.${extension}`, source: redisSource(moduleFormat, 'alone'), connections: ['default', 'cache'] },
        requiredConnections: ['sessions'],
      }))
      expect(message).toContain('"sessions" Redis connection')
      expect(message).toContain('config/redis.ts')
      expect(message).not.toContain('cache: {')
    })
  })

  it('reports a missing store connection when config/redis.ts does not exist', () => {
    const message = failureOf(() => assertRedisCacheConnectionsAvailable({
      redisConfig: undefined,
      requiredConnections: ['sessions'],
    }))
    expect(message).toContain('config/cache.ts uses the "sessions" Redis connection')
    expect(message).toContain('Create config/redis.ts')
    expect(message).not.toContain('cache: {')
  })

  it('passes without a config file when the store uses a connection the scaffold creates', () => {
    expect(() => assertRedisCacheConnectionsAvailable({ redisConfig: undefined, requiredConnections: ['cache'] })).not.toThrow()
    expect(() => assertRedisCacheConnectionsAvailable({ redisConfig: undefined, requiredConnections: ['default', 'cache'] })).not.toThrow()
  })

  it('lists every missing connection once', () => {
    const message = failureOf(() => assertRedisCacheConnectionsAvailable({
      redisConfig: { path: '/project/config/redis.ts', source: redisSource('esm', 'alone'), connections: ['default'] },
      requiredConnections: ['sessions', 'cache', 'queue'],
    }))
    expect(message).toContain('"sessions", "cache", "queue" Redis connections')
    expect(message).toContain('cache: {')
  })

  it('evaluates the CommonJS snippet to the cache connection on database 1 unless REDIS_CACHE_DB says otherwise', () => {
    const cacheConnectionFor = (env: Record<string, string>) => runInNewContext(
      `({ connections: { ${renderRedisCacheConnectionLines('cjs').join('\n')} } })`,
      { process: { env } },
    ).connections.cache
    expect(cacheConnectionFor({})).toEqual({
      url: undefined,
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 1,
    })
    expect(cacheConnectionFor({ REDIS_CACHE_DB: '' }).db).toBe(1)
    expect(cacheConnectionFor({ REDIS_CACHE_DB: '5', REDIS_HOST: 'redis.internal', REDIS_PORT: '6380' })).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      db: 5,
    })
  })

  describe('resolveRequiredRedisConnections', () => {
    it('requires the cache connection when config/cache.ts is being written', () => {
      expect(resolveRequiredRedisConnections(undefined)).toEqual(['cache'])
    })

    it('uses the connection each redis store resolves to, ignoring other drivers, once each', () => {
      expect(resolveRequiredRedisConnections({
        file: { driver: 'file' },
        redis: { driver: 'redis', connection: 'sessions' },
        queue: { driver: 'redis', connection: 'sessions' },
        database: { driver: 'database', connection: 'default' },
        alternate: { driver: 'redis', connection: 'cache' },
      })).toEqual(['sessions', 'cache'])
    })
  })
})
