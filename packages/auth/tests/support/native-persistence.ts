import { relative, resolve } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import { configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, resetDB } from '../../../db/src'
import { createSQLiteAdapter } from '../../../db-sqlite/src'
import { importBundledRuntimeModule } from '../../../core/src/runtimeModule'
import type { createCoreAuthPersistence as CreateCoreAuthPersistence } from '../../../core/src/portable/authPersistence'
import { normalizeAuthConfig } from '../../src/config'
import multiFactorMigration from '../../../../apps/blog-next/server/db/migrations/2026_10_11_140001_create_auth_multi_factor_credentials'
import tokenMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044035_create_personal_access_tokens'
import userMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044032_create_users'
import adminMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044031_create_admins'
import { onTestFinished } from 'vitest'
import type { HoloAuthConfig } from '../../src'
import verificationMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044037_create_email_verification_tokens'
import identityMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044034_create_auth_identities'
import passwordMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044036_create_password_reset_tokens'
import sessionRevocationMigration from '../../../../apps/blog-next/server/db/migrations/2026_10_08_000001_create_auth_session_revocations'

const projectRoot = resolve(import.meta.dirname, '../../../../apps/blog-next')
let config: ReturnType<typeof loadConfigDirectory> | undefined

type NativeAuthPersistence = Awaited<ReturnType<typeof CreateCoreAuthPersistence>> & {
  projectRoot: string
  loadedConfig: Awaited<ReturnType<typeof loadConfigDirectory>>
  adapter: ReturnType<typeof createSQLiteAdapter>
  db: ReturnType<typeof createDatabase>
  schema: ReturnType<typeof createSchemaService>
}

export async function createNativeAuthPersistence(authConfig?: HoloAuthConfig, modelsDirectory = resolve(import.meta.dirname, 'models')): Promise<NativeAuthPersistence> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  onTestFinished(async () => { resetDB(); await db.disconnect() })
  const schema = createSchemaService(db)
  await multiFactorMigration.up({ db, schema })
  await tokenMigration.up({ db, schema })
  await verificationMigration.up({ db, schema })
  await passwordMigration.up({ db, schema })
  await identityMigration.up({ db, schema })
  await sessionRevocationMigration.up({ db, schema })
  await userMigration.up({ db, schema })
  await adminMigration.up({ db, schema })
  for (const name of ['users', 'admins']) {
    await schema.table(name, table => { table.enum('role', ['admin', 'member']).default('member'); table.string('phone').nullable(); table.string('country').nullable(); table.string('dob').nullable() })
  }
  for (const name of ['users', 'admins']) await schema.table(name, table => { table.unique(['phone']) })
  config ??= loadConfigDirectory(projectRoot, { processEnv: { ...process.env, DB_DRIVER: 'sqlite', DB_URL: ':memory:', SESSION_DRIVER: 'file' }, preferCache: false })
  const loadedConfig = await config
  const auth = normalizeAuthConfig({ ...loadedConfig.auth, ...authConfig, providers: { users: { model: 'User', identifiers: ['email', 'phone'] }, admins: { model: 'Admin' } }, passwords: { ...loadedConfig.auth.passwords, ...authConfig?.passwords } })
  for (const tableName of new Set(Object.values(auth.passwords).map(broker => broker.table))) {
    if (tableName === 'password_reset_tokens') continue
    await schema.createTable(tableName, table => {
      table.uuid('id').primaryKey()
      table.string('provider').default('users')
      table.string('email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('used_at').nullable()
      table.timestamps()
      table.index(['provider'])
      table.index(['email'])
    })
  }
  const persistenceModule = importBundledRuntimeModule(projectRoot, resolve(import.meta.dirname, '../../../core/src/portable/authPersistence.ts')) as Promise<{ createCoreAuthPersistence: typeof CreateCoreAuthPersistence }>
  const { createCoreAuthPersistence } = await persistenceModule
  return {
    projectRoot,
    loadedConfig: { ...loadedConfig, auth },
    adapter,
    db,
    schema,
    ...await createCoreAuthPersistence(projectRoot, {
      ...loadedConfig,
      app: { ...loadedConfig.app, paths: { ...loadedConfig.app.paths, models: relative(projectRoot, modelsDirectory) } },
      auth,
    }),
  }
}
