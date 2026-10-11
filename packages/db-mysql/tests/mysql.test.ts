import { randomUUID } from 'node:crypto'
import { createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import {
  createDatabase,
  TableQueryBuilder,
  createDialect,
  createMigrationService,
  createSchemaService,
  column,
  defineMigration,
  MySQLSchemaCompiler,
} from '@holo-js/db'
import { createMySQLAdapter } from '../src'

const liveMySqlConfig = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: 'root',
  database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
}

describe('@holo-js/db-mysql', () => {
  it('connects to the selected integration database', async () => {
    const adapter = createMySQLAdapter({ config: liveMySqlConfig })
    try {
      const result = await adapter.query<{ selected_database: string }>('SELECT DATABASE() AS selected_database')
      expect(result.rows).toEqual([{ selected_database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql' }])
    } finally {
      await adapter.disconnect()
    }
  }, 30_000)

  it.each(['create', 'add', 'compiled-add'] as const)('enforces constrained foreign keys when using %s columns', async (operation) => {
    const databaseName = `holo_foreign_keys_${randomUUID().replaceAll('-', '_')}`
    const admin = createMySQLAdapter({
      config: liveMySqlConfig,
    })
    const adapter = createMySQLAdapter({
      config: { ...liveMySqlConfig,
        database: databaseName, },
    })
    const schema = createSchemaService(createDatabase({ adapter, dialect: createDialect('mysql') }))

    try {
      await adapter.ensureDatabaseExists()
      await schema.createTable('categories', (table) => {
        table.id()
      })
      await schema.createTable('products', (table) => {
        table.id()
        if (operation === 'create') {
          table.foreignId('category_id').nullable().constrained('categories').nullOnDelete().cascadeOnUpdate()
        }
      })
      if (operation === 'add') {
        await schema.table('products', (table) => {
          table.foreignId('category_id').nullable().constrained('categories').nullOnDelete().cascadeOnUpdate()
        })
      }
      if (operation === 'compiled-add') {
        const compiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)
        const definition = column.foreignId().nullable().constrained('categories').nullOnDelete().cascadeOnUpdate()
          .toDefinition({ name: 'category_id' })
        await adapter.execute(compiler.compileAddColumn('products', definition).sql)
      }

      await expect(adapter.execute('insert into products (category_id) values (?)', [999]))
        .rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' })

      await adapter.execute('insert into categories (id) values (?)', [1])
      await adapter.execute('insert into products (id, category_id) values (?, ?)', [1, 1])
      await adapter.execute('update categories set id = ? where id = ?', [2, 1])
      expect((await adapter.query<{ category_id: number }>('select category_id from products')).rows)
        .toEqual([{ category_id: 2 }])

      await adapter.execute('delete from categories where id = ?', [2])
      expect((await adapter.query<{ category_id: number | null }>('select category_id from products')).rows)
        .toEqual([{ category_id: null }])

      await schema.table('products', (table) => {
        table.dropForeign('products_category_id_foreign')
      })
      await expect(adapter.execute('insert into products (category_id) values (?)', [999]))
        .resolves.toMatchObject({ affectedRows: 1 })
    } finally {
      await adapter.disconnect()
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await admin.disconnect()
    }
  }, 30_000)

  it.each(['config', 'uri'] as const)('creates and reopens a quoted database name through %s configuration', async mode => {
    const database = `holo_quoted_${randomUUID().replaceAll('-', '')}\`tenant`
    const admin = createMySQLAdapter({ config: liveMySqlConfig })
    const adapter = createMySQLAdapter(mode === 'config'
      ? { config: { ...liveMySqlConfig, database } }
      : { uri: `mysql://${liveMySqlConfig.user}@${liveMySqlConfig.host}:${liveMySqlConfig.port}/${encodeURIComponent(database)}` })
    try {
      await adapter.ensureDatabaseExists()
      await adapter.ensureDatabaseExists()
      expect((await adapter.query('SELECT DATABASE() AS selected_database')).rows).toEqual([{ selected_database: database }])
      await adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
      expect((await adapter.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`DROP DATABASE IF EXISTS \`${database.replaceAll('`', '``')}\``)
      await admin.disconnect()
    }
  }, 30_000)

  it.each(['update', 'shared'] as const)('reads a paginated row under a native %s lock', async mode => {
    const adapter = createMySQLAdapter({ config: liveMySqlConfig })
    const database = createDatabase({ adapter, dialect: createDialect('mysql') })
    const schema = createSchemaService(database)
    const tableName = `locked_rows_${randomUUID().replaceAll('-', '')}`
    try {
      await schema.createTable(tableName, table => {
        table.integer('id').primaryKey()
      })
      await new TableQueryBuilder(tableName, database).insert([{ id: 1 }, { id: 2 }])
      await database.transaction(async transaction => {
        const query = new TableQueryBuilder(tableName, transaction).orderBy('id').offset(1)
        const locked = mode === 'update' ? query.lockForUpdate() : query.sharedLock()
        expect(await locked.first()).toEqual({ id: 2 })
      })
    } finally {
      await schema.dropTable(tableName)
      await adapter.disconnect()
    }
  })

  it('reports real database creation permission failures', async () => {
    const user = `holo_denied_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const password = randomUUID()
    const admin = createMySQLAdapter({ config: liveMySqlConfig })
    const adapter = createMySQLAdapter({ config: { ...liveMySqlConfig, user, password, database: user } })
    try {
      await admin.execute(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`)
      await expect(adapter.ensureDatabaseExists()).rejects.toThrow(`MySQL database "${user}" could not be found or created`)
    } finally {
      await adapter.disconnect()
      await admin.execute(`DROP USER IF EXISTS '${user}'@'%'`)
      await admin.disconnect()
    }
  }, 30_000)

  it('uses a real injected client for bound writes, commit, and rollback', async () => {
    const client = await createConnection(liveMySqlConfig)
    const adapter = createMySQLAdapter({ client: {
      query: (sql, bindings = []) => client.query(sql, [...bindings]),
      end: () => client.end(),
    } })
    try {
      await adapter.execute('CREATE TEMPORARY TABLE direct_records (id INT AUTO_INCREMENT PRIMARY KEY, value TEXT NOT NULL)')
      await adapter.beginTransaction()
      const inserted = await adapter.execute('INSERT INTO direct_records (value) VALUES (?)', ["a'; DROP TABLE direct_records; --"])
      await adapter.commit()
      expect(inserted.affectedRows).toBe(1)
      expect((await adapter.query('SELECT value FROM direct_records WHERE id = ?', [inserted.lastInsertId])).rows)
        .toEqual([{ value: "a'; DROP TABLE direct_records; --" }])
      await adapter.beginTransaction()
      await adapter.execute('DELETE FROM direct_records')
      await adapter.rollback()
      expect((await adapter.query('SELECT count(*) AS count FROM direct_records')).rows).toEqual([{ count: 1 }])
    } finally {
      await adapter.disconnect()
    }
  }, 30_000)

  it('applies JSON and text defaults from native schema migrations', async () => {
    const tableName = `holo_defaults_${randomUUID().replaceAll('-', '_')}`
    const adapter = createMySQLAdapter({ config: liveMySqlConfig })
    const db = createDatabase({ adapter, dialect: createDialect('mysql') })
    const schema = createSchemaService(db)
    try {
      await schema.createTable(tableName, table => {
        table.id()
        table.json('data').default({ active: true })
        table.text('label').default('default label')
      })
      await new TableQueryBuilder(tableName, db).insert({ id: 1 })
      expect(await new TableQueryBuilder(tableName, db).first()).toEqual({ id: 1, data: { active: true }, label: 'default label' })
    } finally {
      await schema.dropTable(tableName)
      await adapter.disconnect()
    }
  }, 30_000)

  it('runs queries against a local MySQL server through the public adapter', async () => {
    const tableName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const adapter = createMySQLAdapter({
      config: liveMySqlConfig,
    })

    try {
      await adapter.execute(`create table ${tableName} (id int auto_increment primary key, name varchar(255) not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values (?)`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = ?`,
        [inserted.lastInsertId],
      )

      expect(inserted.affectedRows).toBe(1)
      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.execute(`drop table if exists ${tableName}`)
      await adapter.disconnect()
    }
  }, 30_000)

  it('creates a missing configured database against a real MySQL server', async () => {
    const databaseName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const tableName = 'users'
    const admin = createMySQLAdapter({
      config: liveMySqlConfig,
    })
    const adapter = createMySQLAdapter({
      config: {
        ...liveMySqlConfig,
        database: databaseName,
      },
    })

    try {
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await adapter.ensureDatabaseExists()
      await adapter.execute(`create table ${tableName} (id int auto_increment primary key, name varchar(255) not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values (?)`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = ?`,
        [inserted.lastInsertId],
      )

      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await admin.disconnect()
    }
  }, 30_000)

  it('runs migration tracking against a real MySQL server', async () => {
    const databaseName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const migration = defineMigration({
      name: '2026_05_31_000001_create_users',
      async up({ schema }) {
        await schema.createTable('users', (table) => {
          table.id()
          table.string('email')
          table.timestamp('created_at').nullable()
        })
      },
      async down({ schema }) {
        await schema.dropTable('users')
      },
    })
    const admin = createMySQLAdapter({
      config: liveMySqlConfig,
    })
    const adapter = createMySQLAdapter({
      config: {
        ...liveMySqlConfig,
        database: databaseName,
      },
    })
    const db = createDatabase({
      connectionName: 'main',
      adapter,
      dialect: createDialect('mysql'),
    })
    const migrator = createMigrationService(db, [migration])

    try {
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await expect(migrator.migrate()).resolves.toEqual([migration])

      const tracked = await adapter.query<{ name: string }>(
        'select name from `_holo_migrations` where name = ?',
        [migration.name],
      )

      expect(tracked.rows).toEqual([{ name: migration.name }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await admin.disconnect()
    }
  }, 30_000)
})
