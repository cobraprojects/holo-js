import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
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
import { GENERATED_SCHEMA_RUNTIME_PATH } from './project/shared'
import { fileExists } from './fs-utils'
import type { RuntimeEnvironment, RuntimeSpawnResult, RuntimeMigrationCandidate, ProjectRuntimeInitializationOptions } from './cli-types'
import type { HoloRuntime } from '@holo-js/core'

const runtimeImportMeta = import.meta as ImportMeta & {
  resolve?: (specifier: string) => string
}
const RUNTIME_DEPENDENCY_LOCK_RETRY_MS = 10

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

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
}

async function withRuntimeDependencyLock<T>(projectRoot: string, callback: () => Promise<T>): Promise<T> {
  const runtimeRoot = join(projectRoot, CLI_RUNTIME_ROOT)
  const lockDir = join(runtimeRoot, 'node_modules.lock')

  await mkdir(runtimeRoot, { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error
      }

      await setTimeout(RUNTIME_DEPENDENCY_LOCK_RETRY_MS)
    }
  }

  try {
    return await callback()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function readRuntimeDependencyReferenceCount(refPath: string): Promise<number> {
  const raw = await readFile(refPath, 'utf8').catch(() => undefined)
  const count = raw === undefined ? 0 : Number.parseInt(raw, 10)

  return Number.isFinite(count) && count > 0 ? count : 0
}

export async function ensureRuntimeDependencyLink(projectRoot: string): Promise<string> {
  return await withRuntimeDependencyLock(projectRoot, async () => {
    const runtimeRoot = join(projectRoot, CLI_RUNTIME_ROOT)
    const packageRoot = await resolvePackageRootFromSpecifier('@holo-js/db')
    const nodeModulesDir = join(runtimeRoot, 'node_modules')
    const namespaceDir = join(nodeModulesDir, '@holo-js')
    const targetPath = join(namespaceDir, 'db')
    const refPath = join(nodeModulesDir, '.holo-js-runtime-refs')
    const references = await readRuntimeDependencyReferenceCount(refPath)

    await mkdir(namespaceDir, { recursive: true })
    if (references === 0) {
      await rm(targetPath, { recursive: true, force: true })
      await symlink(packageRoot, targetPath, 'junction')
    }
    await writeFile(refPath, String(references + 1), 'utf8')

    return runtimeRoot
  })
}

export async function cleanupRuntimeDependencyLink(projectRoot: string): Promise<void> {
  await withRuntimeDependencyLock(projectRoot, async () => {
    const nodeModulesDir = join(projectRoot, CLI_RUNTIME_ROOT, 'node_modules')
    const refPath = join(nodeModulesDir, '.holo-js-runtime-refs')
    const references = await readRuntimeDependencyReferenceCount(refPath)
    const nextReferences = references - 1

    if (nextReferences <= 0) {
      await rm(nodeModulesDir, { recursive: true, force: true })
      return
    }

    await writeFile(refPath, String(nextReferences), 'utf8')
  })
}
/* v8 ignore stop */

export function resolveRuntimeWorkerPath(): string {
  const runtimePath = fileURLToPath(import.meta.url)
  return runtimePath.endsWith('/src/runtime.ts')
    ? resolve(dirname(runtimePath), 'runtime-worker.ts')
    : resolve(dirname(runtimePath), 'runtime-worker.mjs')
}

function supportsNodeTypeStripping(version = process.versions.node): boolean {
  const [major = '0', minor = '0'] = version.split('.')
  const majorVersion = Number.parseInt(major, 10)
  const minorVersion = Number.parseInt(minor, 10)

  return majorVersion > 22 || (majorVersion === 22 && minorVersion >= 6)
}

function resolveCompiledRuntimeWorkerPath(workerPath: string): string {
  return resolve(dirname(workerPath), '../dist/runtime-worker.mjs')
}

export function createRuntimeInvocation(workerPath = resolveRuntimeWorkerPath()): { command: string, args: string[] } {
  if (workerPath.endsWith('.ts')) {
    return {
      command: 'node',
      args: supportsNodeTypeStripping()
        ? ['--experimental-strip-types', workerPath]
        : [resolveCompiledRuntimeWorkerPath(workerPath)],
    }
  }

  return {
    command: 'node',
    args: [workerPath],
  }
}

export function runRuntimeInvocation(
  command: string,
  args: string[],
  options: { cwd: string, env: NodeJS.ProcessEnv },
): Promise<RuntimeSpawnResult> {
  return new Promise(resolveInvocation => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let error: Error | null = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', spawnError => {
      error = spawnError
    })
    child.on('close', status => {
      resolveInvocation({
        status,
        error,
        stdout,
        stderr,
      })
    })
  })
}

export function getRuntimeFailureMessage(kind: string, result: RuntimeSpawnResult): string {
  const stderr = result.stderr?.trim()
  if (stderr) {
    return formatRuntimeFailureText(stderr)
  }

  const stdout = result.stdout?.trim()
  if (stdout) {
    return formatRuntimeFailureText(stdout)
  }

  const errorCode = result.error && 'code' in result.error ? result.error.code : undefined
  if (typeof errorCode === 'string' && errorCode.length > 0) {
    return `Failed to launch runtime command "${kind}": ${errorCode}.`
  }

  return `Runtime command "${kind}" failed.`
}

function stripRuntimeErrorPrefix(line: string): string {
  return line.replace(/^(?:[A-Za-z][\w.]*Error|Error):\s+/, '')
}

function isRuntimeErrorSourceLine(line: string): boolean {
  return line.startsWith('throw ')
    || line.startsWith('at ')
    || line === '^'
    || /^\^+$/.test(line)
}

function formatRuntimeFailureText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const friendlyLine = lines.find(line => line.includes('Unable to ') && !isRuntimeErrorSourceLine(line))
  if (friendlyLine) {
    return stripRuntimeErrorPrefix(friendlyLine)
  }

  const errorLine = lines.find(line => /^(?:[A-Za-z][\w.]*Error|Error):\s+/.test(line))
  if (errorLine) {
    return stripRuntimeErrorPrefix(errorLine)
  }

  return lines[0] ?? text.trim()
}

/* v8 ignore start */
export async function withRuntimeEnvironment<T>(
  projectRoot: string,
  kind: 'migrate' | 'fresh' | 'rollback' | 'seed' | 'prune' | 'hydrate-schema',
  options: Record<string, unknown>,
  callback: (stdout: string) => Promise<T>,
): Promise<T> {
  if (kind === 'seed') {
    const project = await loadProjectConfig(projectRoot, { required: true })
    await prepareProjectDiscovery(projectRoot, project.config)
  }

  const environment = await getRuntimeEnvironment(projectRoot)
  let dependencyLinkEnsured = false

  try {
    const envRuntimeConfig = createEnvRuntimeConfig()
    const runtimeDatabaseConfig = mergeRuntimeDatabaseConfig(
      environment.project.config.database,
      envRuntimeConfig,
    )
    const runtimeRoot = await ensureRuntimeDependencyLink(projectRoot)
    dependencyLinkEnsured = true
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
      generatedSchemaRuntimeOutputPath: resolve(projectRoot, GENERATED_SCHEMA_RUNTIME_PATH),
      options,
    })
    const runtime = createRuntimeInvocation()
    const result = await runRuntimeInvocation(runtime.command, runtime.args, {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        HOLO_RUNTIME_PAYLOAD: runtimePayload,
      },
    })

    if (result.status !== 0) {
      throw new Error(getRuntimeFailureMessage(kind, result))
    }

    return await callback((result.stdout ?? '').trim())
  } finally {
    if (dependencyLinkEnsured) {
      await cleanupRuntimeDependencyLink(projectRoot)
    }
    await environment.cleanup()
  }
}
/* v8 ignore stop */
