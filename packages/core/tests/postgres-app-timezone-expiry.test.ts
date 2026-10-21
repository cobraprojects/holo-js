import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createDatabaseSessionStore } from '@holo-js/session'
import passwordResetMigration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044036_create_password_reset_tokens'
import sessionsMigration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createCoreAuthPersistence } from '../src/portable/authPersistence'
import { createCoreDatabaseSessionAdapter } from '../src/portable/sessionPersistence'

const gate = process.env.HOLO_POSTGRES_INTEGRATION === '1'
const config = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: 'postgres',
}

let previousTimeZone: string | undefined

beforeEach(() => {
  previousTimeZone = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  configureConfigRuntime({ app: { timezone: 'America/New_York' } } as never)
})

afterEach(() => {
  resetConfigRuntime()
  if (previousTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimeZone
})

function connect(database: string): DatabaseContext {
  return new DatabaseContext({
    driver: 'postgres',
    dialect: createDialect('postgres'),
    adapter: createPostgresAdapter({ config: { ...config, database, max: 2 } }),
  })
}

async function withDatabase(run: (connection: DatabaseContext) => Promise<void>): Promise<void> {
  const name = `expiry_${randomUUID().replaceAll('-', '')}`
  const admin = connect('postgres')
  const connection = connect(name)
  try {
    await admin.executeCompiled({ sql: `CREATE DATABASE "${name}"`, source: 'schema' })
    await run(connection)
  } finally {
    resetDB()
    await connection.disconnect()
    await admin.executeCompiled({ sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, source: 'schema' })
    await admin.disconnect()
  }
}

it.skipIf(!gate)('rejects a password-reset token that expired a minute ago and accepts one that expires in a minute when app.timezone is America/New_York', async () => {
  await withDatabase(async (connection) => {
    await passwordResetMigration.up({ db: connection, schema: createSchemaService(connection) })
    configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
    const persistence = await createCoreAuthPersistence('/unused-project', {
      auth: { providers: {}, passwords: { users: { provider: 'users', table: 'password_reset_tokens', expire: 60, throttle: 0 } } },
    } as never)
    const now = new Date(Math.floor(Date.now() / 1000) * 1000)
    const tokenRecord = (id: string, expiresAt: Date) => ({
      id, provider: 'users', email: `${id}@example.test`, tokenHash: `hash-${id}`, createdAt: now, expiresAt,
    })
    const expiredId = randomUUID()
    const validId = randomUUID()
    const expired = tokenRecord(expiredId, new Date(now.getTime() - 60_000))
    const valid = tokenRecord(validId, new Date(now.getTime() + 60_000))
    await persistence.passwordResetTokens.create(expired)
    await persistence.passwordResetTokens.create(valid)

    const storedExpired = await persistence.passwordResetTokens.findById(expiredId)
    expect(storedExpired?.expiresAt.getTime()).toBe(expired.expiresAt.getTime())
    expect(storedExpired!.expiresAt.getTime() <= Date.now()).toBe(true)

    await expect(persistence.passwordResetTokens.redeem(expired, async () => 'accepted')).resolves.toBeNull()
    await expect(persistence.passwordResetTokens.redeem(valid, async () => 'accepted')).resolves.toBe('accepted')
  })
}, 30_000)

it.skipIf(!gate)('reads back a database session that expired a minute ago as expired and one that expires in a minute as live when app.timezone is America/New_York', async () => {
  await withDatabase(async (connection) => {
    await sessionsMigration.up({ db: connection, schema: createSchemaService(connection) })
    configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
    const store = createDatabaseSessionStore(createCoreDatabaseSessionAdapter('sessions', 'main'))
    const now = new Date(Math.floor(Date.now() / 1000) * 1000)
    const expiredId = randomUUID()
    const validId = randomUUID()
    const sessionRecord = (id: string, expiresAt: Date) => ({
      id, store: 'database' as const, data: { owner: id }, createdAt: now, lastActivityAt: now, expiresAt,
    })
    await store.write(sessionRecord(expiredId, new Date(now.getTime() - 60_000)))
    await store.write(sessionRecord(validId, new Date(now.getTime() + 60_000)))

    const storedExpired = await store.read(expiredId)
    expect(storedExpired?.expiresAt.getTime()).toBe(now.getTime() - 60_000)
    expect(storedExpired!.expiresAt.getTime() <= Date.now()).toBe(true)
    const storedValid = await store.read(validId)
    expect(storedValid?.expiresAt.getTime()).toBe(now.getTime() + 60_000)
    expect(storedValid!.expiresAt.getTime() > Date.now()).toBe(true)
  })
}, 30_000)
