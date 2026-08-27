import type { HoloConfigMap, LoadedHoloConfig } from '@holo-js/config'
import { DB, type TableQueryBuilder } from '@holo-js/db'
import {
  type CoreNotificationJsonPrimitive,
  type CoreNotificationRecord,
  normalizeNotificationRecordFromRow,
  serializeNotificationRecordForRow,
} from './recordPersistence'

export interface CoreNotificationDatabaseRoute {
  readonly id: string | number
  readonly type: string
}

export interface CoreNotificationDataMatch {
  readonly path: readonly string[]
  readonly value: CoreNotificationJsonPrimitive
}

export interface CoreNotificationQuery {
  readonly id?: string
  readonly recipient: CoreNotificationDatabaseRoute
  readonly type?: string
  readonly dataMatches?: readonly CoreNotificationDataMatch[]
}

export interface CoreNotificationPagination {
  readonly limit: number
  readonly offset: number
}

export interface CoreNotificationPage {
  readonly records: readonly CoreNotificationRecord[]
  readonly limit: number
  readonly offset: number
  readonly total: number
  readonly unread: number
}

export interface CoreNotificationStore {
  create(record: CoreNotificationRecord): Promise<void>
  list(query: CoreNotificationQuery, pagination: CoreNotificationPagination): Promise<CoreNotificationPage>
  unread(query: CoreNotificationQuery, pagination: CoreNotificationPagination): Promise<CoreNotificationPage>
  markAsRead(query: CoreNotificationQuery, ids: readonly string[]): Promise<number>
  markAsUnread(query: CoreNotificationQuery, ids: readonly string[]): Promise<number>
  delete(query: CoreNotificationQuery, ids: readonly string[]): Promise<number>
}

function applyNotificationScope(
  builder: TableQueryBuilder<string>,
  query: CoreNotificationQuery,
): TableQueryBuilder<string> {
  let scoped = builder
    .where('notifiable_type', query.recipient.type)
    .where('notifiable_id', String(query.recipient.id))

  if (query.type !== undefined) {
    scoped = scoped.where('type', query.type)
  }
  if (query.id !== undefined) {
    scoped = scoped.where('id', query.id)
  }

  for (const match of query.dataMatches ?? []) {
    scoped = scoped.whereJson(`data->${match.path.join('->')}`, match.value)
  }

  return scoped
}

export function createCoreNotificationStore<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): CoreNotificationStore {
  const tableName = loadedConfig.notifications.table
  const connectionName = loadedConfig.database.defaultConnection
  const scopedQuery = (query: CoreNotificationQuery): TableQueryBuilder<string> => applyNotificationScope(
    DB.table(tableName, connectionName),
    query,
  )
  const unreadQuery = (query: CoreNotificationQuery): TableQueryBuilder<string> => scopedQuery(query).whereNull('read_at')

  const createPage = async (
    query: CoreNotificationQuery,
    pagination: CoreNotificationPagination,
    onlyUnread: boolean,
  ): Promise<CoreNotificationPage> => {
    const recordsQuery = onlyUnread ? unreadQuery(query) : scopedQuery(query)
    const rowsPromise = recordsQuery
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(pagination.limit)
      .offset(pagination.offset)
      .get<Record<string, unknown>>()
    const unreadPromise = unreadQuery(query).count()
    const [rows, total, unread] = onlyUnread
      ? await Promise.all([
          rowsPromise,
          unreadPromise,
          unreadPromise,
        ])
      : await Promise.all([
          rowsPromise,
          scopedQuery(query).count(),
          unreadPromise,
        ])

    return Object.freeze({
      records: Object.freeze(rows.map(row => normalizeNotificationRecordFromRow(row))),
      limit: pagination.limit,
      offset: pagination.offset,
      total,
      unread,
    })
  }

  return Object.freeze({
    async create(record: CoreNotificationRecord): Promise<void> {
      await DB.table(tableName, connectionName).insertOrIgnore(serializeNotificationRecordForRow(record))
      const persisted = await DB.table(tableName, connectionName).where('id', record.id).first<Record<string, unknown>>()
      if (!persisted) {
        throw new Error('[@holo-js/core] Notification persistence failed closed.')
      }

      const existing = normalizeNotificationRecordFromRow(persisted)
      if (
        existing.notifiableType !== record.notifiableType
        || String(existing.notifiableId) !== String(record.notifiableId)
        || existing.type !== record.type
      ) {
        throw new Error('[@holo-js/core] Notification persistence collision failed closed.')
      }
    },
    async list(query: CoreNotificationQuery, pagination: CoreNotificationPagination): Promise<CoreNotificationPage> {
      return await createPage(query, pagination, false)
    },
    async unread(query: CoreNotificationQuery, pagination: CoreNotificationPagination): Promise<CoreNotificationPage> {
      return await createPage(query, pagination, true)
    },
    async markAsRead(query: CoreNotificationQuery, ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0

      const now = new Date().toISOString()
      const result = await scopedQuery(query)
        .whereIn('id', ids)
        .update({ read_at: now, updated_at: now })

      return result.affectedRows ?? 0
    },
    async markAsUnread(query: CoreNotificationQuery, ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0

      const result = await scopedQuery(query)
        .whereIn('id', ids)
        .update({ read_at: null, updated_at: new Date().toISOString() })

      return result.affectedRows ?? 0
    },
    async delete(query: CoreNotificationQuery, ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0

      const result = await scopedQuery(query)
        .whereIn('id', ids)
        .delete()

      return result.affectedRows ?? 0
    },
  })
}
