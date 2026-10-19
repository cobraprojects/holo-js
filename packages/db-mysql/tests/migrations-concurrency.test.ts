import { randomUUID } from 'node:crypto'
import { createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { createDatabase, createDialect, createMigrationService, defineMigration } from '@holo-js/db'
import { createMySQLAdapter } from '../src'

const liveMySqlConfig = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: process.env.HOLO_MYSQL_USER ?? 'root',
  password: process.env.HOLO_MYSQL_PASSWORD,
  database: 'mysql',
}

describe('@holo-js/db-mysql migration runs', () => {
  it.each(Array.from({ length: 5 }, (_, round) => round))('lets two concurrent first runs on a fresh database both finish, applying each migration once (round %i)', async () => {
    const databaseName = `holo_migrations_${randomUUID().replaceAll('-', '')}`
    const admin = await createConnection(liveMySqlConfig)
    await admin.query(`CREATE DATABASE \`${databaseName}\``)
    const config = { ...liveMySqlConfig, database: databaseName }
    const connections = Array.from({ length: 2 }, () => createDatabase({
      adapter: createMySQLAdapter({ config }),
      dialect: createDialect('mysql'),
    }))
    const migration = defineMigration({
      name: '2026_01_01_000001_first',
      async up({ schema }) {
        await schema.createTable('first_records', (table) => {
          table.id()
        })
      },
    })
    try {
      const results = await Promise.all(connections.map(connection => createMigrationService(connection, [migration]).migrateIsolated()))

      const executed = results.flatMap(result => result.kind === 'ran' ? result.executed : [])
      expect(executed.map(entry => entry.name)).toEqual([migration.name])
    } finally {
      await Promise.all(connections.map(connection => connection.disconnect()))
      await admin.query(`DROP DATABASE \`${databaseName}\``)
      await admin.end()
    }
  }, 30000)
})
