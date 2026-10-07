import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { describe, expect, it } from 'vitest'
import { createDatabase, createDialect, createSchemaService } from '../src'

describe.each(['postgres', 'mysql'] as const)('%s schema mutation outcomes', dialect => {
  const enabled = process.env[`HOLO_${dialect.toUpperCase()}_INTEGRATION`] === '1'

  it.runIf(enabled)('keeps metadata aligned with the database after DDL failure in a transaction', async () => {
    const tableName = `holo_outcomes_${randomUUID().replaceAll('-', '')}`
    const indexName = `${tableName}_id`
    const adapter = dialect === 'postgres'
      ? createPostgresAdapter({ config: { host: '/tmp', user: 'postgres', database: 'postgres' } })
      : createMySQLAdapter({ config: {
          host: '127.0.0.1',
          port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
          user: 'root',
          database: 'mysql',
        } })
    const db = createDatabase({ adapter, dialect: createDialect(dialect) })
    const schema = createSchemaService(db)

    try {
      await expect(db.transaction(async tx => {
        await createSchemaService(tx).createTable(tableName, table => {
          table.id()
          table.index(['id'], indexName)
          table.index(['missing'], `${tableName}_missing`)
        })
      })).rejects.toThrow()
      const retained = dialect === 'mysql'
      expect(await schema.hasTable(tableName)).toBe(retained)
      expect(db.getSchemaRegistry().has(tableName)).toBe(retained)
      if (retained) {
        expect((await schema.getColumns(tableName)).map(column => column.name)).toEqual(['id'])
        expect(db.getSchemaRegistry().get(tableName)?.indexes.map(index => index.name)).toEqual([indexName])
        expect((await schema.getIndexes(tableName)).map(index => index.name)).toContain(indexName)
      }
    } finally {
      if (await schema.hasTable(tableName)) await schema.dropTable(tableName)
      await adapter.disconnect()
    }
  }, 30_000)
})
