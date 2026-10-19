import { randomUUID } from 'node:crypto'
import { DatabaseError, HydrationError } from '../core/errors'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import { column } from '../schema'
import { defineTable } from '../schema/defineTable'
import { ensureMigrationTable } from './ensureMigrationTable'
import type { DatabaseContext } from '../core/DatabaseContext'

const migrationLocksTable = defineTable('_holo_migration_locks', {
  id: column.id(),
  name: column.string().unique(),
  owner: column.string(),
  expires_at: column.timestamp(),
})

const migrationLockName = 'migrations'
const migrationLockLifetimeMs = 60 * 60 * 1000

type MigrationLockRecord = {
  id: number
  name: string
  owner: string
  expires_at: string | Date
}

export class MigrationLease {
  private owner: string | undefined

  constructor(private readonly connection: DatabaseContext) {}

  async acquire(): Promise<boolean> {
    await this.ensureTable()
    const current = await this.read()
    if (current) {
      if (current.expiresAt > Date.now()) {
        return false
      }

      await this.rows()
        .where('owner', current.owner)
        .where('expires_at', current.storedExpiresAt)
        .delete()
      if (await this.read()) {
        return false
      }
    }

    const owner = randomUUID()
    try {
      await new TableQueryBuilder(migrationLocksTable, this.connection).insert({
        name: migrationLockName,
        owner,
        expires_at: this.expiry(),
      })
      this.owner = owner
      return true
    } catch (error) {
      if (await this.read()) {
        return false
      }

      throw error
    }
  }

  async renew(): Promise<void> {
    if (!this.owner) {
      return
    }

    await this.rows()
      .where('owner', this.owner)
      .update({ expires_at: this.expiry() })

    if ((await this.read())?.owner !== this.owner) {
      throw new DatabaseError(
        'Migration lock was taken over by another runner before the run finished.',
        'MIGRATION_LOCK_LOST',
      )
    }
  }

  async release(): Promise<void> {
    if (!this.owner) {
      return
    }

    await this.rows().where('owner', this.owner).delete()
    this.owner = undefined
  }

  private async read(): Promise<{ owner: string, expiresAt: number, storedExpiresAt: string | Date } | undefined> {
    const row = await this.rows().first<MigrationLockRecord>()
    if (!row) {
      return undefined
    }

    return {
      owner: row.owner,
      expiresAt: this.normalizeExpiry(row.expires_at),
      storedExpiresAt: row.expires_at,
    }
  }

  private rows(): TableQueryBuilder<typeof migrationLocksTable> {
    return new TableQueryBuilder(migrationLocksTable, this.connection).where('name', migrationLockName)
  }

  private expiry(): Date {
    return new Date(Date.now() + migrationLockLifetimeMs)
  }

  private normalizeExpiry(value: string | Date): number {
    const normalized = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(normalized.getTime())) {
      throw new HydrationError('Migration lock contains an invalid expiry timestamp.')
    }

    return normalized.getTime()
  }

  private async ensureTable(): Promise<void> {
    await ensureMigrationTable(this.connection, migrationLocksTable.tableName, (table) => {
      table.id()
      table.string('name').unique()
      table.string('owner')
      table.timestamp('expires_at')
    })
  }
}
