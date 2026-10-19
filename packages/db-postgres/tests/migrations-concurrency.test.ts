import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDatabase, createDialect, createMigrationService, defineMigration } from '@holo-js/db'
import { createPostgresAdapter } from '../src'

const livePostgresConfig = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
  password: process.env.HOLO_POSTGRES_PASSWORD,
  database: 'postgres',
}

describe('@holo-js/db-postgres migration runs', () => {
  it.each(Array.from({ length: 5 }, (_, round) => round))('lets two concurrent first runs on a fresh database both finish, applying each migration once (round %i)', async () => {
    const databaseName = `holo_migrations_${randomUUID().replaceAll('-', '')}`
    const admin = new Client(livePostgresConfig)
    await admin.connect()
    await admin.query(`CREATE DATABASE ${databaseName}`)
    const config = { ...livePostgresConfig, database: databaseName }
    const connections = Array.from({ length: 2 }, () => createDatabase({
      adapter: createPostgresAdapter({ config }),
      dialect: createDialect('postgres'),
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
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`)
      await admin.end()
    }
  }, 30000)
})
