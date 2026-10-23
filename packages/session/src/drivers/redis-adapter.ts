import type {
  NormalizedSessionRedisStoreConfig,
} from '../config'
import Redis from 'ioredis'
import type { SessionRecord, SessionStoreSetDataResult, SessionStoreTakeResult } from '../contracts'
import type { SessionRedisDriverAdapter } from './redis'

export interface SessionRedisAdapterOptions {
  readonly now?: () => Date
}

type RedisStandaloneOptions = {
  readonly host?: string
  readonly port?: number
  readonly path?: string
  readonly password?: string
  readonly username?: string
  readonly db?: number
  readonly tls?: Record<string, never>
  readonly lazyConnect: true
  readonly maxRetriesPerRequest: number
}

type RedisClusterOptions = {
  readonly lazyConnect: true
  readonly redisOptions: RedisStandaloneOptions
}

type RedisClusterStartupNode = {
  readonly host: string
  readonly port: number
  readonly tls?: Record<string, never>
}

type RedisClientLike = {
  connect?(): Promise<unknown>
  eval(script: string, numberOfKeys: number, ...args: readonly (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
  quit(): Promise<unknown>
  disconnect(): void
}

const WRITE_SESSION_SCRIPT = `
local nextRecord = ARGV[1]
redis.call('HSET', KEYS[1], 'record', nextRecord)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`

const READ_SESSION_FIELDS_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'record') == 0 then
  return {}
end
return redis.call('HGETALL', KEYS[1])
`

const COPY_SESSION_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'record') == 1 then
  return -1
end
redis.call('HSET', KEYS[1], 'record', ARGV[1])
for index = 3, #ARGV, 2 do
  if ARGV[index] ~= 'record' then
    redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1])
  end
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`

const DELETE_UNCHANGED_SESSION_SCRIPT = `
local current = redis.call('HGETALL', KEYS[1])
if #current == 0 then
  return 0
end
if #current ~= #ARGV then
  return -1
end
local expected = {}
for index = 1, #ARGV, 2 do
  expected[ARGV[index]] = ARGV[index + 1]
end
for index = 1, #current, 2 do
  if expected[current[index]] ~= current[index + 1] then
    return -1
  end
end
redis.call('DEL', KEYS[1])
return 1
`

const READ_SESSION_SCRIPT = `
return redis.call('HGET', KEYS[1], 'record')
`

const FLASH_SESSION_SCRIPT = `
local flashValue = ARGV[2]
if redis.call('HEXISTS', KEYS[1], 'record') == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'flash:' .. ARGV[1], flashValue)
return 1
`

const SET_SESSION_DATA_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'record')
if not current then
  return 0
end
if current ~= ARGV[1] then
  return -1
end
redis.call('HSET', KEYS[1], 'record', ARGV[2])
return 1
`

const SESSION_KEY_NAMESPACE = 'holo:session:'
const SET_SESSION_DATA_ATTEMPTS = 8
const ROTATE_SESSION_ATTEMPTS = 8

const TAKE_SESSION_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'record') == 0 then
  return {0}
end
local flashField = 'flash:' .. ARGV[1]
local value = redis.call('HGET', KEYS[1], flashField)
if not value then
  return {0}
end
redis.call('HDEL', KEYS[1], flashField)
return {1, value}
`

type RedisCtor = typeof Redis & {
  Cluster: new (
    startupNodes: readonly RedisClusterStartupNode[],
    options?: RedisClusterOptions,
  ) => RedisClientLike
}

function isRedisUrlTarget(value: string): boolean {
  return value.startsWith('redis://') || value.startsWith('rediss://')
}

function isRedisSocketConnectionTarget(value: string): boolean {
  return value.startsWith('unix://') || value.startsWith('/')
}

function toRedisSocketPath(value: string): string {
  return value.startsWith('unix://')
    ? value.slice('unix://'.length)
    : value
}

function createStandaloneOptions(config: NormalizedSessionRedisStoreConfig): RedisStandaloneOptions {
  return {
    ...(!isRedisSocketConnectionTarget(config.host)
      ? {
          host: config.host,
          port: config.port,
        }
      : {
          path: toRedisSocketPath(config.host),
        }),
    password: config.password,
    username: config.username,
    db: config.db,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  }
}

function createClusterOptions(config: NormalizedSessionRedisStoreConfig): RedisClusterOptions {
  if (typeof config.db === 'number' && config.db !== 0) {
    throw new Error('[@holo-js/session] Redis Cluster does not support selecting a non-zero database. Remove db or set it to 0.')
  }

  const startupNodes = resolveClusterStartupNodes(config)

  return {
    lazyConnect: true,
    redisOptions: {
      password: config.password,
      username: config.username,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      ...(startupNodes.some(node => typeof node.tls !== 'undefined') ? { tls: {} } : {}),
    },
  }
}

function parseClusterNodeUrl(node: string, label: string): RedisClusterStartupNode {
  try {
    const parsed = new URL(node)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`)
    }

    if (!parsed.hostname) {
      throw new Error('missing hostname')
    }

    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    }
  } catch (error) {
    const message = String(error).replace(/^[A-Z][A-Za-z]*Error: /, '')
    throw new Error(`[@holo-js/session] ${label} is invalid: ${message}`, { cause: error })
  }
}

function resolveClusterStartupNodes(
  config: NormalizedSessionRedisStoreConfig,
): readonly RedisClusterStartupNode[] {
  return (config.clusters ?? []).map((node, index) => {
    const label = `Session Redis store "${config.name}" cluster node ${index + 1}`
    if (typeof node.url === 'string') {
      return parseClusterNodeUrl(node.url, `${label} url`)
    }

    if (isRedisSocketConnectionTarget(node.host)) {
      throw new Error(`[@holo-js/session] ${label} cannot use a Unix socket path in Redis cluster mode.`)
    }

    return {
      host: node.host,
      port: node.port,
    }
  })
}

function createRedisClient(config: NormalizedSessionRedisStoreConfig): RedisClientLike {
  const RedisConstructor = Redis as RedisCtor

  if (typeof config.url === 'string' && isRedisUrlTarget(config.url)) {
    return new RedisConstructor(config.url, {
      password: config.password,
      username: config.username,
      db: config.db,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })
  }

  if (config.clusters && config.clusters.length > 0) {
    return new RedisConstructor.Cluster(
      resolveClusterStartupNodes(config),
      createClusterOptions(config),
    )
  }

  return new RedisConstructor(createStandaloneOptions(config))
}

function serializeSessionRecord(record: SessionRecord): string {
  return JSON.stringify({
    id: record.id,
    store: record.store,
    data: record.data,
    createdAt: record.createdAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  })
}

function deserializeSessionRecord(value: string): SessionRecord | null {
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown
      store?: unknown
      data?: unknown
      createdAt?: unknown
      lastActivityAt?: unknown
      expiresAt?: unknown
    }

    if (
      typeof parsed.id !== 'string'
      || typeof parsed.store !== 'string'
      || typeof parsed.data !== 'object'
      || parsed.data === null
      || Array.isArray(parsed.data)
      || typeof parsed.createdAt !== 'string'
      || typeof parsed.lastActivityAt !== 'string'
      || typeof parsed.expiresAt !== 'string'
    ) {
      return null
    }

    const createdAtMs = Date.parse(parsed.createdAt)
    const lastActivityAtMs = Date.parse(parsed.lastActivityAt)
    const expiresAtMs = Date.parse(parsed.expiresAt)

    if (
      Number.isNaN(createdAtMs)
      || Number.isNaN(lastActivityAtMs)
      || Number.isNaN(expiresAtMs)
    ) {
      return null
    }

    return Object.freeze({
      id: parsed.id,
      store: parsed.store,
      data: Object.freeze({ ...(parsed.data as Record<string, unknown>) }),
      createdAt: new Date(createdAtMs),
      lastActivityAt: new Date(lastActivityAtMs),
      expiresAt: new Date(expiresAtMs),
    })
  } catch {
    return null
  }
}

function serializeFlashValue(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') {
    throw new Error('[@holo-js/session] Redis flash values must be JSON serializable.')
  }
  return encoded
}

function readSessionFields(result: unknown): readonly string[] {
  if (!Array.isArray(result) || result.some(item => typeof item !== 'string')) {
    throw new Error('[@holo-js/session] Redis returned an invalid session record.')
  }
  return result as string[]
}

function deserializeTakeResult(result: unknown): SessionStoreTakeResult {
  if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
    throw new Error('[@holo-js/session] Redis returned an invalid atomic take result.')
  }
  if (result[0] === 0) return { found: false }
  if (typeof result[1] !== 'string') {
    throw new Error('[@holo-js/session] Redis returned an invalid atomic take value.')
  }
  return { found: true, value: JSON.parse(result[1]) as unknown }
}

export class RedisSessionAdapter implements SessionRedisDriverAdapter {
  private readonly client: RedisClientLike
  private readonly prefix: string
  private readonly now: () => Date

  constructor(
    config: NormalizedSessionRedisStoreConfig,
    options: SessionRedisAdapterOptions = {},
  ) {
    this.client = createRedisClient(config)
    this.prefix = config.prefix
    this.now = options.now ?? (() => new Date())
  }

  private qualifyKey(sessionId: string): string {
    return `${this.prefix}${SESSION_KEY_NAMESPACE}${sessionId}`
  }

  async connect(): Promise<void> {
    await this.client.connect?.()
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const encoded = await this.client.eval(READ_SESSION_SCRIPT, 1, this.qualifyKey(sessionId))
    return typeof encoded === 'string' ? deserializeSessionRecord(encoded) : null
  }

  async set(record: SessionRecord): Promise<void> {
    const ttlMs = Math.max(1, record.expiresAt.getTime() - this.now().getTime())
    await this.client.eval(
      WRITE_SESSION_SCRIPT,
      1,
      this.qualifyKey(record.id),
      serializeSessionRecord(record),
      ttlMs,
    )
  }

  async writeIfAbsent(record: SessionRecord): Promise<boolean> {
    const ttlMs = Math.max(1, record.expiresAt.getTime() - this.now().getTime())
    const created = await this.client.eval(COPY_SESSION_SCRIPT, 1, this.qualifyKey(record.id), serializeSessionRecord(record), ttlMs)
    return created === 1
  }

  async del(sessionId: string): Promise<void> {
    await this.client.del(this.qualifyKey(sessionId))
  }

  async rotate(previousSessionId: string, record: SessionRecord): Promise<void> {
    if (previousSessionId === record.id) {
      await this.set(record)
      return
    }
    const previousKey = this.qualifyKey(previousSessionId)
    const nextKey = this.qualifyKey(record.id)
    const ttlMs = Math.max(1, record.expiresAt.getTime() - this.now().getTime())
    const encoded = serializeSessionRecord(record)
    for (let attempt = 0; attempt < ROTATE_SESSION_ATTEMPTS; attempt += 1) {
      const fields = await this.readRotationSource(previousSessionId, previousKey)
      await this.copyRotationTarget(record.id, nextKey, encoded, ttlMs, fields)
      const removed = await this.client.eval(DELETE_UNCHANGED_SESSION_SCRIPT, 1, previousKey, ...fields)
      if (removed === 1) return
      await this.client.del(nextKey)
      if (removed === 0) {
        throw new Error(`[@holo-js/session] Session "${previousSessionId}" was not found.`)
      }
    }
    const fields = await this.readRotationSource(previousSessionId, previousKey)
    await this.copyRotationTarget(record.id, nextKey, encoded, ttlMs, fields)
    await this.client.del(previousKey)
  }

  private async readRotationSource(previousSessionId: string, previousKey: string): Promise<readonly string[]> {
    const fields = readSessionFields(await this.client.eval(READ_SESSION_FIELDS_SCRIPT, 1, previousKey))
    if (fields.length === 0) {
      throw new Error(`[@holo-js/session] Session "${previousSessionId}" was not found.`)
    }
    return fields
  }

  private async copyRotationTarget(
    nextSessionId: string,
    nextKey: string,
    encoded: string,
    ttlMs: number,
    fields: readonly string[],
  ): Promise<void> {
    const copied = await this.client.eval(COPY_SESSION_SCRIPT, 1, nextKey, encoded, ttlMs, ...fields)
    if (copied === -1) {
      throw new Error(`[@holo-js/session] Session "${nextSessionId}" already exists.`)
    }
  }

  async flash(sessionId: string, key: string, value: unknown): Promise<void> {
    const result = await this.client.eval(
      FLASH_SESSION_SCRIPT,
      1,
      this.qualifyKey(sessionId),
      key,
      serializeFlashValue(value),
    )
    if (result !== 1) {
      throw new Error(`[@holo-js/session] Session "${sessionId}" was not found.`)
    }
  }

  async setDataIfAbsent(sessionId: string, key: string, value: unknown): Promise<SessionStoreSetDataResult> {
    const redisKey = this.qualifyKey(sessionId)
    for (let attempt = 0; attempt < SET_SESSION_DATA_ATTEMPTS; attempt += 1) {
      const encoded = await this.client.eval(READ_SESSION_SCRIPT, 1, redisKey)
      if (typeof encoded !== 'string') return { found: false }

      const record = deserializeSessionRecord(encoded)
      if (!record) return { found: false }
      const existing = record.data[key]
      if (Object.hasOwn(record.data, key) && (key !== '_token' || (typeof existing === 'string' && existing))) {
        return { found: true, value: existing }
      }

      const next = serializeSessionRecord({ ...record, data: { ...record.data, [key]: value } })
      const result = await this.client.eval(SET_SESSION_DATA_SCRIPT, 1, redisKey, encoded, next)
      if (result === 1) return { found: true, value }
      if (result === 0) return { found: false }
    }

    throw new Error(`[@holo-js/session] Session "${sessionId}" changed too often to store its data.`)
  }

  async take(sessionId: string, key: string): Promise<SessionStoreTakeResult> {
    return deserializeTakeResult(await this.client.eval(
      TAKE_SESSION_SCRIPT,
      1,
      this.qualifyKey(sessionId),
      key,
    ))
  }

  async close(): Promise<void> {
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect()
    }
  }

  async disconnect(): Promise<void> {
    this.client.disconnect()
  }
}

export function createSessionRedisAdapter(
  config: NormalizedSessionRedisStoreConfig,
  options?: SessionRedisAdapterOptions,
): RedisSessionAdapter {
  return new RedisSessionAdapter(config, options)
}

export const sessionRedisAdapterInternals = {
  createClusterOptions,
  createRedisClient,
  createStandaloneOptions,
  deserializeTakeResult,
  deserializeSessionRecord,
  isRedisSocketConnectionTarget,
  isRedisUrlTarget,
  parseClusterNodeUrl,
  resolveClusterStartupNodes,
  serializeSessionRecord,
  serializeFlashValue,
  toRedisSocketPath,
}
