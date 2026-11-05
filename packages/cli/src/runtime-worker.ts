import { fileURLToPath } from 'node:url'
import { writeSync } from 'node:fs'
import { writeTextFile } from './project/atomic-file'
import { bundleSourceInternals, initializeHolo } from '@holo-js/core'
import {
  configureDB,
  createMigrationService,
  createSchemaService,
  createSeederService,
  holoRuntimeInternals,
  registerGeneratedTables,
  renderGeneratedSchemaModule,
  renderGeneratedSchemaRuntimeModule,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
  type DatabaseContext,
  type TableDefinition,
} from '@holo-js/db'
import { loadProjectDatabaseDrivers } from './database-drivers'
import { errorMessage } from './error-message'
import { runWithMigrationLock } from './migration-lock'
import { isSchemaChangingKind } from './runtime-kinds'
import { RUNTIME_FAILURE_FD } from './runtime-failure'
import { resolveProjectPackageImportSpecifier } from './project'
import { regenerateMediaConversions, type MediaRegenerationOptions } from './media-regeneration'
import type * as MediaModule from '@holo-js/media'
import type * as StorageRuntimeModule from '@holo-js/storage/runtime'

type RuntimeConfigPayload = Parameters<typeof resolveRuntimeConnectionManagerOptions>[0]

type RuntimeModuleEntry = {
  readonly sourcePath: string
  readonly url: string
  readonly importers: Readonly<Record<string, string>>
}

type RuntimePayload = {
  readonly kind?: string
  readonly projectRoot?: string
  readonly runtimeConfig?: RuntimeConfigPayload
  readonly models?: readonly RuntimeModuleEntry[]
  readonly migrations?: readonly RuntimeModuleEntry[]
  readonly migrationPublishers?: readonly {
    readonly packageName: string
    readonly url: string
  }[]
  readonly seeders?: readonly RuntimeModuleEntry[]
  readonly generatedSchemaOutputPath?: string
  readonly generatedSchemaRuntimeOutputPath?: string
  readonly options?: Record<string, unknown>
}

type RuntimeMigration = Record<string, unknown> & {
  readonly name: string
  up(...args: unknown[]): unknown
}

type RuntimeSeeder = {
  readonly name: string
  run(...args: unknown[]): unknown
}

type RuntimeModel = {
  readonly definition: {
    readonly name: string
    readonly morphClass?: string
    readonly kind: 'model'
    readonly prunable?: boolean
  }
  prune(): Promise<number> | number
}

type FreshDropConnection = {
  getDialect(): {
    name: string
    quoteIdentifier(identifier: string): string
  }
  queryCompiled<TRow extends Record<string, unknown>>(statement: { sql: string, source: string }): Promise<{ rows: TRow[] }>
  executeCompiled(statement: { sql: string, source: string }): Promise<unknown>
}

type FreshDropSchema = {
  getTables(): Promise<string[]>
  dropTable(tableName: string): Promise<void>
  withoutForeignKeyConstraints<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
}


async function readRuntimePayload(): Promise<RuntimePayload> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }

  const input = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(input.length > 0 ? input : '{}') as RuntimePayload
}

process.on('uncaughtException', (error) => {
  writeSync(RUNTIME_FAILURE_FD, errorMessage(error))
  process.exitCode = 1
})

const payload = await readRuntimePayload()

if (typeof payload.projectRoot === 'string') {
  process.chdir(payload.projectRoot)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function loadModule(path: string): Promise<unknown> {
  return import(`${path}?t=${Date.now()}`)
}

async function loadBundledModule(entry: RuntimeModuleEntry): Promise<unknown> {
  return bundleSourceInternals.importBundle(
    { path: fileURLToPath(entry.url), sourcePath: entry.sourcePath, importers: entry.importers },
    url => import(url),
  )
}

function resolveExport<TValue>(
  moduleValue: unknown,
  matcher: (value: unknown) => value is TValue,
): TValue | undefined {
  if (isRecord(moduleValue) && matcher(moduleValue.default)) {
    return moduleValue.default
  }

  if (isRecord(moduleValue)) {
    for (const value of Object.values(moduleValue)) {
      if (matcher(value)) {
        return value
      }
    }
  }

  return undefined
}

function isModel(value: unknown): value is RuntimeModel {
  return isRecord(value)
    && isRecord(value.definition)
    && value.definition.kind === 'model'
    && typeof value.definition.name === 'string'
    && typeof value.prune === 'function'
}

function isMigration(value: unknown): value is RuntimeMigration {
  return isRecord(value) && typeof value.up === 'function'
}

function isSeeder(value: unknown): value is RuntimeSeeder {
  return isRecord(value) && typeof value.name === 'string' && typeof value.run === 'function'
}

const RUNTIME_MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/

function inferRuntimeMigrationName(sourcePath: string): string {
  const fileName = sourcePath.split('/').pop()?.replace(/\.[^.]+$/, '')
  if (!fileName || !RUNTIME_MIGRATION_NAME_PATTERN.test(fileName)) {
    throw new Error(`Registered migration "${sourcePath}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`)
  }

  return fileName
}

async function dropAllTablesForFresh(
  connection: FreshDropConnection,
  schema: FreshDropSchema,
): Promise<void> {
  const tables = await schema.getTables()
  if (connection.getDialect().name === 'postgres') {
    const { quoteIdentifier } = connection.getDialect()
    const current = await connection.queryCompiled<{ schema: string }>({ sql: 'SELECT current_schema() AS schema', source: 'schema:currentSchema' })
    const schemaName = current.rows[0]?.schema
    if (!schemaName) return

    for (const tableName of tables) {
      await connection.executeCompiled({
        sql: `DROP TABLE IF EXISTS ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} CASCADE`,
        source: `schema:dropTableFresh:${schemaName}.${tableName}`,
      })
    }
    return
  }

  await schema.withoutForeignKeyConstraints(async () => {
    for (const tableName of tables) {
      await schema.dropTable(tableName)
    }
  })
}

async function isDatabaseMissing(connection: DatabaseContext): Promise<boolean> {
  const adapter = connection.getAdapter()
  return typeof adapter.databaseExists === 'function' && !await adapter.databaseExists()
}

async function readDatabaseSchema(connection: DatabaseContext): Promise<TableDefinition[]> {
  try {
    if (await isDatabaseMissing(connection)) {
      throw new Error('the database does not exist. Run "holo migrate" to create it.')
    }
    await connection.initialize()
    return await holoRuntimeInternals.createSchemaReader(connection).readGeneratedSchema()
  } catch (error) {
    throw new Error(`Unable to read the database schema of connection "${connection.getConnectionName()}": ${errorMessage(error)}`, { cause: error })
  }
}

async function writeGeneratedSchema(
  manager: ReturnType<typeof resolveRuntimeConnectionManagerOptions>,
  outputPath: string | undefined,
  runtimeOutputPath: string | undefined,
): Promise<void> {
  const tables = await readDatabaseSchema(manager.connection())
  registerGeneratedTables(Object.fromEntries(tables.map(table => [table.tableName, table])))
  if (outputPath) {
    await writeTextFile(outputPath, renderGeneratedSchemaModule(tables))
  }
  if (runtimeOutputPath) {
    await writeTextFile(runtimeOutputPath, renderGeneratedSchemaRuntimeModule(tables))
  }
}

async function loadRuntimeItem<TValue>(
  entry: RuntimeModuleEntry,
  matcher: (value: unknown) => value is TValue,
  label: string,
): Promise<TValue> {
  const item = resolveExport(await loadBundledModule(entry), matcher)
  if (!item) {
    throw new Error(`Registered ${label} "${entry.sourcePath}" does not export a Holo ${label}.`)
  }
  return item
}

async function loadRuntimeItems<TValue>(
  entries: readonly RuntimeModuleEntry[],
  matcher: (value: unknown) => value is TValue,
  label: string,
): Promise<TValue[]> {
  const items: TValue[] = []
  for (const entry of entries) {
    items.push(await loadRuntimeItem(entry, matcher, label))
  }
  return items
}

async function loadMigrations(entries: readonly RuntimeModuleEntry[]): Promise<RuntimeMigration[]> {
  const migrations: RuntimeMigration[] = []
  for (const entry of entries) {
    const migration = await loadRuntimeItem(entry, isMigration, 'migration')
    migrations.push({
      ...migration,
      name: typeof migration.name === 'string' ? migration.name : inferRuntimeMigrationName(entry.sourcePath),
    })
  }
  return migrations
}

async function loadPublishedMigrations(
  publishers: RuntimePayload['migrationPublishers'],
): Promise<RuntimeMigration[]> {
  const migrations: RuntimeMigration[] = []
  for (const publisher of publishers ?? []) {
    const loaded = await loadModule(publisher.url)
    const candidate = isRecord(loaded) && Array.isArray(loaded.migrations)
      ? loaded.migrations
      : isRecord(loaded) && Array.isArray(loaded.default)
        ? loaded.default
        : undefined
    if (!candidate) {
      throw new Error(`Plugin ${publisher.packageName} migration publisher must export a migrations array.`)
    }

    for (const migration of candidate) {
      if (!isMigration(migration) || typeof migration.name !== 'string' || !migration.name.trim()) {
        throw new Error(`Plugin ${publisher.packageName} migrations must define explicit stable names and up handlers.`)
      }
      migrations.push({ ...migration, name: migration.name.trim() })
    }
  }
  return migrations
}

function assertUniqueMigrationNames(migrations: readonly RuntimeMigration[]): void {
  const names = new Set<string>()
  for (const migration of migrations) {
    if (names.has(migration.name)) throw new Error(`Duplicate migration name: ${migration.name}.`)
    names.add(migration.name)
  }
}

async function loadAllMigrations(): Promise<RuntimeMigration[]> {
  const migrations = [
    ...await loadMigrations(payloadEntries(payload.migrations)),
    ...await loadPublishedMigrations(payload.migrationPublishers),
  ]
  assertUniqueMigrationNames(migrations)
  return migrations
}

async function loadSeeders(entries: readonly RuntimeModuleEntry[]): Promise<RuntimeSeeder[]> {
  return loadRuntimeItems(entries, isSeeder, 'seeder')
}

function printExecutedItems(
  items: readonly { readonly name: string }[],
  emptyMessage: string,
  header: string,
): void {
  if (items.length === 0) {
    writeOutput(emptyMessage)
    return
  }

  writeOutput(header)
  for (const item of items) {
    writeOutput(`  ${item.name}`)
  }
}

function payloadEntries(entries: readonly RuntimeModuleEntry[] | undefined): readonly RuntimeModuleEntry[] {
  return entries ?? []
}

function resolveRuntimeConfig(runtimeConfig: RuntimeConfigPayload | undefined): RuntimeConfigPayload {
  if (!runtimeConfig) {
    throw new Error('Runtime payload is missing database configuration.')
  }

  return runtimeConfig
}

function writeOutput(message: string): void {
  process.stdout.write(`${message}\n`)
}

const resolvedRuntimeConfig = resolveRuntimeConfig(payload.runtimeConfig)
const projectRoot = payload.projectRoot ?? process.cwd()
const applicationRuntime = payload.kind === 'seed' || payload.kind === 'media:regenerate'
  ? await initializeHolo(projectRoot)
  : undefined
const manager = applicationRuntime?.manager ?? resolveRuntimeConnectionManagerOptions(resolvedRuntimeConfig)
if (!applicationRuntime) {
  await loadProjectDatabaseDrivers(projectRoot, resolvedRuntimeConfig.db, {
    createMissingDatabases: payload.kind === 'migrate' || payload.kind === 'fresh',
  })
  configureDB(manager)
}
const writeProjectGeneratedSchema = () => writeGeneratedSchema(manager, payload.generatedSchemaOutputPath, payload.generatedSchemaRuntimeOutputPath)

async function writeGeneratedSchemaAfterFailedRun(failure: unknown): Promise<unknown> {
  try {
    await writeProjectGeneratedSchema()
    return failure
  } catch (error) {
    return new Error(`${errorMessage(failure)}\nUnable to write the Generated schema after the failed run: ${errorMessage(error)}`, { cause: failure })
  }
}

async function changeSchema<TResult>(change: () => Promise<TResult>): Promise<TResult> {
  const result = await change().catch(async (error: unknown) => {
    throw await writeGeneratedSchemaAfterFailedRun(error)
  })
  await writeProjectGeneratedSchema()
  return result
}
const migrations = isSchemaChangingKind(payload.kind)
  ? await loadAllMigrations()
  : []

try {
  if (!applicationRuntime && payload.kind !== 'generate-schema') {
    await manager.initializeAll()
  }

  if (payload.kind === 'migrate') {
    const migrate = () => changeSchema(() => createMigrationService(manager.connection(), migrations).migrate(payload.options ?? {}))
    const run = payload.options?.isolated === true
      ? await runWithMigrationLock(projectRoot, migrate)
      : { kind: 'ran' as const, result: await migrate() }
    if (run.kind === 'skipped') {
      writeOutput('Another migration run holds the migration lock; no migrations were executed.')
    } else {
      printExecutedItems(run.result, 'No migrations were executed.', 'Migrations executed:')
    }
  } else if (payload.kind === 'generate-schema') {
    await writeProjectGeneratedSchema()
    writeOutput('Generated schema written from the database.')
  } else if (payload.kind === 'fresh') {
    const executed = await changeSchema(async () => {
      await dropAllTablesForFresh(manager.connection(), createSchemaService(manager.connection()))
      return createMigrationService(manager.connection(), migrations).migrate({})
    })
    printExecutedItems(executed, 'No migrations were executed.', 'Migrations executed:')
  } else if (payload.kind === 'rollback') {
    const rolledBack = await changeSchema(() => createMigrationService(manager.connection(), migrations).rollback(payload.options ?? {}))
    printExecutedItems(rolledBack, 'No migrations were rolled back.', 'Migrations rolled back:')
  } else if (payload.kind === 'seed') {
    const executed = await createSeederService(manager.connection(), await loadSeeders(payloadEntries(payload.seeders))).seed(payload.options ?? {})
    printExecutedItems(executed, 'No seeders were executed.', 'Seeders executed:')
  } else if (payload.kind === 'media:regenerate') {
    const media = await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/media')) as typeof MediaModule
    const { Storage } = await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/storage/runtime')) as typeof StorageRuntimeModule
    const models = await loadRuntimeItems(payloadEntries(payload.models), isModel, 'model')
    const result = await regenerateMediaConversions(
      { media, storage: Storage },
      models.map(model => model.definition),
      payload.options as MediaRegenerationOptions,
    )
    writeOutput(`Media regenerated: ${result.regenerated}; skipped: ${result.skipped}`)
  } else if (payload.kind === 'prune') {
    const models = await loadRuntimeItems(payloadEntries(payload.models), isModel, 'model')
    const byName = new Map(models.map(model => [model.definition.name, model]))
    const requested = Array.isArray(payload.options?.models) ? payload.options.models : []
    const selected: RuntimeModel[] = []

    if (requested.length === 0) {
      selected.push(...models.filter(model => Boolean(model.definition.prunable)))
    } else {
      for (const name of requested) {
        if (typeof name !== 'string') {
          console.warn(`Ignoring non-string prunable model name: ${JSON.stringify(name)}`)
          continue
        }

        const model = byName.get(name)
        if (!model) {
          throw new Error(`Unknown model "${name}".`)
        }
        if (!model.definition.prunable) {
          throw new Error(`Model "${name}" does not define a prunable query.`)
        }
        selected.push(model)
      }
    }

    if (selected.length === 0) {
      writeOutput('No prunable models were registered.')
    } else {
      let total = 0
      for (const model of selected) {
        const deleted = await model.prune()
        total += deleted
        writeOutput(`${model.definition.name}: deleted ${deleted}`)
      }
      writeOutput(`Total deleted: ${total}`)
    }
  } else {
    throw new Error(`Unknown runtime command "${payload.kind}".`)
  }
} finally {
  if (applicationRuntime) {
    await applicationRuntime.shutdown()
  } else {
    await manager.disconnectAll()
    resetDB()
  }
}
