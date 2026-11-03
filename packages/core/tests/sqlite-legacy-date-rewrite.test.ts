import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { DB, ConnectionManager, DatabaseContext, clearGeneratedTables, configureDB, createDialect, createSchemaService, holoRuntimeInternals, registerGeneratedTables, resetDB, type MigrationDefinition, type TableDefinition } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createCoreAuthPersistence } from '../src/portable/authPersistence'
import { createCoreNotificationStore } from '../src/portable/notificationPersistence'
import { createCoreDatabaseSessionAdapter } from '../src/portable/sessionPersistence'

const legacyDateColumns = {
  users: ['email_verified_at', 'created_at', 'updated_at'],
  sessions: ['created_at', 'last_activity_at', 'expires_at', 'invalidated_at'],
  auth_identities: ['created_at', 'updated_at'],
  personal_access_tokens: ['last_used_at', 'expires_at', 'created_at', 'updated_at'],
  password_reset_tokens: ['expires_at', 'used_at', 'created_at', 'updated_at'],
  email_verification_tokens: ['expires_at', 'used_at', 'created_at', 'updated_at'],
  auth_multi_factor_credentials: ['enabled_at', 'created_at', 'updated_at'],
  notifications: ['read_at', 'created_at', 'updated_at'],
  media: ['created_at', 'updated_at'],
  _holo_migrations: ['migrated_at'],
  posts: ['created_at', 'updated_at'],
  post_tag: ['created_at', 'updated_at'],
} as const

const legacyDdl = [
  'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "email_verified_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "sessions" ("id" TEXT PRIMARY KEY NOT NULL, "store" TEXT NOT NULL DEFAULT \'database\', "data" TEXT NOT NULL, "created_at" TEXT NOT NULL, "last_activity_at" TEXT NOT NULL, "expires_at" TEXT NOT NULL, "invalidated_at" TEXT)',
  'CREATE TABLE "auth_identities" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" TEXT NOT NULL, "provider" TEXT NOT NULL, "provider_user_id" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "personal_access_tokens" ("id" TEXT PRIMARY KEY NOT NULL, "provider" TEXT NOT NULL, "user_id" TEXT NOT NULL, "name" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "last_used_at" TEXT, "expires_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "password_reset_tokens" ("id" TEXT PRIMARY KEY NOT NULL, "provider" TEXT NOT NULL DEFAULT \'users\', "email" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "expires_at" TEXT NOT NULL, "used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "email_verification_tokens" ("id" TEXT PRIMARY KEY NOT NULL, "provider" TEXT NOT NULL DEFAULT \'users\', "user_id" TEXT NOT NULL, "email" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "expires_at" TEXT NOT NULL, "used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "auth_multi_factor_credentials" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "provider" TEXT NOT NULL, "user_id" TEXT NOT NULL, "enabled_at" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "notifications" ("id" TEXT PRIMARY KEY NOT NULL, "type" TEXT, "notifiable_type" TEXT NOT NULL, "notifiable_id" TEXT NOT NULL, "data" TEXT NOT NULL, "read_at" TEXT, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL)',
  'CREATE TABLE "media" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "_holo_migrations" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL UNIQUE, "batch" INTEGER NOT NULL, "migrated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "title" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "post_tag" ("post_id" INTEGER NOT NULL, "tag_id" INTEGER NOT NULL, "created_at" TEXT, "updated_at" TEXT, PRIMARY KEY ("post_id", "tag_id"))',
]

const temporaryDirectories: string[] = []

afterEach(async () => {
  resetDB()
  clearGeneratedTables()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function loadUpgradeGuideDateRewriteMigration(): Promise<MigrationDefinition> {
  const guide = await readFile(new URL('../../../apps/docs/docs/getting-started/upgrading.md', import.meta.url), 'utf8')
  const source = guide.match(/```ts \[server\/db\/migrations\/[\w]+_rewrite_sqlite_dates\.ts\]\n([\s\S]*?)```/)?.[1]
  if (!source) throw new Error('The upgrade guide has no SQLite date rewrite migration.')
  const directory = await mkdtemp(join(tmpdir(), 'holo-upgrade-guide-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'rewrite_sqlite_dates.ts')
  await writeFile(file, source)
  const module = await import(pathToFileURL(file).href) as { default: MigrationDefinition }
  return module.default
}

async function openLegacyDatabase(): Promise<DatabaseContext> {
  const connection = new DatabaseContext({
    driver: 'sqlite',
    dialect: createDialect('sqlite'),
    adapter: createSQLiteAdapter({ filename: ':memory:' }),
  })
  for (const sql of legacyDdl) {
    await connection.executeCompiled({ sql, source: 'schema' })
  }
  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
  return connection
}

async function registerTablesReadFromDatabase(connection: DatabaseContext): Promise<void> {
  const reader = holoRuntimeInternals.createSchemaReader(connection)
  const tables: Record<string, TableDefinition> = {}
  for (const tableName of Object.keys(legacyDateColumns)) {
    const table = await reader.readTable(tableName)
    if (table) tables[tableName] = table
  }
  registerGeneratedTables(tables)
}

it('redeems unexpired 0.5.x password-reset and email-verification links on SQLite without rewriting their dates, and rejects expired ones', async () => {
  await openLegacyDatabase()
  const now = new Date()
  const createdAt = new Date(now.getTime() - 3_600_000)
  const live = new Date(now.getTime() + 3_600_000)
  const expired = new Date(now.getTime() - 60_000)
  const reset = (id: string, expiresAt: Date) => ({ id, provider: 'users', email: `${id}@example.test`, tokenHash: `hash-${id}`, createdAt, expiresAt })
  const verification = (id: string, expiresAt: Date) => ({ ...reset(id, expiresAt), userId: '1' })
  for (const [id, expiresAt] of [['live', live], ['expired', expired]] as const) {
    const row = { id, email: `${id}@example.test`, token_hash: `hash-${id}`, expires_at: expiresAt.toISOString(), created_at: createdAt.toISOString(), updated_at: createdAt.toISOString() }
    await DB.table('password_reset_tokens').insert(row)
    await DB.table('email_verification_tokens').insert({ ...row, user_id: '1' })
  }
  const persistence = await createCoreAuthPersistence('/unused-project', {
    auth: { providers: {}, passwords: { users: { provider: 'users', table: 'password_reset_tokens', expire: 60, throttle: 0 } } },
  } as never)

  await expect(persistence.passwordResetTokens.redeem(reset('live', live), async () => 'reset')).resolves.toBe('reset')
  await expect(persistence.emailVerificationTokens.redeem(verification('live', live), async () => 'verified')).resolves.toBe('verified')
  await expect(persistence.passwordResetTokens.redeem(reset('expired', expired), async () => 'reset')).resolves.toBeNull()
  await expect(persistence.emailVerificationTokens.redeem(verification('expired', expired), async () => 'verified')).resolves.toBeNull()
})

it('orders notifications and sweeps sessions written by 0.5.x on SQLite after the upgrade guide rewrites every date column, including tables without an id', async () => {
  const connection = await openLegacyDatabase()
  await registerTablesReadFromDatabase(connection)
  const now = new Date(Math.floor(Date.now() / 1000) * 1000)
  const earlier = new Date(now.getTime() - 60_000)
  const later = new Date(now.getTime() + 3_600_000)
  const iso = (date: Date) => date.toISOString()
  const legacy = { created_at: iso(earlier), updated_at: iso(earlier) }
  const session = (id: string, expiresAt: Date) => ({ id, data: '{}', created_at: iso(earlier), last_activity_at: iso(earlier), expires_at: iso(expiresAt), invalidated_at: null })

  await DB.table('users').insert({ name: 'Ada', email: 'ada@example.test', email_verified_at: iso(earlier), ...legacy })
  await DB.table('sessions').insert([session('expired', earlier), session('live', later)])
  await DB.table('auth_identities').insert({ user_id: '1', provider: 'github', provider_user_id: 'ada', ...legacy })
  await DB.table('personal_access_tokens').insert({ id: 'token', provider: 'users', user_id: '1', name: 'cli', token_hash: 'pat', last_used_at: iso(earlier), expires_at: iso(later), ...legacy })
  await DB.table('password_reset_tokens').insert({ id: 'reset', email: 'ada@example.test', token_hash: 'reset-hash', expires_at: iso(later), used_at: iso(earlier), ...legacy })
  await DB.table('email_verification_tokens').insert({ id: 'verify', user_id: '1', email: 'ada@example.test', token_hash: 'verify-hash', expires_at: iso(later), ...legacy })
  await DB.table('auth_multi_factor_credentials').insert({ provider: 'users', user_id: '1', enabled_at: iso(earlier), ...legacy })
  await DB.table('notifications').insert({ id: 'before-upgrade', notifiable_type: 'users', notifiable_id: '1', data: '{}', read_at: iso(earlier), ...legacy })
  await DB.table('media').insert({ name: 'avatar', ...legacy })
  await DB.table('_holo_migrations').insert({ name: '2026_04_25_044032_create_users', batch: 1, migrated_at: iso(earlier) })
  await DB.table('posts').insert({ title: 'Hello', ...legacy })
  await DB.table('post_tag').insert({ post_id: 1, tag_id: 2, ...legacy })

  const migration = await loadUpgradeGuideDateRewriteMigration()
  await migration.up({ db: connection, schema: createSchemaService(connection) })

  const notifications = createCoreNotificationStore({ database: { defaultConnection: 'main' }, notifications: { table: 'notifications' } } as never)
  await notifications.create({ id: 'after-upgrade', notifiableType: 'users', notifiableId: '1', data: {}, createdAt: now, updatedAt: now })
  const page = await notifications.list({ recipient: { type: 'users', id: '1' } }, { limit: 10, offset: 0 })
  expect(page.records.map(record => record.id)).toEqual(['after-upgrade', 'before-upgrade'])

  await expect(createCoreDatabaseSessionAdapter('sessions', 'main').sweepExpired(now)).resolves.toBe(1)
  expect((await DB.table('sessions').get()).map(row => row.id)).toEqual(['live'])

  for (const [table, columns] of Object.entries(legacyDateColumns)) {
    for (const row of await DB.table(table).get()) {
      for (const column of columns) {
        expect({ table, column, value: row[column] }).not.toMatchObject({ value: expect.stringMatching(/T.*Z$/) })
      }
    }
  }
})
