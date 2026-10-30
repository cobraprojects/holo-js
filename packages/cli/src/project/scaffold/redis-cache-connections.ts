import { REDIS_CONFIG_ENV_IMPORT, renderRedisCacheConnectionLines, resolveConfigModuleFormat } from './config-renderers'
import type { ConfigModuleFormat } from './types'

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

// Adds the scaffolded "cache" connection to the inline connections object of an existing Redis config. Returns
// why it can't when the file has no single inline connections object to edit.
export function addRedisCacheConnection(source: string, moduleFormat: ConfigModuleFormat): string | { readonly reason: string } {
  const masked = maskNonCode(source)
  const properties = [...masked.matchAll(/\bconnections\s*:/g)]
  const inline = properties.flatMap(match => {
    const open = masked.slice(match.index + match[0].length).search(/\S/) + match.index + match[0].length
    return masked[open] === '{' ? [open] : []
  })
  if (properties.length !== 1 || inline.length !== 1) {
    return { reason: properties.length > 1 ? 'it has more than one connections property' : 'its connections are not written as an inline object' }
  }

  const open = inline[0]!
  let close = open
  for (let depth = 0; close < masked.length; close += 1) {
    if (masked[close] === '{') depth += 1
    else if (masked[close] === '}' && --depth === 0) break
  }
  if (close >= masked.length) return { reason: 'its connections object is not closed' }

  const lastCode = masked.slice(0, close).trimEnd().length - 1
  const separator = lastCode === open || masked[lastCode] === ',' ? '' : ','
  const lineStart = source.lastIndexOf('\n', close) + 1
  const closingIndent = source.slice(lineStart, close)
  const connectionLines = renderRedisCacheConnectionLines(moduleFormat).map(line => line.slice(4))
  let edited: string
  if (/^\s*$/.test(closingIndent) && lineStart > open) {
    const propertyIndent = `${closingIndent}  `
    edited = `${source.slice(0, lastCode + 1)}${separator}${source.slice(lastCode + 1, lineStart)}${connectionLines.map(line => `${propertyIndent}${line}`).join('\n')}\n${source.slice(lineStart)}`
  } else {
    const inlineConnection = `${connectionLines.map(line => line.trim()).join(' ').replace(/, \},$/, ' }')}`
    const rest = source.slice(lastCode + 1)
    edited = `${source.slice(0, lastCode + 1)}${separator} ${inlineConnection}${/^\s/.test(rest) ? '' : ' '}${rest}`
  }

  return moduleFormat === 'esm' && !ESM_ENV_IMPORT_PATTERN.test(source) ? addEnvImport(edited) : edited
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
