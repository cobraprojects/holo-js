import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  configureDB,
  createMigrationService,
  createSchemaService,
  createSeederService,
  registerGeneratedTables,
  renderGeneratedSchemaModule,
  renderGeneratedSchemaRuntimeModule,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
  type TableDefinition,
} from '@holo-js/db'

type RuntimeConfigPayload = Parameters<typeof resolveRuntimeConnectionManagerOptions>[0]

type RuntimePayload = {
  readonly kind?: string
  readonly projectRoot?: string
  readonly runtimeConfig?: RuntimeConfigPayload
  readonly models?: readonly string[]
  readonly migrations?: readonly string[]
  readonly seeders?: readonly string[]
  readonly generatedSchema?: string
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
  getSchemaName(): string | undefined
  executeCompiled(statement: { sql: string, source: string }): Promise<unknown>
}

type FreshDropSchema = {
  getTables(): Promise<string[]>
  dropTable(tableName: string): Promise<void>
  withoutForeignKeyConstraints<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
}

type DryRunSchemaConnection = {
  getDialect(): ReturnType<ReturnType<typeof resolveRuntimeConnectionManagerOptions>['connection']>['getDialect'] extends () => infer TDialect ? TDialect : never
  getCapabilities(): ReturnType<ReturnType<typeof resolveRuntimeConnectionManagerOptions>['connection']>['getCapabilities'] extends () => infer TCapabilities ? TCapabilities : never
  getSchemaName(): string | undefined
  getSchemaRegistry(): ReturnType<ReturnType<typeof resolveRuntimeConnectionManagerOptions>['connection']>['getSchemaRegistry'] extends () => infer TRegistry ? TRegistry : never
  executeCompiled(): Promise<undefined>
  introspectCompiled(): Promise<{ rows: never[], rowCount: 0 }>
  transaction<TResult>(callback: (connection: DryRunSchemaConnection) => TResult | Promise<TResult>): Promise<TResult>
}

const payload = JSON.parse(process.env.HOLO_RUNTIME_PAYLOAD ?? '{}') as RuntimePayload

if (typeof payload.projectRoot === 'string') {
  process.chdir(payload.projectRoot)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function loadModule(path: string): Promise<unknown> {
  return import(`${path}?t=${Date.now()}`)
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

function isTable(value: unknown): value is TableDefinition {
  return isRecord(value)
    && value.kind === 'table'
    && typeof value.tableName === 'string'
    && isRecord(value.columns)
    && Array.isArray(value.indexes)
}

function extractTables(moduleValue: unknown): TableDefinition[] {
  if (isRecord(moduleValue) && isRecord(moduleValue.tables)) {
    return Object.values(moduleValue.tables).filter(isTable)
  }

  if (isRecord(moduleValue) && isTable(moduleValue.default)) {
    return [moduleValue.default]
  }

  if (isRecord(moduleValue)) {
    return Object.values(moduleValue).filter(isTable)
  }

  return []
}

const RUNTIME_MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/

function inferRuntimeMigrationName(entry: string): string {
  const fileName = entry.split('/').pop()?.replace(/\.[^.]+$/, '')
  if (!fileName || !RUNTIME_MIGRATION_NAME_PATTERN.test(fileName)) {
    throw new Error(`Registered migration "${entry}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`)
  }

  return fileName
}

function normalizeRuntimeMigration(
  entry: string,
  migration: RuntimeMigration,
): RuntimeMigration {
  return {
    ...migration,
    name: typeof migration.name === 'string' ? migration.name : inferRuntimeMigrationName(entry),
  }
}

function compileFreshDropIdentifierPath(
  quoteIdentifier: (identifier: string) => string,
  identifier: string,
): string {
  if (!identifier.includes('.')) {
    return quoteIdentifier(identifier)
  }

  return identifier
    .split('.')
    .map(part => quoteIdentifier(part))
    .join('.')
}

async function dropAllTablesForFresh(
  connection: FreshDropConnection,
  schema: FreshDropSchema,
): Promise<void> {
  const tables = await schema.getTables()
  if (connection.getDialect().name === 'postgres') {
    const schemaName = connection.getSchemaName()
    const quoteIdentifier = connection.getDialect().quoteIdentifier

    for (const tableName of tables) {
      const qualifiedTableName = schemaName ? `${schemaName}.${tableName}` : tableName
      await connection.executeCompiled({
        sql: `DROP TABLE IF EXISTS ${compileFreshDropIdentifierPath(quoteIdentifier, qualifiedTableName)} CASCADE`,
        source: `schema:dropTableFresh:${qualifiedTableName}`,
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

async function preloadGeneratedSchema(
  manager: ReturnType<typeof resolveRuntimeConnectionManagerOptions>,
  entry: string | undefined,
): Promise<void> {
  if (!entry) {
    return
  }

  const tables = extractTables(await loadModule(entry))
  for (const table of tables) {
    manager.connection().getSchemaRegistry().replace(table)
  }
}

async function writeGeneratedSchemaArtifact(
  manager: ReturnType<typeof resolveRuntimeConnectionManagerOptions>,
  outputPath: string | undefined,
  runtimeOutputPath: string | undefined,
): Promise<void> {
  if (!outputPath && !runtimeOutputPath) {
    return
  }

  const tables = manager.connection().getSchemaRegistry().list()
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, renderGeneratedSchemaModule(tables), 'utf8')
  }
  if (runtimeOutputPath) {
    await mkdir(dirname(runtimeOutputPath), { recursive: true })
    await writeFile(runtimeOutputPath, renderGeneratedSchemaRuntimeModule(tables), 'utf8')
  }
}

function syncGeneratedSchemaFromManager(
  manager: ReturnType<typeof resolveRuntimeConnectionManagerOptions>,
): void {
  registerGeneratedTables(Object.fromEntries(
    manager.connection().getSchemaRegistry().list().map(table => [table.tableName, table]),
  ))
}

async function hydrateGeneratedSchemaFromRanMigrations(
  manager: ReturnType<typeof resolveRuntimeConnectionManagerOptions>,
  migrations: readonly RuntimeMigration[],
): Promise<void> {
  const migrationService = createMigrationService(manager.connection(), migrations)
  const ranNames = new Set(
    (await migrationService.status())
      .filter(status => status.status === 'ran')
      .map(status => status.name),
  )

  if (ranNames.size === 0) {
    return
  }

  const realConnection = manager.connection()
  const dryRunConnection: DryRunSchemaConnection = {
    getDialect: () => realConnection.getDialect(),
    getCapabilities: () => realConnection.getCapabilities(),
    getSchemaName: () => realConnection.getSchemaName(),
    getSchemaRegistry: () => realConnection.getSchemaRegistry(),
    executeCompiled: async () => undefined,
    introspectCompiled: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <TResult>(callback: (connection: typeof dryRunConnection) => TResult | Promise<TResult>) => callback(dryRunConnection),
  }
  const schema = createSchemaService(dryRunConnection as never)

  for (const migration of [...migrations].sort((left, right) => left.name.localeCompare(right.name))) {
    if (ranNames.has(migration.name)) {
      await migration.up({ db: dryRunConnection, schema } as never)
    }
  }
}

async function loadRuntimeItems<TValue>(
  entries: readonly string[],
  matcher: (value: unknown) => value is TValue,
  label: string,
): Promise<TValue[]> {
  const items: TValue[] = []

  for (const entry of entries) {
    const item = resolveExport(await loadModule(entry), matcher)
    if (!item) {
      throw new Error(`Registered ${label} "${entry}" does not export a Holo ${label}.`)
    }
    items.push(item)
  }

  return items
}

async function loadMigrations(entries: readonly string[]): Promise<RuntimeMigration[]> {
  const migrations = await loadRuntimeItems(entries, isMigration, 'migration')
  return migrations.map((migration, index) => normalizeRuntimeMigration(entries[index] ?? '', migration))
}

async function loadSeeders(entries: readonly string[]): Promise<RuntimeSeeder[]> {
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

function payloadEntries(entries: readonly string[] | undefined): readonly string[] {
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

const manager = resolveRuntimeConnectionManagerOptions(resolveRuntimeConfig(payload.runtimeConfig))
configureDB(manager)

try {
  await manager.initializeAll()

  if (payload.kind === 'migrate') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const migrations = await loadMigrations(payloadEntries(payload.migrations))
    await hydrateGeneratedSchemaFromRanMigrations(manager, migrations)
    const executed = await createMigrationService(manager.connection(), migrations).migrate(payload.options ?? {})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath, payload.generatedSchemaRuntimeOutputPath)
    printExecutedItems(executed, 'No migrations were executed.', 'Migrations executed:')
  } else if (payload.kind === 'fresh') {
    const migrations = await loadMigrations(payloadEntries(payload.migrations))
    const schema = createSchemaService(manager.connection())
    await dropAllTablesForFresh(manager.connection(), schema)
    manager.connection().getSchemaRegistry().clear()

    const executed = await createMigrationService(manager.connection(), migrations).migrate({})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath, payload.generatedSchemaRuntimeOutputPath)
    syncGeneratedSchemaFromManager(manager)
    printExecutedItems(executed, 'No migrations were executed.', 'Migrations executed:')

    if (payload.options?.seed) {
      const seeded = await createSeederService(manager.connection(), await loadSeeders(payloadEntries(payload.seeders))).seed({
        ...(Array.isArray(payload.options.only) ? { only: payload.options.only } : {}),
        quietly: payload.options.quietly === true,
        force: payload.options.force === true,
        environment: typeof payload.options.environment === 'string' ? payload.options.environment : 'development',
      })
      printExecutedItems(seeded, 'No seeders were executed.', 'Seeders executed:')
    }
  } else if (payload.kind === 'rollback') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const migrations = await loadMigrations(payloadEntries(payload.migrations))
    await hydrateGeneratedSchemaFromRanMigrations(manager, migrations)
    const rolledBack = await createMigrationService(manager.connection(), migrations).rollback(payload.options ?? {})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath, payload.generatedSchemaRuntimeOutputPath)
    printExecutedItems(rolledBack, 'No migrations were rolled back.', 'Migrations rolled back:')
  } else if (payload.kind === 'seed') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const executed = await createSeederService(manager.connection(), await loadSeeders(payloadEntries(payload.seeders))).seed(payload.options ?? {})
    printExecutedItems(executed, 'No seeders were executed.', 'Seeders executed:')
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
  await manager.disconnectAll()
  resetDB()
}
