import { randomUUID } from 'node:crypto'
import { DB } from '@holo-js/db'
import type { DatabaseContext } from '@holo-js/db'
import { connectionAsyncContext } from '@holo-js/db'
import type {
  NormalizedQueueDatabaseConnectionConfig,
  QueueAsyncDriver,
  QueueDriverDispatchResult,
  QueueDriverFactory,
  QueueDriverFactoryContext,
  QueueJobEnvelope,
  QueueJsonValue,
  QueueReleaseOptions,
  QueueReservedJob,
} from '@holo-js/queue'
import { queueDatabaseInternals } from '../database'

type DatabaseQueuedJobRow = {
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

function normalizeDatabaseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export class DatabaseQueueDriverError extends Error {
  constructor(
    connectionName: string,
    action: string,
    cause: unknown,
  ) {
    super(
      `[Holo Queue] Database queue connection "${connectionName}" failed to ${action}: ${normalizeDatabaseErrorMessage(cause)}`,
      { cause },
    )
    this.name = 'DatabaseQueueDriverError'
  }
}

function wrapDatabaseError(
  connectionName: string,
  action: string,
  error: unknown,
): DatabaseQueueDriverError {
  if (error instanceof DatabaseQueueDriverError) {
    return error
  }

  return new DatabaseQueueDriverError(connectionName, action, error)
}

function normalizeQueueNames(
  queueNames: readonly string[] | undefined,
  fallbackQueueName: string,
): readonly string[] {
  if (!queueNames || queueNames.length === 0) {
    return Object.freeze([fallbackQueueName])
  }

  const normalized = [...new Set(queueNames.map(name => name.trim()).filter(Boolean))]
  return Object.freeze(normalized.length > 0 ? normalized : [fallbackQueueName])
}

function createPlaceholders(
  connection: DatabaseContext,
  count: number,
  startIndex = 1,
): readonly string[] {
  return queueDatabaseInternals.createPlaceholderList(connection.getDialect(), count, startIndex).split(', ')
}

function resolveDatabaseConnection(name: string): DatabaseContext {
  const active = connectionAsyncContext.getActive()?.connection
  if (active && active.getConnectionName() === name) {
    return active
  }

  return DB.connection(name)
}

export class DatabaseQueueDriver implements QueueAsyncDriver {
  readonly name: string
  readonly driver = 'database' as const
  readonly mode = 'async' as const

  private readonly tableName: string

  constructor(
    private readonly connection: NormalizedQueueDatabaseConnectionConfig,
    private readonly context: QueueDriverFactoryContext,
  ) {
    this.name = connection.name
    this.tableName = queueDatabaseInternals.normalizeIdentifierPath(connection.table, 'Queue table name')
  }

  private async getConnection(): Promise<DatabaseContext> {
    return queueDatabaseInternals.ensureConnectionReady(resolveDatabaseConnection(this.connection.connection))
  }

  private getQuotedTable(connection: DatabaseContext): string {
    return queueDatabaseInternals.quoteIdentifierPath(connection.getDialect(), this.tableName)
  }

  private getExpiredReservationCutoff(now: number): number {
    return now - (this.connection.retryAfter * 1000)
  }

  private createReservedJob(
    row: DatabaseQueuedJobRow,
    reservationId: string,
    reservedAt: number,
  ): QueueReservedJob<QueueJsonValue> {
    return Object.freeze({
      reservationId,
      reservedAt,
      envelope: queueDatabaseInternals.parseStoredQueueJobRow(row),
    })
  }

  async dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
    job: QueueJobEnvelope<TPayload>,
  ): Promise<QueueDriverDispatchResult<TResult>> {
    try {
      const connection = await this.getConnection()
      const quotedTable = this.getQuotedTable(connection)
      const placeholders = createPlaceholders(connection, 9)

      await connection.executeCompiled({
        sql: `INSERT INTO ${quotedTable} (id, job, connection, queue, payload, attempts, max_attempts, available_at, created_at) VALUES (${placeholders.join(', ')})`,
        bindings: [
          job.id,
          job.name,
          job.connection,
          job.queue,
          queueDatabaseInternals.serializeQueueJson(job.payload),
          job.attempts,
          job.maxAttempts,
          job.availableAt ?? job.createdAt,
          job.createdAt,
        ],
        source: `queue:${this.name}:dispatch`,
      })

      return {
        jobId: job.id,
        synchronous: false,
      }
    } catch (error) {
      throw wrapDatabaseError(this.name, 'enqueue job', error)
    }
  }

  async reserve<TPayload extends QueueJsonValue = QueueJsonValue>(
    input: { readonly queueNames: readonly string[], readonly workerId: string },
  ): Promise<QueueReservedJob<TPayload> | null> {
    try {
      const connection = await this.getConnection()
      const quotedTable = this.getQuotedTable(connection)
      const queueNames = normalizeQueueNames(input.queueNames, this.connection.queue)

      return await connection.transaction(async (tx: DatabaseContext) => {
        for (const queueName of queueNames) {
          while (true) {
            const now = Date.now()
            const expiredReservationCutoff = this.getExpiredReservationCutoff(now)
            const [queuePlaceholder, availablePlaceholder, expiredPlaceholder] = createPlaceholders(tx, 3)
            const selected = await tx.queryCompiled<DatabaseQueuedJobRow>({
              sql:
                `SELECT id, job, connection, queue, payload, attempts, max_attempts, available_at, created_at `
                + `FROM ${quotedTable} `
                + `WHERE queue = ${queuePlaceholder} `
                + `AND available_at <= ${availablePlaceholder} `
                + `AND (reserved_at IS NULL OR reserved_at <= ${expiredPlaceholder}) `
                + 'ORDER BY available_at ASC, created_at ASC, id ASC '
                + 'LIMIT 1',
              bindings: [queueName, now, expiredReservationCutoff],
              source: `queue:${this.name}:reserve:select`,
            })

            const row = selected.rows[0]
            if (!row) {
              break
            }

            const reservationId = `${input.workerId}:${randomUUID()}`
            const nextAttempts = queueDatabaseInternals.coerceRequiredInteger(row.attempts, 'Stored queue job attempts') + 1
            const [
              reservedAtPlaceholder,
              reservationPlaceholder,
              attemptsPlaceholder,
              idPlaceholder,
              queueNamePlaceholder,
              expiredCutoffPlaceholder,
            ] = createPlaceholders(tx, 6)
            const updated = await tx.executeCompiled({
              sql:
                `UPDATE ${quotedTable} `
                + `SET reserved_at = ${reservedAtPlaceholder}, reservation_id = ${reservationPlaceholder}, attempts = ${attemptsPlaceholder} `
                + `WHERE id = ${idPlaceholder} `
                + `AND queue = ${queueNamePlaceholder} `
                + `AND (reserved_at IS NULL OR reserved_at <= ${expiredCutoffPlaceholder})`,
              bindings: [now, reservationId, nextAttempts, row.id, queueName, expiredReservationCutoff],
              source: `queue:${this.name}:reserve:update`,
            })

            if ((updated.affectedRows ?? 0) === 1) {
              return this.createReservedJob(row, reservationId, now) as QueueReservedJob<TPayload>
            }
          }
        }

        return null
      })
    } catch (error) {
      throw wrapDatabaseError(this.name, 'reserve job', error)
    }
  }

  async acknowledge(job: QueueReservedJob): Promise<void> {
    try {
      const connection = await this.getConnection()
      const quotedTable = this.getQuotedTable(connection)
      const [idPlaceholder, reservationPlaceholder] = createPlaceholders(connection, 2)

      await connection.executeCompiled({
        sql: `DELETE FROM ${quotedTable} WHERE id = ${idPlaceholder} AND reservation_id = ${reservationPlaceholder}`,
        bindings: [job.envelope.id, job.reservationId],
        source: `queue:${this.name}:acknowledge`,
      })
    } catch (error) {
      throw wrapDatabaseError(this.name, 'acknowledge job', error)
    }
  }

  async release(job: QueueReservedJob, options?: QueueReleaseOptions): Promise<void> {
    try {
      const connection = await this.getConnection()
      const quotedTable = this.getQuotedTable(connection)
      const now = Date.now()
      const availableAt = now + ((options?.delaySeconds ?? 0) * 1000)
      const [availablePlaceholder, idPlaceholder, reservationPlaceholder] = createPlaceholders(connection, 3)

      await connection.executeCompiled({
        sql:
          `UPDATE ${quotedTable} SET reserved_at = NULL, reservation_id = NULL, available_at = ${availablePlaceholder} `
          + `WHERE id = ${idPlaceholder} AND reservation_id = ${reservationPlaceholder}`,
        bindings: [availableAt, job.envelope.id, job.reservationId],
        source: `queue:${this.name}:release`,
      })
    } catch (error) {
      throw wrapDatabaseError(this.name, 'release job', error)
    }
  }

  async delete(job: QueueReservedJob): Promise<void> {
    try {
      const connection = await this.getConnection()
      const quotedTable = this.getQuotedTable(connection)
      const [idPlaceholder, reservationPlaceholder] = createPlaceholders(connection, 2)

      await connection.executeCompiled({
        sql: `DELETE FROM ${quotedTable} WHERE id = ${idPlaceholder} AND reservation_id = ${reservationPlaceholder}`,
        bindings: [job.envelope.id, job.reservationId],
        source: `queue:${this.name}:delete`,
      })
    } catch (error) {
      throw wrapDatabaseError(this.name, 'delete job', error)
    }
  }

  async clear(input?: { readonly queueNames?: readonly string[] }): Promise<number> {
    try {
      const connection = await this.getConnection()
      const quotedTable = this.getQuotedTable(connection)
      const queueNames = normalizeQueueNames(input?.queueNames, this.connection.queue)
      const now = Date.now()
      const expiredReservationCutoff = this.getExpiredReservationCutoff(now)

      const conditions = [
        `queue IN (${createPlaceholders(connection, queueNames.length).join(', ')})`,
        `(reserved_at IS NULL OR reserved_at <= ${connection.getDialect().createPlaceholder(queueNames.length + 1)})`,
      ]
      const result = await connection.executeCompiled({
        sql: `DELETE FROM ${quotedTable} WHERE ${conditions.join(' AND ')}`,
        bindings: [...queueNames, expiredReservationCutoff],
        source: `queue:${this.name}:clear`,
      })

      return result.affectedRows ?? 0
    } catch (error) {
      throw wrapDatabaseError(this.name, 'clear queued jobs', error)
    }
  }

  async close(): Promise<void> {
    void this.context
  }
}

export const databaseQueueDriverFactory: QueueDriverFactory<NormalizedQueueDatabaseConnectionConfig> = {
  driver: 'database',
  create(connection, context) {
    return new DatabaseQueueDriver(connection, context)
  },
}

export const databaseQueueDriverInternals = {
  normalizeDatabaseErrorMessage,
  normalizeQueueNames,
  wrapDatabaseError,
}
