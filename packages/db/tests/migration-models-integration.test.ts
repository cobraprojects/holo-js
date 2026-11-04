import { randomUUID } from 'node:crypto'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TableQueryBuilder,
  clearGeneratedTables,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createMigrationService,
  createSchemaService,
  defineGeneratedTable,
  defineMigration,
  defineModel,
  registerGeneratedTables,
  resetDB,
  type DatabaseContext,
  type MigrationDefinition,
} from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

type MigrationFixture = {
  readonly db: DatabaseContext
  readonly suffix: string
  readonly tableName: (prefix: string) => string
  readonly migrationName: (sequence: number) => string
}

async function withMigrationFixture(driver: Driver, run: (fixture: MigrationFixture) => Promise<void>): Promise<void> {
  const { db } = await openDatabase(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const tables: string[] = []
  const migrations: string[] = []
  const fixture: MigrationFixture = {
    db,
    suffix,
    tableName(prefix) {
      const name = `${prefix}_${suffix}`
      tables.unshift(name)
      return name
    },
    migrationName(sequence) {
      const name = `2026_01_01_00000${sequence}_models_${suffix}`
      migrations.push(name)
      return name
    },
  }
  try {
    await run(fixture)
  } finally {
    const schema = createSchemaService(db)
    for (const table of tables) {
      if (await schema.hasTable(table)) await schema.dropTable(table)
    }
    if (migrations.length > 0 && await schema.hasTable('_holo_migrations')) {
      await new TableQueryBuilder('_holo_migrations', db).whereIn('name', migrations).delete()
    }
  }
}

function migration(name: string, up: MigrationDefinition['up']): MigrationDefinition {
  return defineMigration({ name, up })
}

describe.each(drivers)('models used by %s migration handlers', (driver) => {
  afterEach(() => {
    clearGeneratedTables()
    resetDB()
  })

  it.skipIf(driver === 'mysql')('keep reading a table whose drop a savepoint rolled back', async () => {
    await withMigrationFixture(driver, async ({ db, tableName, migrationName }) => {
      const users = tableName('users')
      const User = defineModel(users, { fillable: ['name'] })
      let count: number | undefined

      await createMigrationService(db, [
        migration(migrationName(1), async ({ schema }) => {
          await schema.createTable(users, (table) => {
            table.id()
            table.string('name')
            table.timestamps()
          })
        }),
        migration(migrationName(2), async ({ db: migrationDb, schema }) => {
          await User.create({ name: 'Ada' })
          await migrationDb.transaction(async () => {
            await schema.dropTable(users)
            throw new Error('undo the drop')
          }).catch(() => undefined)
          count = await User.count()
        }),
      ]).migrate()

      expect(count).toBe(1)
    })
  })

  it('write through a default-connection model inside a migration run on another connection', async () => {
    await withMigrationFixture(driver, async ({ db, tableName, migrationName }) => {
      const members = tableName('members')
      await createSchemaService(db).createTable(members, (table) => {
        table.id()
        table.string('name')
      })
      const analyticsAdapter = createSQLiteAdapter({ filename: ':memory:' })
      const analytics = createDatabase({ connectionName: 'analytics', adapter: analyticsAdapter, dialect: createDialect('sqlite') })
      configureDB(createConnectionManager({ defaultConnection: db.getConnectionName(), connections: { [db.getConnectionName()]: db, analytics } }))
      const Member = defineModel(members, { connectionName: db.getConnectionName(), fillable: ['name'], timestamps: false })

      try {
        await createMigrationService(analytics, [
          migration(migrationName(1), async () => {
            await Member.create({ name: 'Ada' })
          }),
        ]).migrate()
      } finally {
        await analytics.disconnect()
      }

      expect((await new TableQueryBuilder(members, db).get()).map(row => row.name)).toEqual(['Ada'])
    })
  })

  it('write to a table the public schema builder created earlier in the same and an earlier handler', async () => {
    await withMigrationFixture(driver, async ({ db, tableName, migrationName }) => {
      const widgets = tableName('widgets')
      const Widget = defineModel(widgets, { fillable: ['name'], timestamps: false })

      await createMigrationService(db, [
        migration(migrationName(1), async ({ db: migrationDb }) => {
          await createSchemaService(migrationDb).createTable(widgets, (table) => {
            table.id()
            table.string('name')
          })
          await Widget.create({ name: 'same handler' })
        }),
        migration(migrationName(2), async () => {
          await Widget.create({ name: 'later handler' })
        }),
      ]).migrate()

      expect((await new TableQueryBuilder(widgets, db).orderBy('id').get()).map(row => row.name)).toEqual(['same handler', 'later handler'])
    })
  })

  it('write a column added during the run to a table the Generated schema registers without it', async () => {
    await withMigrationFixture(driver, async ({ db, tableName, migrationName }) => {
      const users = tableName('users')
      await createSchemaService(db).createTable(users, (table) => {
        table.id()
        table.string('name')
      })
      registerGeneratedTables({ [users]: defineGeneratedTable(users, { id: column.id(), name: column.string() }) })
      const User = defineModel(users, { fillable: ['name', 'slug'], timestamps: false })
      const GuardedUser = defineModel(users, { guarded: ['id'], timestamps: false })

      await createMigrationService(db, [
        migration(migrationName(1), async ({ db: migrationDb }) => {
          await GuardedUser.create({ name: 'Grace' })
          await createSchemaService(migrationDb).table(users, (table) => {
            table.string('slug').nullable()
          })
          await User.create({ name: 'Ada', slug: 'ada' })
          await GuardedUser.create({ name: 'Linus', slug: 'linus' })
        }),
      ]).migrate()

      expect((await new TableQueryBuilder(users, db).orderBy('id').get()).map(row => ({ name: row.name, slug: row.slug }))).toEqual([
        { name: 'Grace', slug: null },
        { name: 'Ada', slug: 'ada' },
        { name: 'Linus', slug: 'linus' },
      ])
      await expect(User.create({ name: 'Outside', slug: 'outside' })).rejects.toThrow('Column "slug" is not defined')
    })
  })
})
