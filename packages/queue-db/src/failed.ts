import { randomUUID } from 'node:crypto'
import { DB } from '@holo-js/db'
import type { DatabaseContext } from '@holo-js/db'
import { connectionAsyncContext } from '@holo-js/db'
import { getQueueRuntime, type QueueFailedJobRecord, type QueueFailedJobStore, type QueueReservedJob } from '@holo-js/queue'
import { queueDatabaseInternals, type StoredFailedQueueJobRow } from './database'

function getFailedStoreConfig() {
  return getQueueRuntime().config.failed
}

function resolveDatabaseConnection(name: string): DatabaseContext {
  const active = connectionAsyncContext.getActive()?.connection
  if (active && active.getConnectionName() === name) {
    return active
  }

  return DB.connection(name)
}

async function getFailedStoreConnection(): Promise<{ connection: DatabaseContext, tableName: string } | null> {
  const config = getFailedStoreConfig()
  if (config === false) {
    return null
  }

  const tableName = queueDatabaseInternals.normalizeIdentifierPath(config.table, 'Failed jobs table name')
  const connection = await queueDatabaseInternals.ensureConnectionReady(resolveDatabaseConnection(config.connection))
  return {
    connection,
    tableName,
  }
}

export const queueDbFailedJobStore: QueueFailedJobStore = {
  async persistFailedJob(
    reserved: QueueReservedJob,
    error: Error,
  ): Promise<QueueFailedJobRecord | null> {
    const failedStore = await getFailedStoreConnection()
    if (!failedStore) {
      return null
    }

    const quotedTable = queueDatabaseInternals.quoteIdentifierPath(failedStore.connection.getDialect(), failedStore.tableName)
    const placeholders = queueDatabaseInternals.createPlaceholderList(failedStore.connection.getDialect(), 7)
    const record = Object.freeze({
      id: randomUUID(),
      jobId: reserved.envelope.id,
      job: reserved.envelope,
      exception: error.stack || error.message,
      failedAt: Date.now(),
    })

    await failedStore.connection.executeCompiled({
      sql:
        `INSERT INTO ${quotedTable} (id, job_id, job, connection, queue, payload, exception, failed_at) `
        + `VALUES (${placeholders}, ${failedStore.connection.getDialect().createPlaceholder(8)})`,
      bindings: [
        record.id,
        record.jobId,
        reserved.envelope.name,
        reserved.envelope.connection,
        reserved.envelope.queue,
        queueDatabaseInternals.serializeQueueJson(reserved.envelope),
        record.exception,
        record.failedAt,
      ],
      source: 'queue:failed:insert',
    })

    return record
  },

  async listFailedJobs(): Promise<readonly QueueFailedJobRecord[]> {
    const failedStore = await getFailedStoreConnection()
    if (!failedStore) {
      return Object.freeze([])
    }

    const quotedTable = queueDatabaseInternals.quoteIdentifierPath(failedStore.connection.getDialect(), failedStore.tableName)
    const result = await failedStore.connection.queryCompiled<StoredFailedQueueJobRow>({
      sql: `SELECT id, job_id, payload, exception, failed_at FROM ${quotedTable} ORDER BY failed_at DESC, id DESC`,
      source: 'queue:failed:list',
    })

    return Object.freeze(result.rows.map((row: StoredFailedQueueJobRow) => queueDatabaseInternals.parseStoredFailedQueueJobRow(row)))
  },

  async retryFailedJobs(
    identifier: 'all' | string,
    retry: (record: QueueFailedJobRecord) => Promise<void>,
  ): Promise<number> {
    const failedStore = await getFailedStoreConnection()
    if (!failedStore) {
      return 0
    }

    const quotedTable = queueDatabaseInternals.quoteIdentifierPath(failedStore.connection.getDialect(), failedStore.tableName)
    const dialect = failedStore.connection.getDialect()
    const records = await (identifier === 'all'
      ? await this.listFailedJobs()
      : (() => {
          const placeholder = dialect.createPlaceholder(1)
          return failedStore.connection.queryCompiled<StoredFailedQueueJobRow>({
            sql: `SELECT id, job_id, payload, exception, failed_at FROM ${quotedTable} WHERE id = ${placeholder}`,
            bindings: [identifier],
            source: 'queue:failed:load',
          }).then((result) => Object.freeze(result.rows.map((row: StoredFailedQueueJobRow) => queueDatabaseInternals.parseStoredFailedQueueJobRow(row))))
        })())

    let retried = 0

    for (const record of records) {
      await retry(record)
      const placeholder = dialect.createPlaceholder(1)
      await failedStore.connection.executeCompiled({
        sql: `DELETE FROM ${quotedTable} WHERE id = ${placeholder}`,
        bindings: [record.id],
        source: 'queue:failed:forget-after-retry',
      })
      retried += 1
    }

    return retried
  },

  async forgetFailedJob(id: string): Promise<boolean> {
    const failedStore = await getFailedStoreConnection()
    if (!failedStore) {
      return false
    }

    const quotedTable = queueDatabaseInternals.quoteIdentifierPath(failedStore.connection.getDialect(), failedStore.tableName)
    const placeholder = failedStore.connection.getDialect().createPlaceholder(1)
    const result = await failedStore.connection.executeCompiled({
      sql: `DELETE FROM ${quotedTable} WHERE id = ${placeholder}`,
      bindings: [id],
      source: 'queue:failed:forget',
    })

    return (result.affectedRows ?? 0) > 0
  },

  async flushFailedJobs(): Promise<number> {
    const failedStore = await getFailedStoreConnection()
    if (!failedStore) {
      return 0
    }

    const quotedTable = queueDatabaseInternals.quoteIdentifierPath(failedStore.connection.getDialect(), failedStore.tableName)
    const result = await failedStore.connection.executeCompiled({
      sql: `DELETE FROM ${quotedTable}`,
      source: 'queue:failed:flush',
    })

    return result.affectedRows ?? 0
  },
}

export const queueDbFailedStoreInternals = {
  getFailedStoreConfig,
  getFailedStoreConnection,
}
