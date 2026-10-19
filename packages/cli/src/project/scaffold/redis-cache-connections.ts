import { REDIS_CONFIG_ENV_IMPORT, renderRedisCacheConnectionLines, resolveConfigModuleFormat } from './config-renderers'

const SCAFFOLDED_REDIS_CONNECTIONS = ['default', 'cache'] as const

const ESM_ENV_IMPORT_PATTERN = /import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*['"]@holo-js\/config['"]/

export type RedisConfigSnapshot = {
  readonly path: string
  readonly source: string
  readonly connections: readonly string[]
}

export function resolveRequiredRedisConnections(
  cacheDrivers: Readonly<Record<string, { readonly driver: string, readonly connection?: string }>> | undefined,
): readonly string[] {
  if (!cacheDrivers) {
    return ['cache']
  }

  return [...new Set(Object.values(cacheDrivers).flatMap(entry => (
    entry.driver === 'redis' && entry.connection ? [entry.connection] : []
  )))]
}

export function assertRedisCacheConnectionsAvailable(options: {
  readonly redisConfig: RedisConfigSnapshot | undefined
  readonly requiredConnections: readonly string[]
}): void {
  const available: readonly string[] = options.redisConfig?.connections ?? SCAFFOLDED_REDIS_CONNECTIONS
  const missing = options.requiredConnections.filter(name => !available.includes(name))
  if (missing.length === 0) {
    return
  }

  const redisConfig = options.redisConfig
  const moduleFormat = redisConfig ? resolveConfigModuleFormat(redisConfig.path, redisConfig.source) : 'esm'
  const quotedNames = missing.map(name => `"${name}"`).join(', ')
  const plural = missing.length > 1 ? 's' : ''
  const sections: string[] = [
    redisConfig
      ? `config/redis.ts does not define the ${quotedNames} Redis connection${plural} that the Redis cache store uses.`
      : `config/cache.ts uses the ${quotedNames} Redis connection${plural}, but the scaffolded config/redis.ts only defines "default" and "cache".`,
  ]

  if (missing.includes('cache')) {
    sections.push(
      `The "cache" connection keeps cache flushes on their own Redis database, because a flush deletes that whole database. `
      + `Add this connection to the connections object in config/redis.ts:\n\n${renderRedisCacheConnectionLines(moduleFormat).join('\n')}`,
      'REDIS_CACHE_DB selects the database (default 1). Use a database that holds no queue or session data.',
    )
    if (moduleFormat === 'esm' && redisConfig && !ESM_ENV_IMPORT_PATTERN.test(redisConfig.source)) {
      sections.push(
        `The connection uses env(), so also add this import at the top of config/redis.ts:\n\n${REDIS_CONFIG_ENV_IMPORT}`,
      )
    }
  }

  const otherNames = missing.filter(name => name !== 'cache')
  if (otherNames.length > 0) {
    const otherQuotedNames = otherNames.map(name => `"${name}"`).join(', ')
    sections.push(redisConfig
      ? `Add the ${otherQuotedNames} connection${otherNames.length > 1 ? 's' : ''} to the connections object in config/redis.ts, with the settings for that Redis database.`
      : `Create config/redis.ts with the ${otherQuotedNames} connection${otherNames.length > 1 ? 's' : ''}, or point the Redis cache store at a connection the scaffolded file defines.`)
  }

  sections.push('Then rerun "holo install cache --driver redis".')
  throw new Error(sections.join('\n\n'))
}
