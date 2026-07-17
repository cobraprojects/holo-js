import type { HoloConfigMap, LoadedHoloConfig } from '@holo-js/config'
import { DB } from '@holo-js/db'
import {
  type CoreNotificationRecord,
  normalizeNotificationRecordFromRow,
  serializeNotificationRecordForRow,
} from './recordPersistence'

export interface CoreNotificationDatabaseRoute {
  readonly id: string | number
  readonly type: string
}

export interface CoreNotificationStore {
  create(record: CoreNotificationRecord): Promise<void>
  list(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]>
  unread(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]>
  markAsRead(ids: readonly string[]): Promise<number>
  markAsUnread(ids: readonly string[]): Promise<number>
  delete(ids: readonly string[]): Promise<number>
}

export function createCoreNotificationStore<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): CoreNotificationStore {
  const tableName = loadedConfig.notifications.table
  const connectionName = loadedConfig.database.defaultConnection

  return Object.freeze({
    async create(record: CoreNotificationRecord): Promise<void> {
      await DB.table(tableName, connectionName).insert(serializeNotificationRecordForRow(record))
    },
    async list(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]> {
      const rows = await DB.table(tableName, connectionName)
        .where('notifiable_type', notifiable.type)
        .where('notifiable_id', String(notifiable.id))
        .orderBy('created_at', 'desc')
        .get<Record<string, unknown>>()

      return Object.freeze(rows.map(row => normalizeNotificationRecordFromRow(row)))
    },
    async unread(notifiable: CoreNotificationDatabaseRoute): Promise<readonly CoreNotificationRecord[]> {
      const rows = await DB.table(tableName, connectionName)
        .where('notifiable_type', notifiable.type)
        .where('notifiable_id', String(notifiable.id))
        .whereNull('read_at')
        .orderBy('created_at', 'desc')
        .get<Record<string, unknown>>()

      return Object.freeze(rows.map(row => normalizeNotificationRecordFromRow(row)))
    },
    async markAsRead(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0

      const now = new Date().toISOString()
      const result = await DB.table(tableName, connectionName)
        .whereIn('id', ids)
        .update({ read_at: now, updated_at: now })

      return result.affectedRows ?? 0
    },
    async markAsUnread(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0

      const result = await DB.table(tableName, connectionName)
        .whereIn('id', ids)
        .update({ read_at: null, updated_at: new Date().toISOString() })

      return result.affectedRows ?? 0
    },
    async delete(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0

      const result = await DB.table(tableName, connectionName)
        .whereIn('id', ids)
        .delete()

      return result.affectedRows ?? 0
    },
  })
}
