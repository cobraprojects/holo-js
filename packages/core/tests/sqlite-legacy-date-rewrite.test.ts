import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { DB, ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB, type MigrationDefinition } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createCoreAuthPersistence } from '../src/portable/authPersistence'

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
} as const

const legacyDdl = [
  'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "email_verified_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "sessions" ("id" TEXT PRIMARY KEY NOT NULL, "store" TEXT NOT NULL DEFAULT \'database\', "data" TEXT NOT NULL, "created_at" TEXT NOT NULL, "last_activity_at" TEXT NOT NULL, "expires_at" TEXT NOT NULL, "invalidated_at" TEXT)',
  'CREATE TABLE "auth_identities" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" TEXT NOT NULL, "provider" TEXT NOT NULL, "provider_user_id" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "personal_access_tokens" ("id" TEXT PRIMARY KEY NOT NULL, "provider" TEXT NOT NULL, "user_id" TEXT NOT NULL, "name" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "last_used_at" TEXT, "expires_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "password_reset_tokens" ("id" TEXT PRIMARY KEY NOT NULL, "provider" TEXT NOT NULL DEFAULT \'users\', "email" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "expires_at" TEXT NOT NULL, "used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "email_verification_tokens" ("id" TEXT PRIMARY KEY NOT NULL, "provider" TEXT NOT NULL DEFAULT \'users\', "user_id" TEXT NOT NULL, "email" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "expires_at" TEXT NOT NULL, "used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "auth_multi_factor_credentials" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "provider" TEXT NOT NULL, "user_id" TEXT NOT NULL, "enabled_at" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "notifications" ("id" TEXT PRIMARY KEY NOT NULL, "notifiable_type" TEXT NOT NULL, "notifiable_id" TEXT NOT NULL, "data" TEXT NOT NULL, "read_at" TEXT, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL)',
  'CREATE TABLE "media" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "_holo_migrations" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL UNIQUE, "batch" INTEGER NOT NULL, "migrated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
]

const temporaryDirectories: string[] = []

afterEach(async () => {
  resetDB()
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

it('redeems 0.5.x password-reset and email-verification links on SQLite after the upgrade guide rewrites every framework date column', async () => {
  const connection = await openLegacyDatabase()
  const now = new Date(Math.floor(Date.now() / 1000) * 1000)
  const createdAt = new Date(now.getTime() - 60_000)
  const expiresAt = new Date(now.getTime() + 3_600_000)
  const iso = (date: Date) => date.toISOString()
  const legacy = { created_at: iso(createdAt), updated_at: iso(createdAt) }

  await DB.table('users').insert({ name: 'Ada', email: 'ada@example.test', email_verified_at: iso(createdAt), ...legacy })
  await DB.table('sessions').insert({ id: 'session', data: '{}', created_at: iso(createdAt), last_activity_at: iso(createdAt), expires_at: iso(expiresAt), invalidated_at: iso(createdAt) })
  await DB.table('auth_identities').insert({ user_id: '1', provider: 'github', provider_user_id: 'ada', ...legacy })
  await DB.table('personal_access_tokens').insert({ id: 'token', provider: 'users', user_id: '1', name: 'cli', token_hash: 'pat', last_used_at: iso(createdAt), expires_at: iso(expiresAt), ...legacy })
  await DB.table('password_reset_tokens').insert({ id: 'reset', email: 'ada@example.test', token_hash: 'reset-hash', expires_at: iso(expiresAt), used_at: null, ...legacy })
  await DB.table('password_reset_tokens').insert({ id: 'used-reset', email: 'ada@example.test', token_hash: 'used-hash', expires_at: iso(expiresAt), used_at: iso(createdAt), ...legacy })
  await DB.table('email_verification_tokens').insert({ id: 'verify', user_id: '1', email: 'ada@example.test', token_hash: 'verify-hash', expires_at: iso(expiresAt), ...legacy })
  await DB.table('auth_multi_factor_credentials').insert({ provider: 'users', user_id: '1', enabled_at: iso(createdAt), ...legacy })
  await DB.table('notifications').insert({ id: 'notice', notifiable_type: 'users', notifiable_id: '1', data: '{}', read_at: iso(createdAt), ...legacy })
  await DB.table('media').insert({ name: 'avatar', ...legacy })
  await DB.table('_holo_migrations').insert({ name: '2026_04_25_044032_create_users', batch: 1, migrated_at: iso(createdAt) })

  const migration = await loadUpgradeGuideDateRewriteMigration()
  await migration.up({ db: connection, schema: createSchemaService(connection) })

  const persistence = await createCoreAuthPersistence('/unused-project', {
    auth: { providers: {}, passwords: { users: { provider: 'users', table: 'password_reset_tokens', expire: 60, throttle: 0 } } },
  } as never)
  await expect(persistence.passwordResetTokens.redeem({
    id: 'reset', provider: 'users', email: 'ada@example.test', tokenHash: 'reset-hash', createdAt, expiresAt,
  }, async () => 'reset')).resolves.toBe('reset')
  await expect(persistence.emailVerificationTokens.redeem({
    id: 'verify', provider: 'users', userId: '1', email: 'ada@example.test', tokenHash: 'verify-hash', createdAt, expiresAt,
  }, async () => 'verified')).resolves.toBe('verified')

  for (const [table, columns] of Object.entries(legacyDateColumns)) {
    for (const row of await DB.table(table).get()) {
      for (const column of columns) {
        expect({ table, column, value: row[column] }).not.toMatchObject({ value: expect.stringMatching(/T.*Z$/) })
      }
    }
  }
})
