import type { DatabaseContext, Dialect } from '@holo-js/db'
import type {
  QueueFailedJobRecord,
  QueueJobEnvelope,
  QueueJsonValue,
} from '@holo-js/queue'

type StoredQueueJobRow = {
  id: unknown
  job: unknown
  connection: unknown
  queue: unknown
  payload: unknown
  attempts: unknown
  max_attempts: unknown
  available_at?: unknown
  created_at: unknown
}

type StoredFailedQueueJobRow = {
  id: unknown
  job_id: unknown
  payload: unknown
  exception: unknown
  failed_at: unknown
}

type StoredEnvelopeObject = {
  id: unknown
  name: unknown
  connection: unknown
  queue: unknown
  payload: unknown
  attempts: unknown
  maxAttempts: unknown
  availableAt?: unknown
  createdAt: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertQueueJsonValue(
  value: unknown,
  path: string,
  seen = new Set<unknown>(),
): asserts value is QueueJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`[Holo Queue] ${path} must be JSON-serializable.`)
    }

    return
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`[Holo Queue] ${path} must be JSON-serializable.`)
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError(`[Holo Queue] ${path} contains a circular reference.`)
    }

    seen.add(value)
    for (let index = 0; index < value.length; index += 1) {
      assertQueueJsonValue(value[index], `${path}[${index}]`, seen)
    }
    seen.delete(value)
    return
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`[Holo Queue] ${path} must be a plain JSON object, array, or primitive.`)
  }

  if (seen.has(value)) {
    throw new TypeError(`[Holo Queue] ${path} contains a circular reference.`)
  }

  seen.add(value)
  for (const [key, nested] of Object.entries(value)) {
    assertQueueJsonValue(nested, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

function normalizeIdentifierPath(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Queue] ${label} must be a non-empty string.`)
  }

  const segments = normalized.split('.')
  if (segments.some(segment => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) {
    throw new Error(`[Holo Queue] ${label} must contain only valid SQL identifier segments.`)
  }

  return normalized
}

function quoteIdentifierPath(dialect: Dialect, path: string): string {
  return normalizeIdentifierPath(path, 'Queue table name')
    .split('.')
    .map(segment => dialect.quoteIdentifier(segment))
    .join('.')
}

function createPlaceholderList(
  dialect: Dialect,
  count: number,
  startIndex = 1,
): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('[Holo Queue] Placeholder lists require at least one binding.')
  }

  return Array.from({ length: count }, (_, index) => dialect.createPlaceholder(startIndex + index)).join(', ')
}

function coerceRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[Holo Queue] ${label} must be a non-empty string.`)
  }

  return value
}

function coerceRequiredInteger(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`[Holo Queue] ${label} must be an integer.`)
    }

    return value
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }

  throw new Error(`[Holo Queue] ${label} must be an integer.`)
}

function coerceOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === null || typeof value === 'undefined') {
    return undefined
  }

  return coerceRequiredInteger(value, label)
}

function parseStoredPayload(value: unknown, label: string): QueueJsonValue {
  const serialized = coerceRequiredString(value, label)
  const parsed = JSON.parse(serialized) as unknown
  assertQueueJsonValue(parsed, label)
  return parsed
}

function parseStoredQueueJobRow(
  row: StoredQueueJobRow,
): QueueJobEnvelope<QueueJsonValue> {
  return Object.freeze({
    id: coerceRequiredString(row.id, 'Stored queue job id'),
    name: coerceRequiredString(row.job, 'Stored queue job name'),
    connection: coerceRequiredString(row.connection, 'Stored queue job connection'),
    queue: coerceRequiredString(row.queue, 'Stored queue job queue'),
    payload: parseStoredPayload(row.payload, 'Stored queue job payload'),
    attempts: coerceRequiredInteger(row.attempts, 'Stored queue job attempts'),
    maxAttempts: coerceRequiredInteger(row.max_attempts, 'Stored queue job max attempts'),
    ...(typeof row.available_at === 'undefined' || row.available_at === null
      ? {}
      : { availableAt: coerceRequiredInteger(row.available_at, 'Stored queue job availability') }),
    createdAt: coerceRequiredInteger(row.created_at, 'Stored queue job creation time'),
  })
}

function parseStoredQueueEnvelope(
  value: unknown,
): QueueJobEnvelope<QueueJsonValue> {
  if (!isPlainObject(value)) {
    throw new Error('[Holo Queue] Stored queue job payload must serialize a queue job envelope object.')
  }

  const record = value as StoredEnvelopeObject

  return Object.freeze({
    id: coerceRequiredString(record.id, 'Stored queue job id'),
    name: coerceRequiredString(record.name, 'Stored queue job name'),
    connection: coerceRequiredString(record.connection, 'Stored queue job connection'),
    queue: coerceRequiredString(record.queue, 'Stored queue job queue'),
    payload: (() => {
      assertQueueJsonValue(record.payload, 'Stored queue job payload')
      return record.payload
    })(),
    attempts: coerceRequiredInteger(record.attempts, 'Stored queue job attempts'),
    maxAttempts: coerceRequiredInteger(record.maxAttempts, 'Stored queue job max attempts'),
    ...(typeof record.availableAt === 'undefined' || record.availableAt === null
      ? {}
      : { availableAt: coerceRequiredInteger(record.availableAt, 'Stored queue job availability') }),
    createdAt: coerceRequiredInteger(record.createdAt, 'Stored queue job creation time'),
  })
}

function parseStoredFailedQueueJobRow(
  row: StoredFailedQueueJobRow,
): QueueFailedJobRecord {
  return Object.freeze({
    id: coerceRequiredString(row.id, 'Stored failed job id'),
    jobId: coerceRequiredString(row.job_id, 'Stored failed job job id'),
    job: parseStoredQueueEnvelope(parseStoredPayload(row.payload, 'Stored failed job payload')),
    exception: coerceRequiredString(row.exception, 'Stored failed job exception'),
    failedAt: coerceRequiredInteger(row.failed_at, 'Stored failed job timestamp'),
  })
}

function serializeQueueJson(value: unknown): string {
  assertQueueJsonValue(value, 'Queue JSON payload')
  return JSON.stringify(value)
}

async function ensureConnectionReady(connection: DatabaseContext): Promise<DatabaseContext> {
  await connection.initialize()
  return connection
}

export type {
  StoredFailedQueueJobRow,
  StoredQueueJobRow,
}

export const queueDatabaseInternals = {
  assertQueueJsonValue,
  coerceOptionalInteger,
  coerceRequiredInteger,
  coerceRequiredString,
  createPlaceholderList,
  ensureConnectionReady,
  isPlainObject,
  normalizeIdentifierPath,
  parseStoredFailedQueueJobRow,
  parseStoredQueueEnvelope,
  parseStoredPayload,
  parseStoredQueueJobRow,
  quoteIdentifierPath,
  serializeQueueJson,
}
