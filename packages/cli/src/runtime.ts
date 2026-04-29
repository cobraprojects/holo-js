import { spawnSync } from 'node:child_process'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeConfigCache } from '@holo-js/config'
import {
  bundleProjectModule,
  loadProjectConfig,
  loadGeneratedProjectRegistry,
  prepareProjectDiscovery,
  resolveGeneratedSchemaPath,
  CLI_RUNTIME_ROOT,
} from './project'
import { fileExists } from './fs-utils'
import type { RuntimeEnvironment, RuntimeSpawnResult, RuntimeMigrationCandidate, ProjectRuntimeInitializationOptions } from './cli-types'
import type { HoloRuntime } from '@holo-js/core'

const runtimeImportMeta = import.meta as ImportMeta & {
  resolve?: (specifier: string) => string
}

export function resolveConfigModuleUrl(
  /* v8 ignore next */
  runtimeResolve: ((specifier: string) => string) | undefined = runtimeImportMeta.resolve?.bind(runtimeImportMeta),
): string {
  if (typeof runtimeResolve === 'function') {
    const resolved = runtimeResolve('@holo-js/config')

    if (resolved.startsWith('file://')) {
      const resolvedPath = fileURLToPath(resolved)
      const normalized = resolvedPath.replace(/\\/g, '/')
      if (normalized.endsWith('/src/index.ts') || normalized.endsWith('/src/index.mts') || normalized.endsWith('/src/index.js') || normalized.endsWith('/src/index.mjs')) {
        return pathToFileURL(resolve(dirname(dirname(resolvedPath)), 'dist/index.mjs')).href
      }
    }

    return resolved
  }

  return pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/@holo-js/config/dist/index.mjs')).href
}

export async function initializeProjectRuntime(
  projectRoot: string,
  options: ProjectRuntimeInitializationOptions = {},
): Promise<HoloRuntime> {
  const { initializeHolo } = await import('@holo-js/core')
  return initializeHolo(projectRoot, options)
}

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

export async function cacheProjectConfig(
  projectRoot: string,
  cacheWriter: typeof writeConfigCache = writeConfigCache,
): Promise<string> {
  try {
    return await cacheWriter(projectRoot, { processEnv: process.env })
  } catch (error) {
    throw new Error(error instanceof Error && error.message ? error.message : 'Failed to cache config.')
  }
}

export function createEnvRuntimeConfig() {
  return {
    db: {
      defaultConnection: 'default',
      connections: {
        default: {
          driver: process.env.DB_DRIVER,
          url: process.env.DB_URL,
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE,
          schema: process.env.DB_SCHEMA,
          ssl: parseBooleanEnv(process.env.DB_SSL),
          logging: parseBooleanEnv(process.env.DB_LOGGING),
        },
      },
    },
  }
}

export function normalizeRuntimeConnectionInput(
  connection: object | string | undefined,
): Record<string, unknown> {
  if (typeof connection === 'string') {
    return { url: connection }
  }

  return connection ? { ...(connection as Record<string, unknown>) } : {}
}

export function isDefined(value: unknown): boolean {
  return value !== undefined
}

export function filterDefinedRuntimeConnectionInput(
  connection: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(connection).filter(([, value]) => isDefined(value)),
  )
}

export function mergeRuntimeDatabaseConfig(
  config: {
    defaultConnection?: string
    connections?: Record<string, object | string>
  } | undefined,
  envRuntimeConfig: ReturnType<typeof createEnvRuntimeConfig>,
) {
  const envDefault = envRuntimeConfig.db.connections.default
  const hasEnvOverrides = Object.values(envDefault).some(isDefined)

  if (!config) {
    return envRuntimeConfig.db
  }

  if (!hasEnvOverrides) {
    return config
  }

  const defaultConnection = config.defaultConnection ?? 'default'
  const connections = { ...(config.connections ?? {}) }
  connections[defaultConnection] = {
    ...normalizeRuntimeConnectionInput(connections[defaultConnection]),
    ...filterDefinedRuntimeConnectionInput(envDefault),
  }

  return {
    ...config,
    defaultConnection,
    connections,
  }
}

export const RUNTIME_MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/

export function inferRuntimeMigrationName(entry: string): string {
  const fileName = entry.split('/').pop()?.replace(/\.[^.]+$/, '')
  if (!fileName || !RUNTIME_MIGRATION_NAME_PATTERN.test(fileName)) {
    throw new Error(`Registered migration "${entry}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`)
  }

  return fileName
}

export function normalizeRuntimeMigration(
  entry: string,
  migration: RuntimeMigrationCandidate & Record<string, unknown>,
): Record<string, unknown> & { name: string, up(...args: unknown[]): unknown } {
  return {
    ...migration,
    name: typeof migration.name === 'string' ? migration.name : inferRuntimeMigrationName(entry),
  }
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

export function compileFreshDropIdentifierPath(
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

export async function dropAllTablesForFresh(
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

/* v8 ignore start */
export async function getRuntimeEnvironment(projectRoot: string): Promise<RuntimeEnvironment> {
  let project = await loadProjectConfig(projectRoot, { required: true })
  if (!await loadGeneratedProjectRegistry(projectRoot)) {
    await prepareProjectDiscovery(projectRoot, project.config)
    project = await loadProjectConfig(projectRoot, { required: true })
  }
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, project.config)
  const hasGeneratedSchema = await fileExists(generatedSchemaPath)
  const bundleInputs = [
    ...project.config.models.map(entry => resolve(projectRoot, entry)),
    ...project.config.migrations.map(entry => resolve(projectRoot, entry)),
    ...project.config.seeders.map(entry => resolve(projectRoot, entry)),
    ...(hasGeneratedSchema ? [generatedSchemaPath] : []),
  ]
  const bundled: Array<Awaited<ReturnType<typeof bundleProjectModule>>> = []

  try {
    for (const entryPath of bundleInputs) {
      bundled.push(await bundleProjectModule(projectRoot, entryPath, { external: ['@holo-js/db'] }))
    }
  } catch (error) {
    await Promise.all(bundled.map(entry => entry.cleanup()))
    throw error
  }

  const bundledModels = bundled.slice(0, project.config.models.length).map(entry => entry.path)
  const bundledMigrations = bundled
    .slice(project.config.models.length, project.config.models.length + project.config.migrations.length)
    .map(entry => entry.path)
  const bundledSeeders = bundled
    .slice(project.config.models.length + project.config.migrations.length)
    .slice(0, project.config.seeders.length)
    .map(entry => entry.path)
  const bundledGeneratedSchema = hasGeneratedSchema
    ? bundled[project.config.models.length + project.config.migrations.length + project.config.seeders.length]?.path
    : undefined

  return {
    project,
    bundledModels,
    bundledMigrations,
    bundledSeeders,
    ...(bundledGeneratedSchema ? { bundledGeneratedSchema } : {}),
    async cleanup() {
      await Promise.all(bundled.map(entry => entry.cleanup()))
    },
  }
}
/* v8 ignore stop */

/* v8 ignore start */
export const nodeRuntimeScript = `
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  configureDB,
  createSchemaService,
  createMigrationService,
  createSeederService,
  renderGeneratedSchemaModule,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
} from '@holo-js/db'

const payload = JSON.parse(process.env.HOLO_RUNTIME_PAYLOAD ?? '{}')
process.chdir(payload.projectRoot)

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function loadModule(path) {
  return import(\`\${path}?t=\${Date.now()}\`)
}

function resolveExport(moduleValue, matcher) {
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

const isModel = (value) => isRecord(value) && isRecord(value.definition) && value.definition.kind === 'model' && typeof value.prune === 'function'
const isMigration = (value) => isRecord(value) && typeof value.up === 'function'
const isSeeder = (value) => isRecord(value) && typeof value.name === 'string' && typeof value.run === 'function'
const isTable = (value) => isRecord(value) && value.kind === 'table' && typeof value.tableName === 'string' && isRecord(value.columns)
const RUNTIME_MIGRATION_NAME_PATTERN = ${RUNTIME_MIGRATION_NAME_PATTERN}
const inferRuntimeMigrationName = ${inferRuntimeMigrationName.toString()}
const normalizeRuntimeMigration = ${normalizeRuntimeMigration.toString()}
const compileFreshDropIdentifierPath = ${compileFreshDropIdentifierPath.toString()}
const dropAllTablesForFresh = ${dropAllTablesForFresh.toString()}

function extractTables(moduleValue) {
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

async function preloadGeneratedSchema(manager, entry) {
  if (!entry) {
    return
  }

  const tables = extractTables(await loadModule(entry))
  for (const table of tables) {
    manager.connection().getSchemaRegistry().replace(table)
  }
}

async function writeGeneratedSchemaArtifact(manager, outputPath) {
  if (!outputPath) {
    return
  }

  const source = renderGeneratedSchemaModule(manager.connection().getSchemaRegistry().list())
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, source, 'utf8')
}

const manager = resolveRuntimeConnectionManagerOptions(payload.runtimeConfig)
configureDB(manager)

try {
  await manager.initializeAll()

  if (payload.kind === 'migrate') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const migrations = []
    for (const entry of payload.migrations) {
      const migration = resolveExport(await loadModule(entry), isMigration)
      if (!migration) {
        throw new Error(\`Registered migration "\${entry}" does not export a Holo migration.\`)
      }
      migrations.push(normalizeRuntimeMigration(entry, migration))
    }

    const executed = await createMigrationService(manager.connection(), migrations).migrate(payload.options ?? {})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath)
    if (executed.length === 0) {
      console.log('No migrations were executed.')
    } else {
      console.log(\`Migrations executed: \${executed.map(item => item.name).join(', ')}\`)
    }
  } else if (payload.kind === 'fresh') {
    const migrations = []
    for (const entry of payload.migrations) {
      const migration = resolveExport(await loadModule(entry), isMigration)
      if (!migration) {
        throw new Error(\`Registered migration "\${entry}" does not export a Holo migration.\`)
      }
      migrations.push(normalizeRuntimeMigration(entry, migration))
    }

    const schema = createSchemaService(manager.connection())
    await dropAllTablesForFresh(manager.connection(), schema)
    manager.connection().getSchemaRegistry().clear()

    const executed = await createMigrationService(manager.connection(), migrations).migrate({})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath)
    await preloadGeneratedSchema(manager, pathToFileURL(payload.generatedSchemaOutputPath).href)
    if (executed.length === 0) {
      console.log('No migrations were executed.')
    } else {
      console.log(\`Migrations executed: \${executed.map(item => item.name).join(', ')}\`)
    }

    if (payload.options?.seed) {
      const seeders = []
      for (const entry of payload.seeders) {
        const seeder = resolveExport(await loadModule(entry), isSeeder)
        if (!seeder) {
          throw new Error(\`Registered seeder "\${entry}" does not export a Holo seeder.\`)
        }
        seeders.push(seeder)
      }

      const seeded = await createSeederService(manager.connection(), seeders).seed({
        ...(Array.isArray(payload.options.only) ? { only: payload.options.only } : {}),
        quietly: payload.options.quietly === true,
        force: payload.options.force === true,
        environment: payload.options.environment ?? 'development',
      })
      if (seeded.length === 0) {
        console.log('No seeders were executed.')
      } else {
        console.log(\`Seeders executed: \${seeded.map(item => item.name).join(', ')}\`)
      }
    }
  } else if (payload.kind === 'rollback') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const migrations = []
    for (const entry of payload.migrations) {
      const migration = resolveExport(await loadModule(entry), isMigration)
      if (!migration) {
        throw new Error(\`Registered migration "\${entry}" does not export a Holo migration.\`)
      }
      migrations.push(normalizeRuntimeMigration(entry, migration))
    }

    const rolledBack = await createMigrationService(manager.connection(), migrations).rollback(payload.options ?? {})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath)
    if (rolledBack.length === 0) {
      console.log('No migrations were executed.')
    } else {
      console.log(\`Migrations executed: \${rolledBack.map(item => item.name).join(', ')}\`)
    }
  } else if (payload.kind === 'seed') {
    if (payload.generatedSchema) {
      await preloadGeneratedSchema(manager, payload.generatedSchema)
    }

    const seeders = []
    for (const entry of payload.seeders) {
      const seeder = resolveExport(await loadModule(entry), isSeeder)
      if (!seeder) {
        throw new Error(\`Registered seeder "\${entry}" does not export a Holo seeder.\`)
      }
      seeders.push(seeder)
    }

    const executed = await createSeederService(manager.connection(), seeders).seed(payload.options ?? {})
    if (executed.length === 0) {
      console.log('No seeders were executed.')
    } else {
      console.log(\`Seeders executed: \${executed.map(item => item.name).join(', ')}\`)
    }
  } else if (payload.kind === 'prune') {
    const models = []
    for (const entry of payload.models) {
      const model = resolveExport(await loadModule(entry), isModel)
      if (!model) {
        throw new Error(\`Registered model "\${entry}" does not export a Holo model.\`)
      }
      models.push(model)
    }

    const byName = new Map(models.map(model => [model.definition.name, model]))
    const requested = payload.options?.models ?? []
    const selected = []

    if (requested.length === 0) {
      selected.push(...models.filter(model => Boolean(model.definition.prunable)))
    } else {
      for (const name of requested) {
        const model = byName.get(name)
        if (!model) {
          throw new Error(\`Unknown model "\${name}".\`)
        }
        if (!model.definition.prunable) {
          throw new Error(\`Model "\${name}" does not define a prunable query.\`)
        }
        selected.push(model)
      }
    }

    if (selected.length === 0) {
      console.log('No prunable models were registered.')
    } else {
      let total = 0
      for (const model of selected) {
        const deleted = await model.prune()
        total += deleted
        console.log(\`\${model.definition.name}: deleted \${deleted}\`)
      }
      console.log(\`Total deleted: \${total}\`)
    }
  } else {
    throw new Error(\`Unknown runtime command "\${payload.kind}".\`)
  }
} finally {
  await manager.disconnectAll()
  resetDB()
}
`

export async function resolvePackageRootFromSpecifier(specifier: string): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.resolve(specifier)))

  while (true) {
    if (await fileExists(join(current, 'package.json'))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`Could not resolve package root for "${specifier}".`)
    }

    current = parent
  }
}

export async function ensureRuntimeDependencyLink(projectRoot: string): Promise<string> {
  const runtimeRoot = join(projectRoot, CLI_RUNTIME_ROOT)
  const packageRoot = await resolvePackageRootFromSpecifier('@holo-js/db')
  const namespaceDir = join(runtimeRoot, 'node_modules', '@holo-js')
  const targetPath = join(namespaceDir, 'db')

  await mkdir(namespaceDir, { recursive: true })
  await rm(targetPath, { recursive: true, force: true })
  await symlink(packageRoot, targetPath, 'junction')

  return runtimeRoot
}

export async function cleanupRuntimeDependencyLink(projectRoot: string): Promise<void> {
  await rm(join(projectRoot, CLI_RUNTIME_ROOT, 'node_modules'), { recursive: true, force: true })
}
/* v8 ignore stop */

export function createRuntimeInvocation(script: string): { command: string, args: string[] } {
  return {
    command: 'node',
    args: ['--input-type=module', '--eval', script],
  }
}

export function getRuntimeFailureMessage(kind: string, result: RuntimeSpawnResult): string {
  const stderr = result.stderr?.trim()
  if (stderr) {
    return stderr
  }

  const stdout = result.stdout?.trim()
  if (stdout) {
    return stdout
  }

  const errorCode = result.error && 'code' in result.error ? result.error.code : undefined
  if (typeof errorCode === 'string' && errorCode.length > 0) {
    return `Failed to launch runtime command "${kind}": ${errorCode}.`
  }

  return `Runtime command "${kind}" failed.`
}

/* v8 ignore start */
export async function withRuntimeEnvironment<T>(
  projectRoot: string,
  kind: 'migrate' | 'fresh' | 'rollback' | 'seed' | 'prune',
  options: Record<string, unknown>,
  callback: (stdout: string) => Promise<T>,
): Promise<T> {
  const environment = await getRuntimeEnvironment(projectRoot)

  try {
    const envRuntimeConfig = createEnvRuntimeConfig()
    const runtimeDatabaseConfig = mergeRuntimeDatabaseConfig(
      environment.project.config.database,
      envRuntimeConfig,
    )
    const runtimeRoot = await ensureRuntimeDependencyLink(projectRoot)
    const runtimePayload = JSON.stringify({
      kind,
      projectRoot,
      runtimeConfig: {
        db: runtimeDatabaseConfig,
      },
      models: environment.bundledModels.map(entry => pathToFileURL(entry).href),
      migrations: environment.bundledMigrations.map(entry => pathToFileURL(entry).href),
      seeders: environment.bundledSeeders.map(entry => pathToFileURL(entry).href),
      generatedSchema: environment.bundledGeneratedSchema ? pathToFileURL(environment.bundledGeneratedSchema).href : undefined,
      generatedSchemaOutputPath: resolveGeneratedSchemaPath(projectRoot, environment.project.config),
      options,
    })
    const runtime = createRuntimeInvocation(nodeRuntimeScript)
    const result = spawnSync(runtime.command, runtime.args, {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        HOLO_RUNTIME_PAYLOAD: runtimePayload,
      },
      encoding: 'utf8',
    })

    if (result.status !== 0) {
      throw new Error(getRuntimeFailureMessage(kind, result))
    }

    return await callback(result.stdout.trim())
  } finally {
    await cleanupRuntimeDependencyLink(projectRoot)
    await environment.cleanup()
  }
}
/* v8 ignore stop */
