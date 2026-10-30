import { REDIS_CONFIG_ENV_IMPORT, renderRedisCacheConnectionLines, resolveConfigModuleFormat } from './config-renderers'
import type { ConfigModuleFormat } from './types'

const SCAFFOLDED_REDIS_CONNECTIONS = ['default', 'cache'] as const

const CONFIG_NAMED_IMPORTS_PATTERN = /import\s*\{([^}]*)\}\s*from\s*(['"])@holo-js\/config\2/g

function importsEnvBinding(source: string): boolean {
  return [...maskNonCode(source, { keepStrings: true }).matchAll(CONFIG_NAMED_IMPORTS_PATTERN)].some(match => match[1]!.split(',')
    .some(specifier => specifier.trim().split(/\s+as\s+/).at(-1)?.trim() === 'env'))
}

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

function maskNonCode(source: string, options: { readonly keepStrings?: boolean } = {}): string {
  let masked = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    let end = index + 1
    if (char === '/' && next === '/') {
      end = source.indexOf('\n', index)
      if (end < 0) end = source.length
    } else if (char === '/' && next === '*') {
      end = source.indexOf('*/', index + 2)
      end = end < 0 ? source.length : end + 2
    } else if (char === '\'' || char === '"' || char === '`') {
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1
      end = Math.min(end + 1, source.length)
      if (options.keepStrings) {
        masked += source.slice(index, end)
        index = end
        continue
      }
    } else {
      masked += char
      index += 1
      continue
    }
    masked += source.slice(index, end).replace(/[^\n]/g, ' ')
    index = end
  }
  return masked
}

function addEnvImport(source: string): string {
  const configImport = new RegExp(CONFIG_NAMED_IMPORTS_PATTERN.source).exec(maskNonCode(source, { keepStrings: true }))
  if (configImport) {
    const names = configImport[1]!.split(',').map(name => name.trim()).filter(Boolean)
    return `${source.slice(0, configImport.index)}import { ${['env', ...names].join(', ')} } from ${configImport[2]}@holo-js/config${configImport[2]}${source.slice(configImport.index + configImport[0].length)}`
  }
  const firstImport = /^import\s/m.exec(maskNonCode(source))
  const at = firstImport?.index ?? 0
  return `${source.slice(0, at)}${REDIS_CONFIG_ENV_IMPORT}\n${firstImport ? '' : '\n'}${source.slice(at)}`
}

export function addRedisCacheConnection(source: string, moduleFormat: ConfigModuleFormat): readonly string[] | { readonly reason: string } {
  const masked = maskNonCode(source)
  const inline = [...maskNonCode(source, { keepStrings: true }).matchAll(/(?:\bconnections|(['"])connections\1)\s*:\s*\{/g)]
    .map(match => match.index + match[0].length - 1)
    .filter(open => masked[open] === '{')
  if (inline.length === 0) return { reason: 'its connections are not written as an inline object' }

  const needsEnvImport = moduleFormat === 'esm' && !importsEnvBinding(source)
  return inline.map((open) => {
    const edited = addConnectionToObject(source, masked, open, moduleFormat)
    return needsEnvImport ? addEnvImport(edited) : edited
  })
}

function addConnectionToObject(source: string, masked: string, open: number, moduleFormat: ConfigModuleFormat): string {
  let close = open
  for (let depth = 0; close < masked.length; close += 1) {
    if (masked[close] === '{') depth += 1
    else if (masked[close] === '}' && --depth === 0) break
  }

  const lastCode = masked.slice(0, close).trimEnd().length - 1
  const separator = lastCode === open || masked[lastCode] === ',' ? '' : ','
  const lineStart = source.lastIndexOf('\n', close) + 1
  const closingIndent = source.slice(lineStart, close)
  const connectionLines = renderRedisCacheConnectionLines(moduleFormat).map(line => line.slice(4))
  if (/^\s*$/.test(closingIndent) && lineStart > open) {
    const propertyIndent = `${closingIndent}  `
    return `${source.slice(0, lastCode + 1)}${separator}${source.slice(lastCode + 1, lineStart)}${connectionLines.map(line => `${propertyIndent}${line}`).join('\n')}\n${source.slice(lineStart)}`
  }

  const inlineConnection = `${connectionLines.map(line => line.trim()).join(' ').replace(/, \},$/, ' }')}`
  const rest = source.slice(lastCode + 1)
  return `${source.slice(0, lastCode + 1)}${separator} ${inlineConnection}${/^\s/.test(rest) ? '' : ' '}${rest}`
}

type RedisConnectionTarget = { readonly url?: string, readonly socketPath?: string, readonly host: string, readonly port: number, readonly db: number }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])

function redisHostIdentity(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return LOOPBACK_HOSTS.has(normalized) ? 'loopback' : normalized
}

function redisServerIdentity(connection: RedisConnectionTarget): string {
  if (connection.url) {
    const url = new URL(connection.url)
    if (url.protocol === 'unix:' || url.protocol === 'redis+unix:') return `socket:${url.pathname}`
    return `tcp:${redisHostIdentity(url.hostname)}:${url.port || 6379}`
  }
  if (connection.socketPath) return `socket:${connection.socketPath}`
  return `tcp:${redisHostIdentity(connection.host)}:${connection.port}`
}

export function findRedisDatabaseShare(connections: Readonly<Record<string, RedisConnectionTarget>>): string | undefined {
  const cache = connections.cache
  if (!cache) return undefined
  return Object.entries(connections).find(([name, connection]) => (
    name !== 'cache' && redisServerIdentity(connection) === redisServerIdentity(cache) && connection.db === cache.db
  ))?.[0]
}

export function assertRedisCacheConnectionsAvailable(options: {
  readonly redisConfig: RedisConfigSnapshot | undefined
  readonly requiredConnections: readonly string[]
  readonly cannotAddReason?: string
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
    if (options.cannotAddReason) {
      sections.push(`Holo can't add it to config/redis.ts because ${options.cannotAddReason}.`)
    }
    sections.push(
      `The "cache" connection keeps cache flushes on their own Redis database, because a flush deletes that whole database. `
      + `Add this connection to the connections object in config/redis.ts:\n\n${renderRedisCacheConnectionLines(moduleFormat).join('\n')}`,
      'REDIS_CACHE_DB selects the database (default 1). Use a database that holds no queue or session data.',
    )
    if (moduleFormat === 'esm' && redisConfig && !importsEnvBinding(redisConfig.source)) {
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
