import { connectionAsyncContext, DB, TableQueryBuilder, type DatabaseContext } from '@holo-js/db'
import { normalizeSessionRecordFromRow, serializeSessionRecordForRow } from './recordPersistence'

const SESSION_FLASH_ENVELOPE_MARKER = 'holo-session-flash-v1'

export interface CoreSessionRecord {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
}

export interface CoreSessionStoreTakeResult {
  readonly found: boolean
  readonly value?: unknown
}

export interface CoreDatabaseSessionAdapter {
  read(sessionId: string): Promise<CoreSessionRecord | null>
  write(record: CoreSessionRecord): Promise<void>
  delete(sessionId: string): Promise<void>
  rotate(previousSessionId: string, record: CoreSessionRecord): Promise<void>
  flash(sessionId: string, key: string, value: unknown): Promise<void>
  take(sessionId: string, key: string): Promise<CoreSessionStoreTakeResult>
}

type StoredSessionData = {
  readonly publicData: Readonly<Record<string, unknown>>
  readonly flashEntries: Map<string, unknown>
}

function parseStoredSessionData(value: unknown): unknown {
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function isStoredSessionEnvelope(
  value: unknown,
): value is readonly [typeof SESSION_FLASH_ENVELOPE_MARKER, Record<string, unknown>, readonly unknown[]] {
  return Array.isArray(value)
    && value.length === 3
    && value[0] === SESSION_FLASH_ENVELOPE_MARKER
    && value[1] !== null
    && typeof value[1] === 'object'
    && !Array.isArray(value[1])
    && Array.isArray(value[2])
}

function splitStoredSessionData(value: unknown): StoredSessionData {
  const decoded = parseStoredSessionData(value)
  const envelope = isStoredSessionEnvelope(decoded) ? decoded : undefined
  const publicData = envelope ? { ...envelope[1] } : {}
  const encodedEntries = envelope?.[2] ?? []
  const flashEntries = new Map<string, unknown>()

  for (const entry of encodedEntries) {
    if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') {
      flashEntries.set(entry[0], entry[1])
    }
  }

  return {
    publicData: Object.freeze(publicData),
    flashEntries,
  }
}

function serializeStoredSessionData(data: StoredSessionData): string {
  return JSON.stringify([
    SESSION_FLASH_ENVELOPE_MARKER,
    data.publicData,
    [...data.flashEntries],
  ])
}

function createSessionQuery(
  transaction: DatabaseContext,
  tableName: string,
  sessionId: string,
  activeOnly: boolean,
): TableQueryBuilder<string> {
  let query = new TableQueryBuilder(tableName, transaction).where('id', sessionId)
  if (activeOnly) query = query.whereNull('invalidated_at')
  return transaction.getCapabilities().lockForUpdate ? query.lockForUpdate() : query
}

function isExpiredSessionRow(row: Record<string, unknown>): boolean {
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))
  return !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()
}

async function inSessionWriteTransaction<TResult>(
  connectionName: string | undefined,
  operation: (transaction: DatabaseContext) => Promise<TResult>,
): Promise<TResult> {
  const active = connectionAsyncContext.getActive()
  if (connectionName === undefined || active?.connection.getConnectionName() === connectionName) return DB.writeTransaction(operation)
  return DB.writeTransaction(operation, connectionName)
}

export function createCoreDatabaseSessionAdapter(tableName: string, connectionName?: string): CoreDatabaseSessionAdapter {
  return Object.freeze({
    async read(sessionId: string): Promise<CoreSessionRecord | null> {
      const row = await DB.table(tableName, connectionName)
        .where('id', sessionId)
        .whereNull('invalidated_at')
        .first<Record<string, unknown>>()
      if (!row) return null

      const stored = splitStoredSessionData(row.data)
      return normalizeSessionRecordFromRow({ ...row, data: stored.publicData })
    },
    async write(record: CoreSessionRecord): Promise<void> {
      await inSessionWriteTransaction(connectionName, async (transaction) => {
        const publicData = Object.freeze({ ...record.data })
        const normalized = serializeSessionRecordForRow({ ...record, data: publicData })
        const existing = await createSessionQuery(transaction, tableName, record.id, false)
          .first<Record<string, unknown>>()
        if (!existing) {
          await new TableQueryBuilder(tableName, transaction).insert({
            ...normalized,
            data: serializeStoredSessionData({
              publicData,
              flashEntries: new Map(),
            }),
          })
          return
        }

        const stored = splitStoredSessionData(existing.data)
        await new TableQueryBuilder(tableName, transaction)
          .where('id', record.id)
          .update({
            ...normalized,
            data: serializeStoredSessionData({
              publicData,
              flashEntries: stored.flashEntries,
            }),
          })
      })
    },
    async delete(sessionId: string): Promise<void> {
      await DB.table(tableName, connectionName)
        .where('id', sessionId)
        .delete()
    },
    async rotate(previousSessionId: string, record: CoreSessionRecord): Promise<void> {
      await inSessionWriteTransaction(connectionName, async (transaction) => {
        const previous = await createSessionQuery(transaction, tableName, previousSessionId, true)
          .first<Record<string, unknown>>()
        if (!previous || isExpiredSessionRow(previous)) {
          if (previous) await new TableQueryBuilder(tableName, transaction).where('id', previousSessionId).delete()
          throw new Error(`[@holo-js/core] Database session "${previousSessionId}" was not found.`)
        }

        const stored = splitStoredSessionData(previous.data)
        const normalized = serializeSessionRecordForRow({
          ...record,
          data: Object.freeze({ ...record.data }),
        })
        const nextData = serializeStoredSessionData({
          publicData: Object.freeze({ ...record.data }),
          flashEntries: stored.flashEntries,
        })
        await new TableQueryBuilder(tableName, transaction)
          .where('id', previousSessionId)
          .update({ ...normalized, data: nextData })
      })
    },
    async flash(sessionId: string, key: string, value: unknown): Promise<void> {
      await inSessionWriteTransaction(connectionName, async (transaction) => {
        const row = await createSessionQuery(transaction, tableName, sessionId, true)
          .first<Record<string, unknown>>()
        if (!row || isExpiredSessionRow(row)) {
          if (row) await new TableQueryBuilder(tableName, transaction).where('id', sessionId).delete()
          throw new Error(`[@holo-js/core] Database session "${sessionId}" was not found.`)
        }

        const stored = splitStoredSessionData(row.data)
        stored.flashEntries.set(key, value)
        await new TableQueryBuilder(tableName, transaction)
          .where('id', sessionId)
          .update({ data: serializeStoredSessionData(stored) })
      })
    },
    async take(sessionId: string, key: string): Promise<CoreSessionStoreTakeResult> {
      return inSessionWriteTransaction(connectionName, async (transaction) => {
        const row = await createSessionQuery(transaction, tableName, sessionId, true)
          .first<Record<string, unknown>>()
        if (!row || isExpiredSessionRow(row)) {
          if (row) await new TableQueryBuilder(tableName, transaction).where('id', sessionId).delete()
          return { found: false }
        }

        const stored = splitStoredSessionData(row.data)
        if (!stored.flashEntries.has(key)) return { found: false }

        const value = stored.flashEntries.get(key)
        stored.flashEntries.delete(key)
        await new TableQueryBuilder(tableName, transaction)
          .where('id', sessionId)
          .update({ data: serializeStoredSessionData(stored) })
        return { found: true, value }
      })
    },
  })
}
