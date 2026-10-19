import { randomUUID } from 'node:crypto'
import type { DatabaseContext } from '@holo-js/db'
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
import {
  coerceRequiredInteger,
  createPlaceholderList,
  ensureConnectionReady,
  normalizeIdentifierPath,
  parseStoredQueueJobRow,
  quoteIdentifierPath,
  resolveDatabaseConnection,
  serializeQueueJson,
} from '../database'

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

type ReservationCandidate = {
  id: unknown
  available_at: unknown
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

const RESERVATION_CANDIDATE_PAGE_SIZE = 100

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
  return createPlaceholderList(connection.getDialect(), count, startIndex).split(', ')
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
    this.tableName = normalizeIdentifierPath(connection.table, 'Queue table name')
  }

  private async getConnection(): Promise<DatabaseContext> {
    return ensureConnectionReady(resolveDatabaseConnection(this.connection.connection))
  }

  private getQuotedTable(connection: DatabaseContext): string {
    return quoteIdentifierPath(connection.getDialect(), this.tableName)
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
      envelope: parseStoredQueueJobRow(row),
    })
  }

  private async lockNextJob(
    tx: DatabaseContext,
    quotedTable: string,
    queueName: string,
    now: number,
  ): Promise<DatabaseQueuedJobRow | undefined> {
    const expiredReservationCutoff = this.getExpiredReservationCutoff(now)
    const lockClause = tx.getCapabilities().lockForUpdate ? ' FOR UPDATE SKIP LOCKED' : ''
    let after: ReservationCandidate | undefined

    while (true) {
      const candidates = await this.selectReservationCandidates(tx, quotedTable, queueName, now, after)
      for (const candidate of candidates) {
        const [idPlaceholder, availablePlaceholder, expiredPlaceholder] = createPlaceholders(tx, 3)
        const locked = await tx.queryCompiled<DatabaseQueuedJobRow>({
          sql:
            `SELECT id, job, connection, queue, payload, attempts, max_attempts, available_at, created_at `
            + `FROM ${quotedTable} `
            + `WHERE id = ${idPlaceholder} `
            + `AND available_at <= ${availablePlaceholder} `
            + `AND (reserved_at IS NULL OR reserved_at <= ${expiredPlaceholder})${lockClause}`,
          bindings: [candidate.id, now, expiredReservationCutoff],
          source: `queue:${this.name}:reserve:lock`,
        })

        if (locked.rows[0]) {
          return locked.rows[0]
        }
      }

      after = candidates.at(-1)
      if (!after || candidates.length < RESERVATION_CANDIDATE_PAGE_SIZE) {
        return undefined
      }
    }
  }

  private async selectReservationCandidates(
    tx: DatabaseContext,
    quotedTable: string,
    queueName: string,
    now: number,
    after: ReservationCandidate | undefined,
  ): Promise<readonly ReservationCandidate[]> {
    const placeholders = createPlaceholders(tx, after ? 6 : 3)
    const [queuePlaceholder, availablePlaceholder, expiredPlaceholder] = placeholders
    const cursorCondition = after
      ? `AND (available_at, created_at, id) > (${placeholders.slice(3).join(', ')}) `
      : ''
    const result = await tx.queryCompiled<ReservationCandidate>({
      sql:
        `SELECT id, available_at, created_at FROM ${quotedTable} `
        + `WHERE queue = ${queuePlaceholder} `
        + `AND available_at <= ${availablePlaceholder} `
        + `AND (reserved_at IS NULL OR reserved_at <= ${expiredPlaceholder}) `
        + cursorCondition
        + 'ORDER BY available_at ASC, created_at ASC, id ASC '
        + `LIMIT ${RESERVATION_CANDIDATE_PAGE_SIZE}`,
      bindings: [
        queueName,
        now,
        this.getExpiredReservationCutoff(now),
        ...(after ? [after.available_at, after.created_at, after.id] : []),
      ],
      source: `queue:${this.name}:reserve:candidates`,
    })

    return result.rows
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
          serializeQueueJson(job.payload),
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
          const now = Date.now()
          const row = await this.lockNextJob(tx, quotedTable, queueName, now)
          if (!row) {
            continue
          }

          const reservationId = `${input.workerId}:${randomUUID()}`
          const nextAttempts = coerceRequiredInteger(row.attempts, 'Stored queue job attempts') + 1
          const [reservedAtPlaceholder, reservationPlaceholder, attemptsPlaceholder, idPlaceholder] = createPlaceholders(tx, 4)
          await tx.executeCompiled({
            sql:
              `UPDATE ${quotedTable} `
              + `SET reserved_at = ${reservedAtPlaceholder}, reservation_id = ${reservationPlaceholder}, attempts = ${attemptsPlaceholder} `
              + `WHERE id = ${idPlaceholder}`,
            bindings: [now, reservationId, nextAttempts, row.id],
            source: `queue:${this.name}:reserve:update`,
          })

          return this.createReservedJob(row, reservationId, now) as QueueReservedJob<TPayload>
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
  createPlaceholders,
  normalizeDatabaseErrorMessage,
  normalizeQueueNames,
  wrapDatabaseError,
}
