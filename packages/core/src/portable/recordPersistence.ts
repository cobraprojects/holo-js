import { normalizeJsonValue, serializeAuthTimestamp } from './authPersistence'

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
  })
}

export function serializeSessionRecordForRow(record: {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
}, driver: string): Record<string, unknown> {
  return {
    id: record.id,
    store: record.store,
    data: JSON.stringify(record.data ?? {}),
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    last_activity_at: serializeAuthTimestamp(record.lastActivityAt, driver),
    expires_at: serializeAuthTimestamp(record.expiresAt, driver),
    invalidated_at: null,
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
}, driver: string): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type ?? null,
    notifiable_type: record.notifiableType,
    notifiable_id: String(record.notifiableId),
    data: JSON.stringify(record.data ?? null),
    read_at: record.readAt ? serializeAuthTimestamp(record.readAt, driver) : null,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    updated_at: serializeAuthTimestamp(record.updatedAt, driver),
  }
}
