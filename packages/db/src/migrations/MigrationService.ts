import { DatabaseError, HydrationError } from '../core/errors'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import { column } from '../schema'
import { defineTable } from '../schema/defineTable'
import { createSchemaService } from '../schema/SchemaService'
import { assertMigrationName, defineMigration } from './defineMigration'
import type { MigrationStartLog } from '../core/types'
import type { DatabaseContext } from '../core/DatabaseContext'
import type {
  MigrateOptions,
  MigrationContext,
  MigrationDefinition,
  MigrationSquashPlan,
  MigrationStatus,
  RollbackOptions,
  MigrationExecutionPolicy,
} from './types'

type RegisteredMigrationDefinition = MigrationDefinition & { readonly name: string }

const migrationsTable = defineTable('_holo_migrations', {
  id: column.id(),
  name: column.string().unique(),
  batch: column.integer(),
  migrated_at: column.timestamp().defaultNow(),
})

type MigrationRecord = {
  id: number
  name: string
  batch: number
  migrated_at: string | Date
}

const migrationExecutionLocks = new WeakSet<object>()

export class MigrationService {
  private readonly migrations = new Map<string, RegisteredMigrationDefinition>()

  constructor(
    private readonly connection: DatabaseContext,
    migrations: readonly MigrationDefinition[] = [],
  ) {
    for (const migration of migrations) {
      this.register(migration)
    }
  }

  register(migration: MigrationDefinition): this {
    if (!migration.name) {
      throw new DatabaseError(
        'Migration registration requires a resolved migration name. File-based migrations should be loaded through the project loader so the filename can provide that name.',
        'MISSING_MIGRATION_NAME',
      )
    }

    const name = assertMigrationName(migration.name)
    if (this.migrations.has(name)) {
      throw new DatabaseError(`Migration "${name}" is already registered.`, 'DUPLICATE_MIGRATION')
    }

    this.migrations.set(name, defineMigration(migration) as RegisteredMigrationDefinition)
    return this
  }

  getMigrations(): readonly RegisteredMigrationDefinition[] {
    return [...this.migrations.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  getMigration(name: string): RegisteredMigrationDefinition | undefined {
    return this.migrations.get(name)
  }

  async hasRan(name: string): Promise<boolean> {
    const ran = await this.getRanRecords()
    return ran.some(record => record.name === name)
  }

  async status(): Promise<MigrationStatus[]> {
    const ran = await this.getRanRecords()
    const ranMap = new Map(ran.map(record => [record.name, record]))

    return this.getMigrations().map((migration) => {
      const record = ranMap.get(migration.name)
      if (!record) {
        return {
          name: migration.name,
          status: 'pending',
        }
      }

      return {
        name: migration.name,
        status: 'ran',
        batch: record.batch,
        migratedAt: this.normalizeMigratedAt(record.migrated_at),
      }
    })
  }

  async planSquash(archiveName = 'schema'): Promise<MigrationSquashPlan> {
    const normalizedArchiveName = archiveName.trim().replace(/\s+/g, '_')
    if (normalizedArchiveName.length === 0) {
      throw new DatabaseError('Migration squash archive name must be a non-empty string.', 'INVALID_MIGRATION_ARCHIVE_NAME')
    }

    const ran = await this.getRanRecords()
    const batches = ran.map(record => record.batch)

    return {
      archiveName: normalizedArchiveName,
      includedMigrations: ran.map(record => record.name),
      fromBatch: batches.length > 0 ? Math.min(...batches) : undefined,
      toBatch: batches.length > 0 ? Math.max(...batches) : undefined,
      ranCount: ran.length,
    }
  }

  async migrate(options: MigrateOptions = {}): Promise<RegisteredMigrationDefinition[]> {
    return this.runExclusively(async () => {
      await this.ensureTrackingTable()
      const step = options.step ?? Number.POSITIVE_INFINITY
      const ran = await this.getRanRecords()
      const ranNames = new Set(ran.map(record => record.name))
      const nextBatch = ran.length === 0
        ? 1
        : Math.max(...ran.map(record => record.batch)) + 1

      const pending = this.getMigrations()
        .filter(migration => !ranNames.has(migration.name))
        .slice(0, step)

      const executed: RegisteredMigrationDefinition[] = []
      for (const migration of pending) {
        const log = this.createMigrationLog(migration.name, 'up', nextBatch)
        const startedAt = Date.now()

        await this.connection.getLogger()?.onMigrationStart?.(log)

        try {
          await this.connection.transaction(async (tx) => {
            const context = this.createContext(tx)
            await migration.up(context)
            await new TableQueryBuilder(migrationsTable, tx).insert({
              name: migration.name,
              batch: nextBatch,
              migrated_at: new Date().toISOString(),
            })
          })
          await this.connection.getLogger()?.onMigrationSuccess?.({
            ...log,
            durationMs: Date.now() - startedAt,
          })
        } catch (error) {
          await this.connection.getLogger()?.onMigrationError?.({
            ...log,
            durationMs: Date.now() - startedAt,
            error,
          })
          throw error
        }
        executed.push(migration)
      }

      return executed
    })
  }

  async rollback(options: RollbackOptions = {}): Promise<RegisteredMigrationDefinition[]> {
    return this.runExclusively(async () => {
      await this.ensureTrackingTable()
      const step = options.step ?? Number.POSITIVE_INFINITY
      const ran = await this.getRanRecords()
      if (ran.length === 0) {
        return []
      }

      const latestBatch = options.batch ?? Math.max(...ran.map(record => record.batch))
      const toRollback = ran
        .filter(record => record.batch === latestBatch)
        .sort((left, right) => right.id - left.id)
        .slice(0, step)

      const rolledBack: RegisteredMigrationDefinition[] = []
      for (const record of toRollback) {
        const migration = this.migrations.get(record.name)
        if (!migration) {
          continue
        }

        const log = this.createMigrationLog(record.name, 'down', record.batch)
        const startedAt = Date.now()

        await this.connection.getLogger()?.onMigrationStart?.(log)

        try {
          await this.connection.transaction(async (tx) => {
            const context = this.createContext(tx)
            if (migration.down) {
              await migration.down(context)
            }

            await new TableQueryBuilder(migrationsTable, tx)
              .where('name', record.name)
              .delete()
          })
          await this.connection.getLogger()?.onMigrationSuccess?.({
            ...log,
            durationMs: Date.now() - startedAt,
          })
        } catch (error) {
          await this.connection.getLogger()?.onMigrationError?.({
            ...log,
            durationMs: Date.now() - startedAt,
            error,
          })
          throw error
        }

        rolledBack.push(migration)
      }

      return rolledBack
    })
  }

  getExecutionPolicy(): MigrationExecutionPolicy {
    return {
      mode: 'exclusive',
      scope: 'adapter',
      allowsConcurrentMigrations: false,
    }
  }

  private async ensureTrackingTable(): Promise<void> {
    const schema = createSchemaService(this.connection)
    if (await schema.hasTable(migrationsTable.tableName)) {
      return
    }

    await schema.createTable(migrationsTable.tableName, (table) => {
      table.id()
      table.string('name').unique()
      table.integer('batch')
      table.timestamp('migrated_at').defaultNow()
    })
  }

  private async getRanRecords(): Promise<MigrationRecord[]> {
    const schema = createSchemaService(this.connection)
    if (!(await schema.hasTable(migrationsTable.tableName))) {
      return []
    }

    const rows = await new TableQueryBuilder(migrationsTable, this.connection)
      .orderBy('batch', 'asc')
      .orderBy('id', 'asc')
      .get<MigrationRecord>()

    return rows
  }

  private createContext(connection: DatabaseContext): MigrationContext {
    return {
      db: connection,
      schema: createSchemaService(connection),
    }
  }

  private normalizeMigratedAt(value: string | Date): Date {
    const normalized = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(normalized.getTime())) {
      throw new HydrationError('Migration tracking contains an invalid migrated-at timestamp.')
    }

    return normalized
  }

  private createMigrationLog(
    migrationName: string,
    action: 'up' | 'down',
    batch?: number,
  ): MigrationStartLog {
    return {
      connectionName: this.connection.getConnectionName(),
      migrationName,
      action,
      batch,
    }
  }

  private async runExclusively<T>(callback: () => Promise<T>): Promise<T> {
    const adapter = this.connection.getAdapter()
    if (migrationExecutionLocks.has(adapter)) {
      throw new DatabaseError(
        `Another migration operation is already running on connection "${this.connection.getConnectionName()}".`,
        'MIGRATION_ALREADY_RUNNING',
      )
    }

    migrationExecutionLocks.add(adapter)
    try {
      return await callback()
    } finally {
      migrationExecutionLocks.delete(adapter)
    }
  }
}

export function createMigrationService(
  connection: DatabaseContext,
  migrations: readonly MigrationDefinition[] = [],
): MigrationService {
  return new MigrationService(connection, migrations)
}
