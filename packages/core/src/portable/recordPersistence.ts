import { normalizeJsonValue } from './authPersistence'

export type CoreNotificationJsonPrimitive = string | number | boolean | null
export type CoreNotificationJsonValue
  = CoreNotificationJsonPrimitive
  | readonly CoreNotificationJsonValue[]
  | { readonly [key: string]: CoreNotificationJsonValue }

export interface CoreNotificationRecord<TData extends CoreNotificationJsonValue = CoreNotificationJsonValue> {
  readonly id: string
  readonly type?: string
  readonly notifiableType: string
  readonly notifiableId: string | number
  readonly data: TData
  readonly readAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

function normalizeDateLike(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

export function normalizeSessionRecordFromRow(row: Record<string, unknown>): {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
} {
  const decodedData = (() => {
    if (row.data && typeof row.data === 'object') return row.data as Record<string, unknown>

    if (typeof row.data !== 'string') return {}

    try {
      const parsed = JSON.parse(row.data) as unknown
      return parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  })()

  return Object.freeze({
    id: String(row.id),
    store: typeof row.store === 'string' ? row.store : 'database',
    data: Object.freeze(decodedData),
    createdAt: normalizeDateLike(row.created_at),
    lastActivityAt: normalizeDateLike(row.last_activity_at),
    expiresAt: normalizeDateLike(row.expires_at),
    rememberTokenHash: typeof row.remember_token_hash === 'string' ? row.remember_token_hash : undefined,
  })
}

export function serializeSessionRecordForRow(record: {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
}): Record<string, unknown> {
  return {
    id: record.id,
    store: record.store,
    data: JSON.stringify(record.data ?? {}),
    created_at: record.createdAt.toISOString(),
    last_activity_at: record.lastActivityAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
    invalidated_at: null,
    remember_token_hash: record.rememberTokenHash ?? null,
  }
}

export function normalizeNotificationRecordFromRow(
  row: Record<string, unknown>,
): CoreNotificationRecord<CoreNotificationJsonValue> {
  const decodedData = normalizeJsonValue(row.data)

  return Object.freeze({
    id: String(row.id),
    type: typeof row.type === 'string' ? row.type : undefined,
    notifiableType: String(row.notifiable_type),
    notifiableId: typeof row.notifiable_id === 'number' ? row.notifiable_id : String(row.notifiable_id),
    data: decodedData as CoreNotificationJsonValue,
    readAt: row.read_at ? normalizeDateLike(row.read_at) : null,
    createdAt: normalizeDateLike(row.created_at),
    updatedAt: normalizeDateLike(row.updated_at),
  })
}

export function serializeNotificationRecordForRow(record: {
  readonly id: string
  readonly type?: string
  readonly notifiableType: string
  readonly notifiableId: string | number
  readonly data: unknown
  readonly readAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type ?? null,
    notifiable_type: record.notifiableType,
    notifiable_id: String(record.notifiableId),
    data: JSON.stringify(record.data ?? null),
    read_at: record.readAt ? record.readAt.toISOString() : null,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  }
}
