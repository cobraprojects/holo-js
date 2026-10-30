import { REDIS_CONFIG_ENV_IMPORT, renderRedisCacheConnectionLines, resolveConfigModuleFormat } from './config-renderers'
import type { ConfigModuleFormat } from './types'

const SCAFFOLDED_REDIS_CONNECTIONS = ['default', 'cache'] as const

const CONFIG_NAMED_IMPORTS_PATTERN = /import\s*\{([^}]*)\}\s*from\s*(['"])@holo-js\/config\2/g

// True when an import from @holo-js/config binds the local name env, as `env` or `something as env`.
function importsEnvBinding(source: string): boolean {
  return [...source.matchAll(CONFIG_NAMED_IMPORTS_PATTERN)].some(match => match[1]!.split(',')
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

// Replaces comments, strings and template literals with spaces, keeping offsets, so braces and names inside them
// aren't read as code.
function maskNonCode(source: string): string {
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
  const configImport = /import\s*\{([^}]*)\}\s*from\s*(['"])@holo-js\/config\2/.exec(source)
  if (configImport) {
    const names = configImport[1]!.split(',').map(name => name.trim()).filter(Boolean)
    return `${source.slice(0, configImport.index)}import { ${['env', ...names].join(', ')} } from ${configImport[2]}@holo-js/config${configImport[2]}${source.slice(configImport.index + configImport[0].length)}`
  }
  const firstImport = /^import\s/m.exec(maskNonCode(source))
  const at = firstImport?.index ?? 0
  return `${source.slice(0, at)}${REDIS_CONFIG_ENV_IMPORT}\n${firstImport ? '' : '\n'}${source.slice(at)}`
}

// Returns one edited copy of an existing Redis config per inline `connections: { ... }` object, each with the
// scaffolded "cache" connection added to that object, or why there is nothing to edit. Type declarations can also
// have a connections key, so the caller keeps the first copy whose reloaded config resolves the connection.
export function addRedisCacheConnection(source: string, moduleFormat: ConfigModuleFormat): readonly string[] | { readonly reason: string } {
  const masked = maskNonCode(source)
  const inline = [...masked.matchAll(/\bconnections\s*:\s*\{/g)].map(match => match.index + match[0].length - 1)
  if (inline.length === 0) return { reason: 'its connections are not written as an inline object' }

  const edits = inline.flatMap(open => {
    const edited = addConnectionToObject(source, masked, open, moduleFormat)
    return edited === undefined ? [] : [moduleFormat === 'esm' && !importsEnvBinding(source) ? addEnvImport(edited) : edited]
  })
  return edits.length > 0 ? edits : { reason: 'its connections object is not closed' }
}

function addConnectionToObject(source: string, masked: string, open: number, moduleFormat: ConfigModuleFormat): string | undefined {
  let close = open
  for (let depth = 0; close < masked.length; close += 1) {
    if (masked[close] === '{') depth += 1
    else if (masked[close] === '}' && --depth === 0) break
  }
  if (close >= masked.length) return undefined

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

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0.0.0.0', '::'])

function redisHostIdentity(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return LOOPBACK_HOSTS.has(normalized) || /^127\./.test(normalized) ? 'loopback' : normalized
}

// The server a connection reaches, whether it is written as a URL, a socket path, or host and port. Credentials and
// the database path don't change the server. Loopback names count as one host, so the check errs toward a refusal.
function redisServerIdentity(connection: RedisConnectionTarget): string {
  if (connection.url) {
    try {
      const url = new URL(connection.url)
      if (url.protocol === 'unix:' || url.protocol === 'redis+unix:') return `socket:${url.pathname}`
      return `tcp:${redisHostIdentity(url.hostname)}:${url.port || 6379}`
    } catch {
      return `url:${connection.url}`
    }
  }
  if (connection.socketPath) return `socket:${connection.socketPath}`
  return `tcp:${redisHostIdentity(connection.host)}:${connection.port}`
}

// Names the connection that uses the same Redis server and database as the cache connection. A cache flush deletes
// that whole database, so it must not hold another connection's data.
export function findRedisDatabaseShare(connections: Readonly<Record<string, RedisConnectionTarget>>, name = 'cache'): string | undefined {
  const cache = connections[name]
  if (!cache) return undefined
  return Object.entries(connections).find(([other, connection]) => (
    other !== name && redisServerIdentity(connection) === redisServerIdentity(cache) && connection.db === cache.db
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
