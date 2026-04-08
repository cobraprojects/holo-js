import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type BuildOptions, type BuildResult } from 'esbuild'
import {
  loadConfigDirectory,
  holoAppDefaults,
  holoDatabaseDefaults,
  holoStorageDefaults,
  type SupportedDatabaseDriver,
} from '@holo-js/config'
import {
  DEFAULT_HOLO_PROJECT_PATHS,
  type MigrationDefinition,
  renderGeneratedSchemaPlaceholder,
  normalizeHoloProjectConfig,
  type NormalizedHoloProjectConfig,
  type SeederDefinition,
} from '@holo-js/db'
import {
  ESBUILD_PACKAGE_VERSION,
  SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS,
  SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_PACKAGE_MANAGER_VERSIONS,
  HOLO_PACKAGE_VERSION,
} from './metadata'
import { relativeImportPath } from './templates'
import type { LoadedProjectConfig, HoloAppCommand } from './types'

type ProjectModuleBundler = (options: BuildOptions) => Promise<BuildResult>

export type CliModelReference = {
  readonly definition: {
    readonly kind?: string
    readonly name: string
    readonly prunable?: unknown
  }
  prune(): Promise<number>
}

type InactiveGeneratedModelModule = {
  readonly holoModelPendingSchema: true
}

export type DiscoveredAppCommand = {
  readonly sourcePath: string
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly usage?: string
  load(): Promise<HoloAppCommand>
}

export type GeneratedModelRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly prunable: boolean
}

export type GeneratedMigrationRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
}

export type GeneratedSeederRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
}

export type GeneratedCommandRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
  readonly usage?: string
}

export type GeneratedJobRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

export type GeneratedEventRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
}

export type GeneratedListenerRegistryEntry = {
  readonly sourcePath: string
  readonly id: string
  readonly eventNames: readonly string[]
  readonly exportName?: string
}

export type GeneratedProjectRegistry = {
  readonly version: 1
  readonly generatedAt: string
  readonly paths: {
    readonly models: string
    readonly migrations: string
    readonly seeders: string
    readonly commands: string
    readonly jobs: string
    readonly events: string
    readonly listeners: string
    readonly generatedSchema: string
  }
  readonly models: readonly GeneratedModelRegistryEntry[]
  readonly migrations: readonly GeneratedMigrationRegistryEntry[]
  readonly seeders: readonly GeneratedSeederRegistryEntry[]
  readonly commands: readonly GeneratedCommandRegistryEntry[]
  readonly jobs: readonly GeneratedJobRegistryEntry[]
  readonly events: readonly GeneratedEventRegistryEntry[]
  readonly listeners: readonly GeneratedListenerRegistryEntry[]
}

export type SupportedScaffoldFramework = 'nuxt' | 'next' | 'sveltekit'

export type SupportedScaffoldPackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn'

export type SupportedScaffoldStorageDisk = 'local' | 'public'
export type SupportedScaffoldOptionalPackage = 'storage' | 'events' | 'queue' | 'validation' | 'forms'
export type SupportedQueueInstallerDriver = 'sync' | 'redis' | 'database'

export type ProjectScaffoldOptions = {
  readonly projectName: string
  readonly framework: SupportedScaffoldFramework
  readonly databaseDriver: SupportedDatabaseDriver
  readonly packageManager: SupportedScaffoldPackageManager
  readonly storageDefaultDisk: SupportedScaffoldStorageDisk
  readonly optionalPackages?: readonly SupportedScaffoldOptionalPackage[]
}

type ScaffoldedFile = {
  readonly path: string
  readonly contents: string
}

type QueueDiscoveryModule = {
  isQueueJobDefinition(value: unknown): boolean
  normalizeQueueJobDefinition(value: unknown): NormalizedDiscoveredQueueJob
}

type EventsDiscoveryModule = {
  isEventDefinition(value: unknown): boolean
  isListenerDefinition(value: unknown): boolean
  normalizeEventDefinition(value: unknown): { name?: string }
  normalizeListenerDefinition(value: unknown): NormalizedDiscoveredListener
}

type NormalizedDiscoveredQueueJob = {
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

type DiscoveryListenerReference = string | { readonly name?: string }

type MinimalListenerDefinition = {
  readonly listensTo: readonly DiscoveryListenerReference[]
}

type NormalizedDiscoveredListener = MinimalListenerDefinition & {
  readonly name?: string
}

export type QueueInstallResult = {
  readonly createdQueueConfig: boolean
  readonly updatedPackageJson: boolean
  readonly updatedEnv: boolean
  readonly updatedEnvExample: boolean
  readonly createdJobsDirectory: boolean
}

export type EventsInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdEventsDirectory: boolean
  readonly createdListenersDirectory: boolean
}

const APP_CONFIG_FILE_NAMES = [
  'config/app.ts',
  'config/app.mts',
  'config/app.js',
  'config/app.mjs',
] as const

const DATABASE_CONFIG_FILE_NAMES = [
  'config/database.ts',
  'config/database.mts',
  'config/database.js',
  'config/database.mjs',
] as const

const QUEUE_CONFIG_FILE_NAMES = [
  'config/queue.ts',
  'config/queue.mts',
  'config/queue.js',
  'config/queue.mjs',
] as const

const DB_DRIVER_PACKAGE_NAMES = {
  sqlite: '@holo-js/db-sqlite',
  postgres: '@holo-js/db-postgres',
  mysql: '@holo-js/db-mysql',
} as const satisfies Record<SupportedDatabaseDriver, string>

const COMMAND_FILE_PATTERN = /\.(?:[cm]?ts|[cm]?js)$/
const MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/
export const HOLO_RUNTIME_ROOT = join('.holo-js', 'runtime')
export const CLI_RUNTIME_ROOT = join(HOLO_RUNTIME_ROOT, 'cli')
const GENERATED_ROOT = join('.holo-js', 'generated')
const GENERATED_INDEX_PATH = join(GENERATED_ROOT, 'index.ts')
const GENERATED_METADATA_PATH = join(GENERATED_ROOT, 'metadata.ts')
const GENERATED_MODELS_PATH = join(GENERATED_ROOT, 'models.ts')
const GENERATED_MIGRATIONS_PATH = join(GENERATED_ROOT, 'migrations.ts')
const GENERATED_SEEDERS_PATH = join(GENERATED_ROOT, 'seeders.ts')
const GENERATED_COMMANDS_PATH = join(GENERATED_ROOT, 'commands.ts')
const GENERATED_JOBS_PATH = join(GENERATED_ROOT, 'jobs.ts')
const GENERATED_EVENTS_PATH = join(GENERATED_ROOT, 'events.ts')
const GENERATED_LISTENERS_PATH = join(GENERATED_ROOT, 'listeners.ts')
const GENERATED_CONFIG_TYPES_PATH = join(GENERATED_ROOT, 'config.d.ts')
const GENERATED_QUEUE_TYPES_PATH = join(GENERATED_ROOT, 'queue.d.ts')
const GENERATED_EVENT_TYPES_PATH = join(GENERATED_ROOT, 'events.d.ts')
const GENERATED_REGISTRY_JSON_PATH = join(GENERATED_ROOT, 'registry.json')
const GENERATED_TSCONFIG_PATH = join(GENERATED_ROOT, 'tsconfig.json')
const GENERATED_GITIGNORE_PATH = join(GENERATED_ROOT, '.gitignore')
const CONFIG_EXTENSION_PRIORITY = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'] as const
const SUPPORTED_CONFIG_EXTENSIONS = new Set<string>(CONFIG_EXTENSION_PRIORITY)
const SUPPORTED_SCAFFOLD_FRAMEWORKS = ['nuxt', 'next', 'sveltekit'] as const
const SUPPORTED_SCAFFOLD_PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const
const SUPPORTED_SCAFFOLD_STORAGE_DISKS = ['local', 'public'] as const
const SUPPORTED_SCAFFOLD_OPTIONAL_PACKAGES = ['storage', 'events', 'queue', 'validation', 'forms'] as const
const SUPPORTED_QUEUE_INSTALLER_DRIVERS = ['sync', 'redis', 'database'] as const
let projectModuleBundler: ProjectModuleBundler = build
const HOLO_EVENT_DEFINITION_MARKER = Symbol.for('holo-js.events.definition')
const HOLO_LISTENER_DEFINITION_MARKER = Symbol.for('holo-js.events.listener')

export function resolveProjectPackageImportSpecifier(
  projectRoot: string,
  specifier: string,
  resolveSpecifier?: (specifier: string) => string,
): string {
  try {
    const projectRequire = createRequire(join(projectRoot, 'package.json'))
    const resolved = (resolveSpecifier ?? projectRequire.resolve.bind(projectRequire))(specifier)
    return pathToFileURL(resolved).href
  } catch {
    return specifier
  }
}

async function loadQueueDiscoveryModule(projectRoot: string): Promise<QueueDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')) as QueueDiscoveryModule
}

async function loadEventsDiscoveryModule(projectRoot: string): Promise<EventsDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/events')) as EventsDiscoveryModule
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function hasEventDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

function hasListenerDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isSupportedScaffoldFramework(value: string): value is SupportedScaffoldFramework {
  return (SUPPORTED_SCAFFOLD_FRAMEWORKS as readonly string[]).includes(value)
}

function isSupportedScaffoldPackageManager(value: string): value is SupportedScaffoldPackageManager {
  return (SUPPORTED_SCAFFOLD_PACKAGE_MANAGERS as readonly string[]).includes(value)
}

function isSupportedScaffoldStorageDisk(value: string): value is SupportedScaffoldStorageDisk {
  return (SUPPORTED_SCAFFOLD_STORAGE_DISKS as readonly string[]).includes(value)
}

function isSupportedScaffoldOptionalPackage(value: string): value is SupportedScaffoldOptionalPackage {
  return (SUPPORTED_SCAFFOLD_OPTIONAL_PACKAGES as readonly string[]).includes(value)
}

function normalizeScaffoldOptionalPackageName(value: string): string {
  const current = value.trim().toLowerCase()
  if (current === 'validate') {
    return 'validation'
  }

  if (current === 'form') {
    return 'forms'
  }

  return current
}

function normalizeScaffoldOptionalPackages(
  value: readonly string[] | readonly SupportedScaffoldOptionalPackage[] | undefined,
): readonly SupportedScaffoldOptionalPackage[] {
  if (!value || value.length === 0) {
    return []
  }

  const normalized = new Set<SupportedScaffoldOptionalPackage>()
  for (const entry of value) {
    const current = normalizeScaffoldOptionalPackageName(entry)
    if (!isSupportedScaffoldOptionalPackage(current)) {
      throw new Error(
        `Unsupported optional package: ${entry}. Expected one of ${SUPPORTED_SCAFFOLD_OPTIONAL_PACKAGES.join(', ')}.`,
      )
    }

    normalized.add(current)
    if (current === 'forms') {
      normalized.add('validation')
    }
  }

  return [...normalized].sort((left, right) => left.localeCompare(right))
}

function isSupportedQueueInstallerDriver(value: string): value is SupportedQueueInstallerDriver {
  return (SUPPORTED_QUEUE_INSTALLER_DRIVERS as readonly string[]).includes(value)
}

function sanitizePackageName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function resolvePackageManagerVersion(value: SupportedScaffoldPackageManager): string {
  return SCAFFOLD_PACKAGE_MANAGER_VERSIONS[value]
}

function resolveDefaultDatabaseUrl(driver: SupportedDatabaseDriver): string | undefined {
  if (driver === 'sqlite') {
    return './storage/database.sqlite'
  }

  return undefined
}

async function resolveFirstExistingPath(projectRoot: string, fileNames: readonly string[]): Promise<string | undefined> {
  for (const fileName of fileNames) {
    const candidate = join(projectRoot, fileName)
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  return undefined
}

async function isModulePackage(projectRoot: string): Promise<boolean> {
  const packageJsonPath = join(projectRoot, 'package.json')
  if (!(await pathExists(packageJsonPath))) {
    return false
  }

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { type?: unknown }
    return packageJson.type === 'module'
  } catch {
    return false
  }
}

function getProjectTsconfigPath(projectRoot: string): string {
  return join(projectRoot, 'tsconfig.json')
}

async function writeLoaderTsconfig(projectRoot: string, tempDir: string): Promise<string> {
  const projectTsconfigPath = getProjectTsconfigPath(projectRoot)
  if (await pathExists(projectTsconfigPath)) {
    return projectTsconfigPath
  }

  const tsconfigPath = join(tempDir, 'tsconfig.json')
  const contents = JSON.stringify({
    compilerOptions: {
      baseUrl: projectRoot,
      paths: {
        '~/*': ['./*'],
        '@/*': ['./*'],
      },
    },
  }, null, 2)

  await writeFile(tsconfigPath, `${contents}\n`, 'utf8')
  return tsconfigPath
}

export async function bundleProjectModule(
  projectRoot: string,
  entryPath: string,
  options: { external?: readonly string[] } = {},
): Promise<{ path: string, cleanup(): Promise<void> }> {
  const runtimeTempRoot = join(projectRoot, CLI_RUNTIME_ROOT)
  await mkdir(runtimeTempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(runtimeTempRoot, 'bundle-'))
  const tsconfigPath = await writeLoaderTsconfig(projectRoot, tempDir)
  const outdir = join(tempDir, 'out')
  const outfile = join(outdir, `${basename(entryPath, extname(entryPath))}.mjs`)

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  try {
    await projectModuleBundler({
      absWorkingDir: projectRoot,
      bundle: true,
      entryPoints: [entryPath],
      outfile,
      format: 'esm',
      logLevel: 'silent',
      packages: 'external',
      platform: 'node',
      target: 'node20',
      tsconfig: tsconfigPath,
      sourcemap: false,
      external: [...(options.external ?? [])],
    })

    return {
      path: outfile,
      cleanup,
    }
  } catch (error) {
    await cleanup()

    if (error && typeof error === 'object' && Array.isArray((error as { errors?: unknown[] }).errors)) {
      const message = (error as {
        errors: Array<{ text?: unknown, message?: unknown }>
      }).errors
        .map(entry => {
          if (typeof entry.text === 'string' && entry.text.trim()) {
            return entry.text
          }

          if (typeof entry.message === 'string' && entry.message.trim()) {
            return entry.message
          }

          return 'Unknown build error.'
        })
        .join('\n')

      throw new Error(message)
    }

    if (error instanceof Error && error.message) {
      throw error
    }

    throw new Error(`Failed to load ${entryPath}.`)
  }
}

async function importProjectModule(projectRoot: string, entryPath: string): Promise<unknown> {
  const bundled = await bundleProjectModule(projectRoot, entryPath)

  try {
    return await import(`${pathToFileURL(bundled.path).href}?t=${Date.now()}`)
  } finally {
    await bundled.cleanup()
  }
}

export async function findProjectRoot(startDir: string): Promise<string> {
  let current = resolve(startDir)
  let fallbackRoot: string | undefined

  while (true) {
    if (await resolveFirstExistingPath(current, APP_CONFIG_FILE_NAMES)) {
      return current
    }

    if (
      !fallbackRoot
      && (
        await pathExists(join(current, 'package.json'))
        || await pathExists(join(current, 'nuxt.config.ts'))
        || await pathExists(join(current, 'nuxt.config.js'))
        || await pathExists(join(current, 'bun.lock'))
      )
    ) {
      fallbackRoot = current
    }

    const parent = dirname(current)
    if (parent === current) {
      return fallbackRoot ?? resolve(startDir)
    }

    current = parent
  }
}

export async function loadProjectConfig(
  projectRoot: string,
  options: { required?: boolean } = {},
): Promise<LoadedProjectConfig> {
  const appConfigPath = await resolveFirstExistingPath(projectRoot, APP_CONFIG_FILE_NAMES)
  if (!appConfigPath) {
    if (options.required) {
      throw new Error(`Missing config/app.(ts|mts|js|mjs) in ${projectRoot}. Run a generator command first to create it.`)
    }

    return {
      config: normalizeHoloProjectConfig(),
    }
  }

  const loaded = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  })
  const baseConfig = normalizeHoloProjectConfig({
    paths: loaded.app.paths,
    database: loaded.database,
  })
  const registry = await loadGeneratedProjectRegistry(projectRoot)

  return {
    manifestPath: appConfigPath,
    config: registry
      ? normalizeHoloProjectConfig({
          paths: baseConfig.paths,
          models: registry.models.map(entry => entry.sourcePath),
          migrations: registry.migrations.map(entry => entry.sourcePath),
          seeders: registry.seeders.map(entry => entry.sourcePath),
          database: loaded.database,
        })
      : baseConfig,
  }
}

async function serializeProjectConfig(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  manifestPath: string,
): Promise<string> {
  const loaded = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  }).catch(() => undefined)
  const appConfig = loaded?.app ?? holoAppDefaults
  const contents = JSON.stringify({
    name: appConfig.name,
    key: appConfig.key,
    url: appConfig.url,
    debug: appConfig.debug,
    env: appConfig.env,
    paths: config.paths,
  }, null, 2)

  const extension = extname(manifestPath)
  const isCommonJs = extension === '.js' && !(await isModulePackage(projectRoot))

  if (isCommonJs) {
    return [
      'const { defineAppConfig } = require(\'@holo-js/config\')',
      '',
      'module.exports = defineAppConfig(',
      contents,
      ')',
      '',
    ].join('\n')
  }

  return [
    'import { defineAppConfig } from \'@holo-js/config\'',
    '',
    'export default defineAppConfig(',
    contents,
    ')',
    '',
  ].join('\n')
}

async function serializeDatabaseConfig(
  projectRoot: string,
  _targetPath: string,
): Promise<string> {
  const loaded = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  }).catch(() => undefined)
  const databaseConfig = loaded?.database ?? holoDatabaseDefaults
  const contents = JSON.stringify({
    defaultConnection: databaseConfig.defaultConnection,
    connections: databaseConfig.connections,
  }, null, 2)

  return [
    'import { defineDatabaseConfig } from \'@holo-js/config\'',
    '',
    'export default defineDatabaseConfig(',
    contents,
    ')',
    '',
  ].join('\n')
}

function renderStorageConfig(): string {
  return [
    'import { defineStorageConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineStorageConfig({',
    `  defaultDisk: env('STORAGE_DEFAULT_DISK', '${holoStorageDefaults.defaultDisk}'),`,
    `  routePrefix: env('STORAGE_ROUTE_PREFIX', '${holoStorageDefaults.routePrefix}'),`,
    '  disks: {',
    '    local: {',
    '      driver: \'local\',',
    '      root: \'./storage/app\',',
    '    },',
    '    public: {',
    '      driver: \'public\',',
    '      root: \'./storage/app/public\',',
    '      visibility: \'public\',',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderMediaConfig(): string {
  return [
    'import { defineMediaConfig } from \'@holo-js/config\'',
    '',
    'export default defineMediaConfig({})',
    '',
  ].join('\n')
}

function renderQueueConfig(
  options: {
    readonly driver?: SupportedQueueInstallerDriver
    readonly defaultDatabaseConnection?: string
  } = {},
): string {
  const driver = options.driver ?? 'sync'
  const defaultDatabaseConnection = options.defaultDatabaseConnection?.trim() || 'default'

  if (driver === 'redis') {
    return [
      'import { defineQueueConfig, env } from \'@holo-js/config\'',
      '',
      'export default defineQueueConfig({',
      '  default: \'redis\',',
      '  failed: false,',
      '  connections: {',
      '    redis: {',
      '      driver: \'redis\',',
      '      queue: \'default\',',
      '      retryAfter: 90,',
      '      blockFor: 5,',
      '      redis: {',
      '        host: env(\'REDIS_HOST\', \'127.0.0.1\'),',
      '        port: env(\'REDIS_PORT\', 6379),',
      '        username: env(\'REDIS_USERNAME\'),',
      '        password: env(\'REDIS_PASSWORD\'),',
      '        db: env(\'REDIS_DB\', 0),',
      '      },',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  if (driver === 'database') {
    return [
      'import { defineQueueConfig } from \'@holo-js/config\'',
      '',
      'export default defineQueueConfig({',
      '  default: \'database\',',
      '  failed: {',
      '    driver: \'database\',',
      `    connection: '${defaultDatabaseConnection}',`,
      '    table: \'failed_jobs\',',
      '  },',
      '  connections: {',
      '    database: {',
      '      driver: \'database\',',
      `      connection: '${defaultDatabaseConnection}',`,
      '      table: \'jobs\',',
      '      queue: \'default\',',
      '      retryAfter: 90,',
      '      sleep: 1,',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  return [
    'import { defineQueueConfig } from \'@holo-js/config\'',
    '',
    'export default defineQueueConfig({',
    '  default: \'sync\',',
    '  failed: false,',
    '  connections: {',
    '    sync: {',
    '      driver: \'sync\',',
    '      queue: \'default\',',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderScaffoldAppConfig(projectName: string): string {
  return [
    'import type { HoloAppEnv } from \'@holo-js/config\'',
    'import { defineAppConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineAppConfig({',
    `  name: env('APP_NAME', ${JSON.stringify(projectName)}),`,
    '  key: env(\'APP_KEY\'),',
    '  url: env(\'APP_URL\', \'http://localhost:3000\'),',
    '  env: env<HoloAppEnv>(\'APP_ENV\', \'development\'),',
    '  debug: env<boolean>(\'APP_DEBUG\', true),',
    '  paths: {',
    '    models: \'server/models\',',
    '    migrations: \'server/db/migrations\',',
    '    seeders: \'server/db/seeders\',',
    '    commands: \'server/commands\',',
    '    jobs: \'server/jobs\',',
    '    events: \'server/events\',',
    '    listeners: \'server/listeners\',',
    '    generatedSchema: \'server/db/schema.generated.ts\',',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderScaffoldDatabaseConfig(
  options: Pick<ProjectScaffoldOptions, 'databaseDriver' | 'projectName'>,
): string {
  const packageName = sanitizePackageName(options.projectName) || 'holo-app'

  if (options.databaseDriver === 'sqlite') {
    return [
      'import { defineDatabaseConfig, env } from \'@holo-js/config\'',
      '',
      'export default defineDatabaseConfig({',
      '  defaultConnection: \'main\',',
      '  connections: {',
      '    main: {',
      '      driver: \'sqlite\',',
      '      url: env(\'DB_URL\', \'./storage/database.sqlite\'),',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  const port = options.databaseDriver === 'mysql' ? '3306' : '5432'
  const username = options.databaseDriver === 'mysql' ? 'root' : 'postgres'
  const schemaLine = options.databaseDriver === 'postgres'
    ? '      schema: env(\'DB_SCHEMA\', \'public\'),'
    : undefined

  return [
    'import { defineDatabaseConfig, env } from \'@holo-js/config\'',
    '',
    'export default defineDatabaseConfig({',
    '  defaultConnection: \'main\',',
    '  connections: {',
    '    main: {',
    `      driver: '${options.databaseDriver}',`,
    '      host: env(\'DB_HOST\', \'127.0.0.1\'),',
    `      port: env('DB_PORT', '${port}'),`,
    `      username: env('DB_USERNAME', '${username}'),`,
    '      password: env(\'DB_PASSWORD\'),',
    `      database: env('DB_DATABASE', '${packageName}'),`,
    ...(schemaLine ? [schemaLine] : []),
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderScaffoldEnvFiles(
  options: Pick<ProjectScaffoldOptions, 'databaseDriver' | 'projectName' | 'storageDefaultDisk' | 'optionalPackages'>,
): { env: string, example: string } {
  const baseLines = [
    `APP_NAME=${JSON.stringify(options.projectName)}`,
    'APP_KEY=',
    'APP_URL=http://localhost:3000',
    'APP_ENV=development',
    'APP_DEBUG=true',
    `DB_DRIVER=${options.databaseDriver}`,
  ]
  const driverLines = options.databaseDriver === 'sqlite'
    ? [
        `DB_URL=${resolveDefaultDatabaseUrl(options.databaseDriver)}`,
      ]
    : [
        'DB_HOST=127.0.0.1',
        `DB_PORT=${options.databaseDriver === 'mysql' ? '3306' : '5432'}`,
        `DB_USERNAME=${options.databaseDriver === 'mysql' ? 'root' : 'postgres'}`,
        'DB_PASSWORD=',
        `DB_DATABASE=${sanitizePackageName(options.projectName) || 'holo_app'}`,
        ...(options.databaseDriver === 'postgres' ? ['DB_SCHEMA=public'] : []),
      ]
  const storageLines = normalizeScaffoldOptionalPackages(options.optionalPackages).includes('storage')
    ? [
        `STORAGE_DEFAULT_DISK=${options.storageDefaultDisk}`,
        'STORAGE_ROUTE_PREFIX=/storage',
      ]
    : []
  const env = [...baseLines, ...driverLines, ...storageLines, ''].join('\n')
  const example = [
    '# Copy this file to .env and fill in your local values.',
    '# Supported layered env files: .env.local, .env.development, .env.production, .env.prod, .env.test',
    ...[...baseLines, ...driverLines, ...storageLines].map(line => `${line.split('=')[0]}=`),
    '',
  ].join('\n')

  return { env, example }
}

function renderQueueEnvFiles(
  driver: SupportedQueueInstallerDriver,
): { env: readonly string[], example: readonly string[] } {
  if (driver !== 'redis') {
    return {
      env: [],
      example: [],
    }
  }

  return {
    env: [
      'REDIS_HOST=127.0.0.1',
      'REDIS_PORT=6379',
      'REDIS_USERNAME=',
      'REDIS_PASSWORD=',
      'REDIS_DB=0',
    ],
    example: [
      'REDIS_HOST=',
      'REDIS_PORT=',
      'REDIS_USERNAME=',
      'REDIS_PASSWORD=',
      'REDIS_DB=',
    ],
  }
}

function parseEnvKey(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined
  }

  const normalized = trimmed.startsWith('export ')
    ? trimmed.slice(7).trim()
    : trimmed
  const separatorIndex = normalized.indexOf('=')
  if (separatorIndex <= 0) {
    return undefined
  }

  return normalized.slice(0, separatorIndex).trim()
}

function upsertEnvContents(
  existingContents: string | undefined,
  additions: readonly string[],
): { readonly contents?: string, readonly changed: boolean } {
  if (additions.length === 0) {
    return {
      contents: existingContents,
      changed: false,
    }
  }

  const nextLines = existingContents
    ? existingContents.replace(/\r\n/g, '\n').split('\n')
    : []
  const existingKeys = new Set(nextLines.map(parseEnvKey).filter((value): value is string => typeof value === 'string'))
  const missingLines = additions.filter(line => !existingKeys.has(line.slice(0, line.indexOf('=')).trim()))

  if (missingLines.length === 0) {
    return {
      contents: existingContents,
      changed: false,
    }
  }

  if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== '') {
    nextLines.push('')
  }

  nextLines.push(...missingLines)

  return {
    contents: `${nextLines.join('\n').replace(/\n*$/, '')}\n`,
    changed: true,
  }
}

function normalizeDependencyMap(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, dependencyVersion]) => typeof dependencyVersion === 'string')
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

async function readPackageJsonDependencyState(projectRoot: string): Promise<{
  packageJsonPath: string
  parsed: Record<string, unknown>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}> {
  const packageJsonPath = resolve(projectRoot, 'package.json')
  const existing = await readTextFile(packageJsonPath)
  if (!existing) {
    throw new Error(`Missing package.json in ${projectRoot}.`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>
  } catch {
    throw new Error(`Invalid package.json in ${projectRoot}.`)
  }

  return {
    packageJsonPath,
    parsed,
    dependencies: normalizeDependencyMap(parsed.dependencies),
    devDependencies: normalizeDependencyMap(parsed.devDependencies),
  }
}

async function writePackageJsonDependencyState(
  packageJsonPath: string,
  parsed: Record<string, unknown>,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): Promise<void> {
  parsed.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )

  if (Object.keys(devDependencies).length > 0) {
    parsed.devDependencies = Object.fromEntries(
      Object.entries(devDependencies).sort(([left], [right]) => left.localeCompare(right)),
    )
  } else {
    delete parsed.devDependencies
  }

  await writeTextFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`)
}

function hasLoadedConfigFile(
  loadedFiles: readonly string[],
  configName: string,
): boolean {
  return loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return normalizedPath.endsWith(`/config/${configName}.ts`)
      || normalizedPath.endsWith(`/config/${configName}.mts`)
      || normalizedPath.endsWith(`/config/${configName}.js`)
      || normalizedPath.endsWith(`/config/${configName}.mjs`)
      || normalizedPath.endsWith(`/config/${configName}.cts`)
      || normalizedPath.endsWith(`/config/${configName}.cjs`)
  })
}

function inferDatabaseDriverFromUrl(value: string | undefined): SupportedDatabaseDriver | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) {
    return 'postgres'
  }

  if (normalized.startsWith('mysql://') || normalized.startsWith('mysql2://')) {
    return 'mysql'
  }

  if (
    normalized === ':memory:'
    || normalized.startsWith('file:')
    || normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.endsWith('.db')
    || normalized.endsWith('.sqlite')
    || normalized.endsWith('.sqlite3')
  ) {
    return 'sqlite'
  }

  return undefined
}

function inferConnectionDriver(
  connection: {
    driver?: string
    url?: string
    filename?: string
  } | string,
): SupportedDatabaseDriver | undefined {
  if (typeof connection === 'string') {
    return inferDatabaseDriverFromUrl(connection)
  }

  const explicitDriver = connection.driver
  if (explicitDriver === 'sqlite' || explicitDriver === 'postgres' || explicitDriver === 'mysql') {
    return explicitDriver
  }

  return inferDatabaseDriverFromUrl(connection.url ?? connection.filename)
}

export async function syncManagedDriverDependencies(projectRoot: string): Promise<boolean> {
  const loaded = await loadConfigDirectory(projectRoot, {
    preferCache: false,
    processEnv: process.env,
  })
  const queueConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'queue')
  const storageConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'storage')
  const requiredPackages = new Set<string>()

  for (const connection of Object.values(loaded.database.connections)) {
    const inferredDriver = inferConnectionDriver(connection)
    if (inferredDriver) {
      requiredPackages.add(DB_DRIVER_PACKAGE_NAMES[inferredDriver])
    }
  }

  if (queueConfigured) {
    requiredPackages.add('@holo-js/queue')

    const queueConnections = Object.values(loaded.queue.connections)
    if (queueConnections.some(connection => connection.driver === 'redis')) {
      requiredPackages.add('@holo-js/queue-redis')
    }

    if (
      queueConnections.some(connection => connection.driver === 'database')
      || loaded.queue.failed !== false
    ) {
      requiredPackages.add('@holo-js/queue-db')
    }
  }

  if (storageConfigured) {
    requiredPackages.add('@holo-js/storage')

    if (Object.values(loaded.storage.disks).some(disk => disk.driver === 's3')) {
      requiredPackages.add('@holo-js/storage-s3')
    }
  }

  const {
    packageJsonPath,
    parsed,
    dependencies,
    devDependencies,
  } = await readPackageJsonDependencyState(projectRoot)

  let changed = false
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const removableManagedPackages = new Set<string>([
    ...Object.values(DB_DRIVER_PACKAGE_NAMES),
    '@holo-js/queue-db',
    '@holo-js/queue-redis',
    '@holo-js/storage-s3',
  ])

  for (const packageName of requiredPackages) {
    if (dependencies[packageName] !== nextVersion || typeof devDependencies[packageName] !== 'undefined') {
      dependencies[packageName] = nextVersion
      delete devDependencies[packageName]
      changed = true
    }
  }

  for (const packageName of removableManagedPackages) {
    if (requiredPackages.has(packageName)) {
      continue
    }

    if (typeof dependencies[packageName] !== 'undefined' || typeof devDependencies[packageName] !== 'undefined') {
      delete dependencies[packageName]
      delete devDependencies[packageName]
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertQueuePackageDependency(
  projectRoot: string,
  driver?: SupportedQueueInstallerDriver,
): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const queueConfigPath = await resolveFirstExistingPath(projectRoot, QUEUE_CONFIG_FILE_NAMES)
  const loadedQueueConfig = queueConfigPath
    ? loadConfigDirectory(projectRoot, {
        preferCache: false,
        processEnv: process.env,
      }).then(config => config.queue)
        /* v8 ignore next -- existing malformed queue config falls back to explicit driver handling in installer tests */
        .catch(() => undefined)
    /* v8 ignore next -- exercised by dependency-sync tests, but v8 does not attribute the ternary fallback line */
    : Promise.resolve(undefined)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const nextEsbuildVersion = ESBUILD_PACKAGE_VERSION
  const queueConfig = typeof driver === 'undefined'
    ? await loadedQueueConfig
    : undefined
  const resolvedQueueDriver = driver && driver !== 'sync'
    ? driver
    : queueConfig?.connections[queueConfig.default]?.driver ?? driver
  const requiresQueueDb = resolvedQueueDriver === 'database'
    || (queueConfig?.failed ?? false) !== false
    || Object.values(queueConfig?.connections ?? {}).some(connection => connection.driver === 'database')
  const requiresQueueRedis = resolvedQueueDriver === 'redis'
    || Object.values(queueConfig?.connections ?? {}).some(connection => connection.driver === 'redis')
  const currentVersion = dependencies['@holo-js/queue']
  const currentQueueDbVersion = dependencies['@holo-js/queue-db']
  const currentQueueRedisVersion = dependencies['@holo-js/queue-redis']
  const currentDevVersion = devDependencies['@holo-js/queue']
  const currentDevQueueDbVersion = devDependencies['@holo-js/queue-db']
  const currentDevQueueRedisVersion = devDependencies['@holo-js/queue-redis']
  const currentEsbuildVersion = dependencies.esbuild
  const currentDevEsbuildVersion = devDependencies.esbuild

  if (
    currentVersion === nextVersion
    && (requiresQueueDb ? currentQueueDbVersion === nextVersion : typeof currentQueueDbVersion === 'undefined')
    && (requiresQueueRedis ? currentQueueRedisVersion === nextVersion : typeof currentQueueRedisVersion === 'undefined')
    && typeof currentDevVersion === 'undefined'
    && typeof currentDevQueueDbVersion === 'undefined'
    && typeof currentDevQueueRedisVersion === 'undefined'
    && currentEsbuildVersion === nextEsbuildVersion
    && typeof currentDevEsbuildVersion === 'undefined'
  ) {
    return false
  }

  dependencies['@holo-js/queue'] = nextVersion
  if (requiresQueueDb) {
    dependencies['@holo-js/queue-db'] = nextVersion
  } else {
    delete dependencies['@holo-js/queue-db']
  }
  if (requiresQueueRedis) {
    dependencies['@holo-js/queue-redis'] = nextVersion
  } else {
    delete dependencies['@holo-js/queue-redis']
  }
  dependencies.esbuild = nextEsbuildVersion
  delete devDependencies['@holo-js/queue']
  delete devDependencies['@holo-js/queue-db']
  delete devDependencies['@holo-js/queue-redis']
  delete devDependencies.esbuild

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertEventsPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/events']
  const currentDevVersion = devDependencies['@holo-js/events']

  if (
    currentVersion === nextVersion
    && typeof currentDevVersion === 'undefined'
  ) {
    return false
  }

  dependencies['@holo-js/events'] = nextVersion
  delete devDependencies['@holo-js/events']

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

export async function installQueueIntoProject(
  projectRoot: string,
  options: {
    readonly driver?: SupportedQueueInstallerDriver
  } = {},
): Promise<QueueInstallResult> {
  const driver = options.driver ?? 'sync'
  if (!isSupportedQueueInstallerDriver(driver)) {
    throw new Error(`Unsupported queue driver: ${driver}.`)
  }

  const project = await loadProjectConfig(projectRoot)
  const defaultDatabaseConnection = project.config.database?.defaultConnection ?? 'default'
  const queueConfigPath = await resolveFirstExistingPath(projectRoot, QUEUE_CONFIG_FILE_NAMES) ?? resolve(projectRoot, 'config/queue.ts')
  const queueConfigExists = await pathExists(queueConfigPath)
  const jobsRoot = resolve(projectRoot, project.config.paths.jobs)
  const jobsDirectoryExists = await pathExists(jobsRoot)
  const queueEnvFiles = renderQueueEnvFiles(driver)

  if (!queueConfigExists) {
    await writeTextFile(queueConfigPath, renderQueueConfig({
      driver,
      defaultDatabaseConnection,
    }))
  }

  await mkdir(jobsRoot, { recursive: true })

  const updatedPackageJson = await upsertQueuePackageDependency(
    projectRoot,
    !queueConfigExists || driver !== 'sync' ? driver : undefined,
  )
  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), queueEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), queueEnvFiles.example)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  return {
    createdQueueConfig: !queueConfigExists,
    updatedPackageJson,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
    createdJobsDirectory: !jobsDirectoryExists,
  }
}

export async function installEventsIntoProject(
  projectRoot: string,
): Promise<EventsInstallResult> {
  const project = await loadProjectConfig(projectRoot)
  const eventsRoot = resolve(projectRoot, project.config.paths.events)
  const listenersRoot = resolve(projectRoot, project.config.paths.listeners)
  const eventsDirectoryExists = await pathExists(eventsRoot)
  const listenersDirectoryExists = await pathExists(listenersRoot)

  await mkdir(eventsRoot, { recursive: true })
  await mkdir(listenersRoot, { recursive: true })

  return {
    updatedPackageJson: await upsertEventsPackageDependency(projectRoot),
    createdEventsDirectory: !eventsDirectoryExists,
    createdListenersDirectory: !listenersDirectoryExists,
  }
}

function renderScaffoldGitignore(): string {
  return [
    'node_modules',
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.prod',
    '.env.test',
    '.holo-js/generated',
    '.holo-js/runtime',
    '.nuxt',
    '.output',
    '.next',
    '.svelte-kit',
    'coverage',
    'dist',
    '',
  ].join('\n')
}

function renderScaffoldTsconfig(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  if (options.framework === 'nuxt') {
    return `${JSON.stringify({
      extends: './.nuxt/tsconfig.json',
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }, null, 2)}\n`
  }

  if (options.framework === 'sveltekit') {
    return `${JSON.stringify({
      extends: './.svelte-kit/tsconfig.json',
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: [
        'src/**/*.ts',
        'src/**/*.svelte',
        'server/**/*.ts',
        'config/**/*.ts',
        '.holo-js/generated/**/*.ts',
        '.holo-js/generated/**/*.d.ts',
        'vite.config.ts',
      ],
    }, null, 2)}\n`
  }

  const include = ['next-env.d.ts', 'app/**/*.ts', 'app/**/*.tsx', 'server/**/*.ts', 'config/**/*.ts', '.holo-js/generated/**/*.ts', '.holo-js/generated/**/*.d.ts']

  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: '.',
      jsx: 'preserve',
      paths: {
        '~/*': ['./*'],
        '@/*': ['./*'],
      },
    },
    include,
  }, null, 2)}\n`
}

function renderNuxtAppVue(projectName: string): string {
  return [
    '<template>',
    '  <main class="shell">',
    `    <h1>${projectName}</h1>`,
    '    <p>Nuxt renders the UI. Holo owns the backend runtime and canonical server directories.</p>',
    '  </main>',
    '</template>',
    '',
    '<style scoped>',
    '.shell {',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-content: center;',
    '  gap: 1rem;',
    '  padding: 3rem;',
    '  font-family: sans-serif;',
    '}',
    'h1 {',
    '  margin: 0;',
    '  font-size: clamp(2.5rem, 6vw, 4rem);',
    '}',
    'p {',
    '  margin: 0;',
    '  max-width: 40rem;',
    '  line-height: 1.6;',
    '}',
    '</style>',
    '',
  ].join('\n')
}

function renderNuxtConfig(): string {
  return [
    'export default defineNuxtConfig({',
    '  modules: [\'@holo-js/adapter-nuxt\'],',
    '  typescript: {',
    '    strict: true,',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderNuxtHealthRoute(): string {
  return [
    'export default defineEventHandler(async () => {',
    '  const app = await holo.getApp()',
    '',
    '  return {',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  }',
    '})',
    '',
  ].join('\n')
}

function renderNextConfig(storageEnabled: boolean): string {
  if (!storageEnabled) {
    return [
      '/** @type {import(\'next\').NextConfig} */',
      'const nextConfig = {}',
      '',
      'export default nextConfig',
      '',
    ].join('\n')
  }

  return [
    'const storageRoutePrefix = (() => {',
    '  const raw = process.env.STORAGE_ROUTE_PREFIX?.trim() ?? \'/storage\'',
    '  if (!raw || raw === \'/\') {',
    '    return \'/storage\'',
    '  }',
    '',
    '  return `/${raw.replace(/^\\/+|\\/+$/g, \'\')}`',
    '})()',
    '',
    '/** @type {import(\'next\').NextConfig} */',
    'const nextConfig = {',
    '  async rewrites() {',
    '    if (storageRoutePrefix === \'/storage\') {',
    '      return []',
    '    }',
    '',
    '    return [',
    '      {',
    '        source: `${storageRoutePrefix}/:path*`,',
    '        destination: \'/storage/:path*\',',
    '      },',
    '    ]',
    '  },',
    '}',
    '',
    'export default nextConfig',
    '',
  ].join('\n')
}

function renderNextLayout(projectName: string): string {
  return [
    'import type { ReactNode } from \'react\'',
    '',
    'export const metadata = {',
    `  title: ${JSON.stringify(projectName)},`,
    '  description: \'Holo on Next.js\',',
    '}',
    '',
    'export default function RootLayout({ children }: { children: ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function renderNextPage(projectName: string): string {
  return [
    'export default function HomePage() {',
    '  return (',
    '    <main style={{ padding: \'3rem\', fontFamily: \'sans-serif\' }}>',
    `      <h1>${projectName}</h1>`,
    '      <p>Next.js handles rendering. Holo powers the backend runtime and discovered server resources.</p>',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function renderNextEnvDts(): string {
  return [
    '/// <reference types="next" />',
    '/// <reference types="next/image-types/global" />',
    '',
    '// Generated by Holo. Do not edit.',
    '',
  ].join('\n')
}

function renderNextHoloHelper(): string {
  return [
    'import { createNextHoloHelpers } from \'@holo-js/adapter-next\'',
    '',
    'export const holo = createNextHoloHelpers()',
    '',
  ].join('\n')
}

function renderPublicStorageHelper(): string {
  return [
    'import { readFile, realpath } from \'node:fs/promises\'',
    'import { extname, resolve, sep } from \'node:path\'',
    'import { normalizeModuleOptions, type RuntimeDiskConfig, type HoloStorageRuntimeConfig } from \'@holo-js/storage\'',
    'import type { NormalizedHoloStorageConfig } from \'@holo-js/config\'',
    '',
    'const NAMED_PUBLIC_DISK_ROUTE_SEGMENT = \'__holo\'',
    '',
    'type PublicLocalDisk = RuntimeDiskConfig & {',
    '  driver: \'local\' | \'public\'',
    '  visibility: \'public\'',
    '  root: string',
    '}',
    '',
    'type ResolvedPublicStorageRequest = {',
    '  disk: PublicLocalDisk',
    '  absolutePath: string',
    '}',
    '',
    'function normalizeRequestPath(value: string): string[] {',
    '  return value',
    '    .split(\'/\')',
    '    .map((segment) => {',
    '      const trimmed = segment.trim()',
    '      if (!trimmed) {',
    '        return trimmed',
    '      }',
    '',
    '      try {',
    '        return decodeURIComponent(trimmed)',
    '      } catch {',
    '        return trimmed',
    '      }',
    '    })',
    '    .filter(Boolean)',
    '}',
    '',
    'function isPublicLocalDisk(disk: RuntimeDiskConfig | undefined): disk is PublicLocalDisk {',
    '  return Boolean(disk && disk.visibility === \'public\' && disk.driver !== \'s3\' && typeof disk.root === \'string\')',
    '}',
    '',
    'function resolveAbsolutePath(projectRoot: string, disk: PublicLocalDisk, fileSegments: string[]): string | null {',
    '  const root = resolve(projectRoot, disk.root)',
    '  const absolutePath = resolve(root, ...fileSegments)',
    '  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {',
    '    return null',
    '  }',
    '',
    '  return absolutePath',
    '}',
    '',
    'function resolveContentType(absolutePath: string): string {',
    '  switch (extname(absolutePath).toLowerCase()) {',
    '    case \'.avif\': return \'image/avif\'',
    '    case \'.css\': return \'text/css; charset=utf-8\'',
    '    case \'.gif\': return \'image/gif\'',
    '    case \'.html\': return \'text/html; charset=utf-8\'',
    '    case \'.jpeg\':',
    '    case \'.jpg\': return \'image/jpeg\'',
    '    case \'.js\':',
    '    case \'.mjs\': return \'text/javascript; charset=utf-8\'',
    '    case \'.json\': return \'application/json; charset=utf-8\'',
    '    case \'.mp3\': return \'audio/mpeg\'',
    '    case \'.pdf\': return \'application/pdf\'',
    '    case \'.png\': return \'image/png\'',
    '    case \'.svg\': return \'image/svg+xml\'',
    '    case \'.txt\': return \'text/plain; charset=utf-8\'',
    '    case \'.webp\': return \'image/webp\'',
    '    case \'.woff\': return \'font/woff\'',
    '    case \'.woff2\': return \'font/woff2\'',
    '    default: return \'application/octet-stream\'',
    '  }',
    '}',
    '',
    'function createMissingFileResponse(): Response {',
    '  return new Response(\'Storage file not found.\', { status: 404 })',
    '}',
    '',
    'function resolveRouteSegments(routePath: string): string[] | null {',
    '  const segments = normalizeRequestPath(routePath)',
    '  if (segments.length === 0 || segments.includes(\'..\')) {',
    '    return null',
    '  }',
    '',
    '  return segments',
    '}',
    '',
    'function resolveDefaultPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {',
    '  const disk = isPublicLocalDisk(config.disks.public) ? config.disks.public : undefined',
    '  if (!disk) {',
    '    return null',
    '  }',
    '',
    '  const absolutePath = resolveAbsolutePath(projectRoot, disk, segments)',
    '  return absolutePath ? { disk, absolutePath } : null',
    '}',
    '',
    'function usesReservedNamedDiskNamespace(segments: string[]): boolean {',
    '  return segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT',
    '}',
    '',
    'function resolveNamedPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[]): ResolvedPublicStorageRequest | null {',
    '  const namedPublicDisks = Object.values(config.disks).filter((disk): disk is PublicLocalDisk => isPublicLocalDisk(disk) && disk.name !== \'public\')',
    '  const usesReservedNamespace = segments[0] === NAMED_PUBLIC_DISK_ROUTE_SEGMENT',
    '  const diskName = usesReservedNamespace ? segments[1] : segments[0]',
    '  const disk = diskName ? namedPublicDisks.find(candidate => candidate.name === diskName) : undefined',
    '  if (!disk) {',
    '    return null',
    '  }',
    '',
    '  const fileSegments = usesReservedNamespace ? segments.slice(2) : segments.slice(1)',
    '  if (fileSegments.length === 0) {',
    '    return null',
    '  }',
    '',
    '  const absolutePath = resolveAbsolutePath(projectRoot, disk, fileSegments)',
    '  return absolutePath ? { disk, absolutePath } : null',
    '}',
    '',
    'function resolvePublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, routePath: string): ResolvedPublicStorageRequest | null {',
    '  const segments = resolveRouteSegments(routePath)',
    '  if (!segments) {',
    '    return null',
    '  }',
    '',
    '  if (usesReservedNamedDiskNamespace(segments)) {',
    '    return resolveNamedPublicStorageRequest(projectRoot, config, segments) ?? resolveDefaultPublicStorageRequest(projectRoot, config, segments)',
    '  }',
    '',
    '  return resolveDefaultPublicStorageRequest(projectRoot, config, segments) ?? resolveNamedPublicStorageRequest(projectRoot, config, segments)',
    '}',
    '',
    'function resolveFallbackPublicStorageRequest(projectRoot: string, config: HoloStorageRuntimeConfig, segments: string[], attemptedDiskName: string): ResolvedPublicStorageRequest | null {',
    '  if (usesReservedNamedDiskNamespace(segments)) {',
    '    return null',
    '  }',
    '',
    '  const candidates = [',
    '    resolveDefaultPublicStorageRequest(projectRoot, config, segments),',
    '    resolveNamedPublicStorageRequest(projectRoot, config, segments),',
    '  ]',
    '',
    '  return candidates.find(candidate => candidate && candidate.disk.name !== attemptedDiskName) ?? null',
    '}',
    '',
    'export async function createPublicStorageResponse(projectRoot: string, storageConfig: NormalizedHoloStorageConfig, request: Request): Promise<Response> {',
    '  const normalized = normalizeModuleOptions({',
    '    defaultDisk: storageConfig.defaultDisk,',
    '    routePrefix: storageConfig.routePrefix,',
    '    disks: storageConfig.disks,',
    '  })',
    '  const pathname = new URL(request.url).pathname',
    '  const routePath = pathname.startsWith(normalized.routePrefix) ? pathname.slice(normalized.routePrefix.length) : pathname',
    '  const segments = resolveRouteSegments(routePath)',
    '',
    '  if (!segments) {',
    '    return createMissingFileResponse()',
    '  }',
    '',
    '  const resolvedRequest = resolvePublicStorageRequest(projectRoot, normalized, routePath)',
    '  if (!resolvedRequest) {',
    '    return createMissingFileResponse()',
    '  }',
    '',
    '  const tryRead = async (entry: ResolvedPublicStorageRequest): Promise<Response | null> => {',
    '    try {',
    '      const resolvedRoot = await realpath(resolve(projectRoot, entry.disk.root))',
    '      const resolvedPath = await realpath(entry.absolutePath)',
    '      if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {',
    '        return null',
    '      }',
    '',
    '      const contents = await readFile(entry.absolutePath)',
    '      return new Response(contents, {',
    '        status: 200,',
    '        headers: { \'content-type\': resolveContentType(entry.absolutePath) },',
    '      })',
    '    } catch {',
    '      return null',
    '    }',
    '  }',
    '',
    '  const primary = await tryRead(resolvedRequest)',
    '  if (primary) {',
    '    return primary',
    '  }',
    '',
    '  const fallback = resolveFallbackPublicStorageRequest(projectRoot, normalized, segments, resolvedRequest.disk.name)',
    '  return fallback ? ((await tryRead(fallback)) ?? createMissingFileResponse()) : createMissingFileResponse()',
    '}',
    '',
  ].join('\n')
}

function renderNextHealthRoute(): string {
  return [
    'import { holo } from \'@/server/holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '',
    '  return Response.json({',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderNextStorageRoute(): string {
  return [
    'import { holo } from \'@/server/holo\'',
    'import { createPublicStorageResponse } from \'@/server/lib/public-storage\'',
    '',
    'export async function GET(request: Request) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

function renderSvelteConfig(): string {
  return [
    'import adapter from \'@sveltejs/adapter-node\'',
    'import { vitePreprocess } from \'@sveltejs/vite-plugin-svelte\'',
    '',
    '/** @type {import(\'@sveltejs/kit\').Config} */',
    'const config = {',
    '  preprocess: vitePreprocess(),',
    '  kit: {',
    '    adapter: adapter(),',
    '  },',
    '}',
    '',
    'export default config',
    '',
  ].join('\n')
}

function renderSvelteHooksServer(): string {
  return [
    'import type { Handle } from \'@sveltejs/kit\'',
    'import { env } from \'$env/dynamic/private\'',
    '',
    'function normalizeStorageRoutePrefix(value: string | undefined): string {',
    '  const raw = value?.trim() ?? \'/storage\'',
    '  if (!raw || raw === \'/\') {',
    '    return \'/storage\'',
    '  }',
    '',
    '  return `/${raw.replace(/^\\/+|\\/+$/g, \'\')}`',
    '}',
    '',
    'export const handle: Handle = async ({ event, resolve }) => {',
    '  const storageRoutePrefix = normalizeStorageRoutePrefix(env.STORAGE_ROUTE_PREFIX)',
    '',
    '  if (storageRoutePrefix !== \'/storage\') {',
    '    const pathname = event.url.pathname',
    '    if (pathname === storageRoutePrefix || pathname.startsWith(`${storageRoutePrefix}/`)) {',
    '      event.url.pathname = `/storage${pathname.slice(storageRoutePrefix.length)}` || \'/storage\'',
    '    }',
    '  }',
    '',
    '  return resolve(event)',
    '}',
    '',
  ].join('\n')
}

function renderSvelteViteConfig(storageEnabled: boolean): string {
  const externals = [
    '      \'@holo-js/adapter-sveltekit\',',
    '      \'@holo-js/config\',',
    '      \'@holo-js/core\',',
    '      \'@holo-js/db\',',
    ...(storageEnabled
      ? [
          '      \'@holo-js/storage\',',
          '      \'@holo-js/storage/runtime\',',
        ]
      : []),
    '      \'better-sqlite3\',',
  ]

  return [
    'import { sveltekit } from \'@sveltejs/kit/vite\'',
    'import { defineConfig } from \'vite\'',
    '',
    'export default defineConfig({',
    '  plugins: [sveltekit()],',
    '  ssr: {',
    '    external: [',
    ...externals,
    '    ],',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderSvelteAppHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    %sveltekit.head%',
    '  </head>',
    '  <body data-sveltekit-preload-data="hover">',
    '    <div style="display: contents">%sveltekit.body%</div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

function renderSveltePage(projectName: string): string {
  return [
    `<svelte:head><title>${projectName}</title></svelte:head>`,
    '',
    '<script lang="ts">',
    `  const projectName = ${JSON.stringify(projectName)}`,
    '</script>',
    '',
    '<main class="shell">',
    '  <h1>{projectName}</h1>',
    '  <p>SvelteKit owns rendering. Holo owns config, discovery, and backend runtime services.</p>',
    '</main>',
    '',
    '<style>',
    '  .shell {',
    '    min-height: 100vh;',
    '    display: grid;',
    '    place-content: center;',
    '    gap: 1rem;',
    '    padding: 3rem;',
    '    font-family: sans-serif;',
    '  }',
    '  h1 {',
    '    margin: 0;',
    '    font-size: clamp(2.5rem, 6vw, 4rem);',
    '  }',
    '  p {',
    '    margin: 0;',
    '    max-width: 40rem;',
    '    line-height: 1.6;',
    '  }',
    '</style>',
    '',
  ].join('\n')
}

function renderSvelteHoloHelper(): string {
  return [
    'import { createSvelteKitHoloHelpers } from \'@holo-js/adapter-sveltekit\'',
    '',
    'export const holo = createSvelteKitHoloHelpers()',
    '',
  ].join('\n')
}

function renderSvelteHealthRoute(): string {
  return [
    'import { json } from \'@sveltejs/kit\'',
    'import { holo } from \'$lib/server/holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '',
    '  return json({',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderSvelteStorageRoute(): string {
  return [
    'import { holo } from \'$lib/server/holo\'',
    'import { createPublicStorageResponse } from \'../../../../server/lib/public-storage\'',
    '',
    'export async function GET({ request }: { request: Request }) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

function renderFrameworkFiles(options: ProjectScaffoldOptions): readonly ScaffoldedFile[] {
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')

  if (options.framework === 'nuxt') {
    return [
      { path: 'app.vue', contents: renderNuxtAppVue(options.projectName) },
      { path: 'nuxt.config.ts', contents: renderNuxtConfig() },
      { path: 'server/api/holo/health.get.ts', contents: renderNuxtHealthRoute() },
    ]
  }

  if (options.framework === 'next') {
    return [
      { path: 'next.config.mjs', contents: renderNextConfig(storageEnabled) },
      { path: 'next-env.d.ts', contents: renderNextEnvDts() },
      { path: 'app/layout.tsx', contents: renderNextLayout(options.projectName) },
      { path: 'app/page.tsx', contents: renderNextPage(options.projectName) },
      { path: 'app/api/holo/health/route.ts', contents: renderNextHealthRoute() },
      ...(storageEnabled
        ? [
            { path: 'app/storage/[[...path]]/route.ts', contents: renderNextStorageRoute() },
            { path: 'server/lib/public-storage.ts', contents: renderPublicStorageHelper() },
          ]
        : []),
      { path: 'server/holo.ts', contents: renderNextHoloHelper() },
    ]
  }

  return [
    { path: 'svelte.config.js', contents: renderSvelteConfig() },
    { path: 'vite.config.ts', contents: renderSvelteViteConfig(storageEnabled) },
    ...(storageEnabled
      ? [{ path: 'src/hooks.server.ts', contents: renderSvelteHooksServer() }]
      : []),
    { path: 'src/app.html', contents: renderSvelteAppHtml() },
    { path: 'src/routes/+page.svelte', contents: renderSveltePage(options.projectName) },
    { path: 'src/routes/api/holo/+server.ts', contents: renderSvelteHealthRoute() },
    ...(storageEnabled
      ? [{ path: 'src/routes/storage/[...path]/+server.ts', contents: renderSvelteStorageRoute() }]
      : []),
    { path: 'src/lib/server/holo.ts', contents: renderSvelteHoloHelper() },
    ...(storageEnabled
      ? [{ path: 'server/lib/public-storage.ts', contents: renderPublicStorageHelper() }]
      : []),
  ]
}

function renderFrameworkRunner(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  const commandName = options.framework === 'nuxt'
    ? 'nuxi'
    : options.framework === 'next'
      ? 'next'
      : 'vite'
  return [
    'import { existsSync, readFileSync } from \'node:fs\'',
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath } from \'node:url\'',
    'import { spawn } from \'node:child_process\'',
    '',
    'const mode = process.argv[2]',
    'const manifestPath = fileURLToPath(new URL(\'./project.json\', import.meta.url))',
    'const projectRoot = resolve(dirname(manifestPath), \'../..\')',
    'const manifest = JSON.parse(readFileSync(manifestPath, \'utf8\'))',
    'const framework = String(manifest.framework ?? \'\')',
    `const commandName = ${JSON.stringify(commandName)}`,
    'const commandArgs = mode === \'dev\'',
    '  ? [\'dev\']',
    '  : mode === \'build\'',
    '    ? [\'build\']',
    '    : undefined',
    '',
    'if (!commandArgs) {',
    '  console.error(`[holo] Unknown framework runner mode: ${String(mode)}`)',
    '  process.exit(1)',
    '}',
    '',
    'const binaryPath = resolve(',
    '  projectRoot,',
    '  \'node_modules\',',
    '  \'.bin\',',
    '  process.platform === \'win32\' ? `${commandName}.cmd` : commandName,',
    ')',
    '',
    'if (!existsSync(binaryPath)) {',
    '  console.error(`[holo] Missing framework binary "${commandName}" for "${framework}". Run your package manager install first.`)',
    '  process.exit(1)',
    '}',
    '',
    'const child = spawn(binaryPath, commandArgs, {',
    '  cwd: projectRoot,',
    '  env: process.env,',
    '  stdio: \'inherit\',',
    '})',
    '',
    'child.on(\'error\', (error) => {',
    '  console.error(error instanceof Error ? error.message : String(error))',
    '  process.exit(1)',
    '})',
    '',
    'child.on(\'close\', (code) => {',
    '  process.exit(code ?? 1)',
    '})',
    '',
  ].join('\n')
}

function renderScaffoldPackageJson(options: ProjectScaffoldOptions): string {
  const packageName = sanitizePackageName(options.projectName) || 'holo-app'
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const dependencies: Record<string, string> = {
    '@holo-js/cli': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/config': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/core': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/db': `^${HOLO_PACKAGE_VERSION}`,
    [DB_DRIVER_PACKAGE_NAMES[options.databaseDriver]]: `^${HOLO_PACKAGE_VERSION}`,
    'esbuild': ESBUILD_PACKAGE_VERSION,
  }
  const devDependencies: Record<string, string> = {
    'typescript': '^5.7.2',
    '@types/node': '^22.10.2',
  }

  if (options.framework === 'nuxt') {
    dependencies['nuxt'] = SCAFFOLD_FRAMEWORK_VERSIONS.nuxt
    dependencies['@holo-js/adapter-nuxt'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.nuxt
  }

  if (options.framework === 'next') {
    dependencies['next'] = SCAFFOLD_FRAMEWORK_VERSIONS.next
    dependencies['react'] = '^19.0.0'
    dependencies['react-dom'] = '^19.0.0'
    dependencies['@holo-js/adapter-next'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.next
    devDependencies['@types/react'] = '^19.0.0'
    devDependencies['@types/react-dom'] = '^19.0.0'
  }

  if (options.framework === 'sveltekit') {
    dependencies['@holo-js/adapter-sveltekit'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.sveltekit
    dependencies['@sveltejs/adapter-node'] = '^5.0.0'
    dependencies['@sveltejs/kit'] = SCAFFOLD_FRAMEWORK_VERSIONS.sveltekit
    dependencies['@sveltejs/vite-plugin-svelte'] = '^4.0.0'
    dependencies['svelte'] = '^5.0.0'
    dependencies['vite'] = '^5.0.0'
  }

  if (optionalPackages.includes('storage')) {
    dependencies['@holo-js/storage'] = SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS[options.framework]['@holo-js/storage']
  }

  if (optionalPackages.includes('events')) {
    dependencies['@holo-js/events'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('queue')) {
    dependencies['@holo-js/queue'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('validation')) {
    dependencies['@holo-js/validation'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('forms')) {
    dependencies['@holo-js/forms'] = `^${HOLO_PACKAGE_VERSION}`
  }

  return `${JSON.stringify({
    name: packageName,
    private: true,
    type: 'module',
    packageManager: resolvePackageManagerVersion(options.packageManager),
    scripts: {
      ...(options.framework === 'nuxt'
        ? { postinstall: 'nuxt prepare' }
        : {}),
      prepare: 'holo prepare',
      dev: 'holo dev',
      build: 'holo build',
      ['config:cache']: 'holo config:cache',
      ['config:clear']: 'holo config:clear',
      ['holo:dev']: 'node ./.holo-js/framework/run.mjs dev',
      ['holo:build']: 'node ./.holo-js/framework/run.mjs build',
    },
    dependencies,
    devDependencies,
  }, null, 2)}\n`
}

export async function writeProjectConfig(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  manifestPath?: string,
): Promise<string> {
  const targetPath = manifestPath ?? join(projectRoot, 'config/app.ts')
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, await serializeProjectConfig(projectRoot, config, targetPath), 'utf8')
  return targetPath
}

export async function scaffoldProject(
  projectRoot: string,
  options: ProjectScaffoldOptions,
): Promise<void> {
  const existingEntries = await readdir(projectRoot).catch(() => [] as string[])
  if (existingEntries.length > 0) {
    throw new Error(`Refusing to scaffold into a non-empty directory: ${projectRoot}`)
  }

  const { env, example } = renderScaffoldEnvFiles(options)
  const config = normalizeHoloProjectConfig()
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, config)
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')
  const queueEnabled = optionalPackages.includes('queue')
  const eventsEnabled = optionalPackages.includes('events')

  await mkdir(projectRoot, { recursive: true })
  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(join(projectRoot, '.holo-js', 'framework'), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.models), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.commands), { recursive: true })
  if (queueEnabled) {
    await mkdir(resolve(projectRoot, config.paths.jobs), { recursive: true })
  }
  if (eventsEnabled) {
    await mkdir(resolve(projectRoot, config.paths.events), { recursive: true })
    await mkdir(resolve(projectRoot, config.paths.listeners), { recursive: true })
  }
  await mkdir(resolve(projectRoot, 'server/db/factories'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/migrations'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/seeders'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/schema'), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.observers), { recursive: true })
  await mkdir(resolve(projectRoot, 'storage'), { recursive: true })
  if (storageEnabled) {
    await mkdir(resolve(projectRoot, 'storage/app/public'), { recursive: true })
  }

  await writeFile(resolve(projectRoot, 'package.json'), renderScaffoldPackageJson(options), 'utf8')
  await writeFile(resolve(projectRoot, '.gitignore'), renderScaffoldGitignore(), 'utf8')
  await writeFile(resolve(projectRoot, '.env'), env, 'utf8')
  await writeFile(resolve(projectRoot, '.env.example'), example, 'utf8')
  await writeFile(resolve(projectRoot, 'config/app.ts'), renderScaffoldAppConfig(options.projectName), 'utf8')
  await writeFile(resolve(projectRoot, 'config/database.ts'), renderScaffoldDatabaseConfig(options), 'utf8')
  if (queueEnabled) {
    await writeFile(resolve(projectRoot, 'config/queue.ts'), renderQueueConfig({
      driver: 'sync',
      defaultDatabaseConnection: 'main',
    }), 'utf8')
  }
  if (storageEnabled) {
    await writeFile(resolve(projectRoot, 'config/storage.ts'), renderStorageConfig(), 'utf8')
  }
  await writeFile(resolve(projectRoot, '.holo-js/framework/run.mjs'), renderFrameworkRunner(options), 'utf8')
  await writeFile(resolve(projectRoot, '.holo-js/framework/project.json'), `${JSON.stringify(options, null, 2)}\n`, 'utf8')
  await writeFile(resolve(projectRoot, 'tsconfig.json'), renderScaffoldTsconfig(options), 'utf8')
  await writeFile(generatedSchemaPath, renderGeneratedSchemaPlaceholder(), 'utf8')

  for (const file of renderFrameworkFiles(options)) {
    await writeTextFile(resolve(projectRoot, file.path), file.contents)
  }

  if (options.databaseDriver === 'sqlite') {
    await writeFile(resolve(projectRoot, 'storage/database.sqlite'), '', 'utf8')
  }
}

export async function ensureProjectConfig(projectRoot: string): Promise<LoadedProjectConfig> {
  const loaded = await loadProjectConfig(projectRoot)
  /* v8 ignore next 3 */
  if (loaded.manifestPath) {
    await ensureDatabaseConfig(projectRoot)
    return loaded
  }

  const manifestPath = await writeProjectConfig(projectRoot, normalizeHoloProjectConfig())
  await ensureDatabaseConfig(projectRoot)
  return {
    manifestPath,
    config: normalizeHoloProjectConfig(),
  }
}

async function ensureDatabaseConfig(projectRoot: string): Promise<string> {
  const existingPath = await resolveFirstExistingPath(projectRoot, DATABASE_CONFIG_FILE_NAMES)
  if (existingPath) {
    return existingPath
  }

  const targetPath = join(projectRoot, 'config/database.ts')
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, await serializeDatabaseConfig(projectRoot, targetPath), 'utf8')
  return targetPath
}

export function upsertProjectRegistration(
  config: NormalizedHoloProjectConfig,
  key: 'models' | 'migrations' | 'seeders',
  entry: string,
): NormalizedHoloProjectConfig {
  const next = {
    paths: config.paths,
    ...(config.database ? { database: config.database } : {}),
    models: [...config.models],
    migrations: [...config.migrations],
    seeders: [...config.seeders],
  }

  if (!next[key].includes(entry)) {
    next[key].push(entry)
    next[key].sort((left, right) => left.localeCompare(right))
  }

  return normalizeHoloProjectConfig(next)
}

export const projectInternals = {
  ensureGeneratedRegistryOwnership,
  getConfigExtensionPriority,
  isSupportedScaffoldFramework,
  isSupportedScaffoldPackageManager,
  isSupportedScaffoldStorageDisk,
  isGeneratedProjectRegistry,
  loadGeneratedProjectRegistry,
  renderFrameworkRunner,
  renderFrameworkFiles,
  renderGeneratedIndexModule,
  renderGeneratedModule,
  renderGeneratedTsconfig,
  renderScaffoldAppConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldEnvFiles,
  renderScaffoldGitignore,
  renderScaffoldPackageJson,
  renderScaffoldTsconfig,
  renderQueueConfig,
  renderQueueEnvFiles,
  renderStorageConfig,
  renderMediaConfig,
  installEventsIntoProject,
  installQueueIntoProject,
  collectImportedBindingsBySource,
  resolveProjectPackageImportSpecifier,
  resolveListenerEventNamesForDiscovery,
  resolveListenerEventNamesFromSource,
  extractListensToItems,
  hasLoadedConfigFile,
  inferConnectionDriver,
  inferDatabaseDriverFromUrl,
  upsertEventsPackageDependency,
  syncManagedDriverDependencies,
  resolveDefaultDatabaseUrl,
  resolvePackageManagerVersion,
  isSupportedQueueInstallerDriver,
  resetProjectModuleBundlerForTesting() {
    projectModuleBundler = build
  },
  sanitizePackageName,
  setProjectModuleBundlerForTesting(bundler: ProjectModuleBundler) {
    projectModuleBundler = bundler
  },
  serializeDatabaseConfig,
  serializeProjectConfig,
  scaffoldProject,
  isSupportedScaffoldOptionalPackage,
  normalizeScaffoldOptionalPackages,
  writeGeneratedProjectRegistry,
}

async function collectFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const target = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(target))
      continue
    }

    if (entry.isFile() && COMMAND_FILE_PATTERN.test(entry.name)) {
      files.push(target)
    }
  }

  return files
}

function deriveCommandNameFromPath(commandsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(commandsRoot, sourcePath))
  return relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .filter(Boolean)
    .join(':')
}

function deriveJobNameFromPath(jobsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(jobsRoot, sourcePath))
  return relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .filter(Boolean)
    .join('.')
}

function deriveEventNameFromPath(eventsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(eventsRoot, sourcePath)).replace(COMMAND_FILE_PATTERN, '')
  const derived = relativePath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  if (!derived) {
    throw new Error('[Holo Events] Derived event names require a non-empty source path.')
  }

  return derived
}

function deriveListenerIdFromPath(listenersRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(listenersRoot, sourcePath))
  const derived = relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  if (!derived) {
    throw new Error('[Holo Events] Derived listener identifiers require a non-empty source path.')
  }

  return derived
}

function resolveDiscoveredJobMetadata(
  job: NormalizedDiscoveredQueueJob,
  sourcePath: string,
  derivedName: string,
  queueConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['queue'],
): GeneratedJobRegistryEntry {
  const connection = job.connection ?? queueConfig.default

  let queue = job.queue
  if (!queue) {
    const configuredConnection = queueConfig.connections[connection]
    if (configuredConnection) {
      queue = configuredConnection.queue
    } else {
      queue = 'default'
    }
  }

  return {
    sourcePath,
    name: derivedName,
    connection,
    queue,
    ...(typeof job.tries === 'number' ? { tries: job.tries } : {}),
    ...(typeof job.backoff !== 'undefined' ? { backoff: job.backoff } : {}),
    ...(typeof job.timeout === 'number' ? { timeout: job.timeout } : {}),
  }
}

function isAppCommand(value: unknown): value is HoloAppCommand {
  return isRecord(value)
    && typeof value.description === 'string'
    && typeof value.run === 'function'
}

function resolveCommandExport(moduleValue: unknown): HoloAppCommand | undefined {
  if (isRecord(moduleValue) && isAppCommand(moduleValue.default)) {
    return moduleValue.default
  }

  if (isRecord(moduleValue)) {
    for (const value of Object.values(moduleValue)) {
      if (isAppCommand(value)) {
        return value
      }
    }
  }

  return undefined
}

function normalizeCommandAliases(value: readonly string[] | undefined): readonly string[] | undefined {
  if (!value) {
    return undefined
  }

  const normalized = [...new Set(value.map(alias => alias.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
}

function assertUniqueEntries(
  kind: 'model' | 'migration' | 'seeder' | 'command' | 'job' | 'event' | 'listener',
  entries: readonly { name: string, sourcePath: string }[],
): void {
  const seen = new Map<string, string>()

  for (const entry of entries) {
    const existing = seen.get(entry.name)
    if (existing) {
      throw new Error(`Discovered duplicate ${kind} "${entry.name}" in "${existing}" and "${entry.sourcePath}".`)
    }

    seen.set(entry.name, entry.sourcePath)
  }
}

function assertUniqueCommandTokens(entries: readonly GeneratedCommandRegistryEntry[]): void {
  const seen = new Map<string, string>()

  for (const entry of entries) {
    for (const token of [entry.name, ...entry.aliases]) {
      const existing = seen.get(token)
      if (existing) {
        throw new Error(`Discovered duplicate command token "${token}" in "${existing}" and "${entry.sourcePath}".`)
      }

      seen.set(token, entry.sourcePath)
    }
  }
}

function renderGeneratedModule(exportName: string, value: unknown): string {
  return [
    '// Generated by holo prepare. Do not edit.',
    '',
    `export const ${exportName} = ${JSON.stringify(value, null, 2)}`,
    '',
    `export default ${exportName}`,
    '',
  ].join('\n')
}

function renderGeneratedIndexModule(): string {
  return [
    '// Generated by holo prepare. Do not edit.',
    '',
    '/// <reference path="./config.d.ts" />',
    '/// <reference path="./events.d.ts" />',
    '/// <reference path="./queue.d.ts" />',
    '',
    'import metadata from \'./metadata\'',
    'import models from \'./models\'',
    'import migrations from \'./migrations\'',
    'import seeders from \'./seeders\'',
    'import commands from \'./commands\'',
    'import jobs from \'./jobs\'',
    'import events from \'./events\'',
    'import listeners from \'./listeners\'',
    '',
    'export { metadata, models, migrations, seeders, commands, jobs, events, listeners }',
    '',
    'export const registry = {',
    '  ...metadata,',
    '  models,',
    '  migrations,',
    '  seeders,',
    '  commands,',
    '  jobs,',
    '  events,',
    '  listeners,',
    '}',
    '',
    'export default registry',
    '',
  ].join('\n')
}

function renderGeneratedEventTypes(
  events: readonly GeneratedEventRegistryEntry[],
  listeners: readonly GeneratedListenerRegistryEntry[],
): string {
  const typedEventEntries = events.filter(entry => ['.ts', '.mts', '.cts'].includes(extname(entry.sourcePath)))
  const typedListenerEntries = listeners.filter(entry => ['.ts', '.mts', '.cts'].includes(extname(entry.sourcePath)))
  const eventImportNameByName = new Map(typedEventEntries.map((entry, index) => [entry.name, `holoEventModule${index}`]))
  const listenerImportNameById = new Map(typedListenerEntries.map((entry, index) => [entry.id, `holoListenerModule${index}`]))
  const imports = [
    ...typedEventEntries.map((entry, index) => {
      return `import type * as holoEventModule${index} from '${relativeImportPath(GENERATED_EVENT_TYPES_PATH, entry.sourcePath)}'`
    }),
    ...typedListenerEntries.map((entry, index) => {
      return `import type * as holoListenerModule${index} from '${relativeImportPath(GENERATED_EVENT_TYPES_PATH, entry.sourcePath)}'`
    }),
  ]

  const eventMembers = events.map((entry) => {
    const importName = eventImportNameByName.get(entry.name)
    if (!importName || !entry.exportName) {
      return `    ${JSON.stringify(entry.name)}: import('@holo-js/events').EventDefinition`
    }

    return `    ${JSON.stringify(entry.name)}: import('@holo-js/events').ExportedEventDefinition<typeof ${importName}[${JSON.stringify(entry.exportName)}]>`
  })

  const listenerMembers = listeners.map((entry) => {
    const importName = listenerImportNameById.get(entry.id)
    if (!importName || !entry.exportName) {
      return `    ${JSON.stringify(entry.id)}: import('@holo-js/events').ListenerDefinition`
    }

    return `    ${JSON.stringify(entry.id)}: Extract<typeof ${importName}[${JSON.stringify(entry.exportName)}], import('@holo-js/events').ListenerDefinition>`
  })

  return [
    '// Generated by holo prepare. Do not edit.',
    '',
    ...imports,
    ...(imports.length > 0 ? [''] : []),
    'declare module \'@holo-js/events\' {',
    '  interface HoloEventRegistry {',
    ...eventMembers,
    '  }',
    '',
    '  interface HoloListenerRegistry {',
    ...listenerMembers,
    '  }',
    '}',
    '',
    'export {}',
    '',
  ].join('\n')
}

function renderGeneratedQueueTypes(
  jobs: readonly GeneratedJobRegistryEntry[],
): string {
  const typedJobs = jobs.filter(entry => ['.ts', '.mts', '.cts'].includes(extname(entry.sourcePath)))
  const typeImportNameByJob = new Map(
    typedJobs.map((entry, index) => {
      return [entry.name, `holoQueueJobModule${index}`]
    }),
  )
  const imports = typedJobs.map((entry, index) => {
    return `import type * as holoQueueJobModule${index} from '${relativeImportPath(GENERATED_QUEUE_TYPES_PATH, entry.sourcePath)}'`
  })

  const members = jobs.map((entry) => {
    const importName = typeImportNameByJob.get(entry.name)
    if (!importName || !entry.exportName) {
      return `    ${JSON.stringify(entry.name)}: import('@holo-js/queue').QueueJobDefinition`
    }

    return `    ${JSON.stringify(entry.name)}: import('@holo-js/queue').ExportedQueueJobDefinition<typeof ${importName}[${JSON.stringify(entry.exportName)}]>`
  })

  return [
    '// Generated by holo prepare. Do not edit.',
    '',
    ...imports,
    ...(imports.length > 0 ? [''] : []),
    'declare module \'@holo-js/queue\' {',
    '  interface HoloQueueJobRegistry {',
    ...members,
    '  }',
    '}',
    '',
    'export {}',
    '',
  ].join('\n')
}

function renderGeneratedTsconfig(): string {
  return `${JSON.stringify({
    extends: '../../tsconfig.json',
    include: ['./**/*.ts', './**/*.d.ts'],
  }, null, 2)}\n`
}

function getConfigExtensionPriority(fileName: string): number {
  const extension = extname(fileName)
  const index = CONFIG_EXTENSION_PRIORITY.indexOf(extension as (typeof CONFIG_EXTENSION_PRIORITY)[number])
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER
}

async function collectProjectConfigEntries(projectRoot: string): Promise<Array<{ configName: string, filePath: string }>> {
  const configDir = resolve(projectRoot, 'config')
  const entries = await readdir(configDir, { withFileTypes: true }).catch(() => [])
  const selectedByName = new Map<string, { filePath: string, priority: number }>()

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const extension = extname(entry.name)
    if (!SUPPORTED_CONFIG_EXTENSIONS.has(extension)) {
      continue
    }

    const configName = entry.name.slice(0, entry.name.length - extension.length)
    const filePath = join(configDir, entry.name)
    const priority = getConfigExtensionPriority(entry.name)
    const current = selectedByName.get(configName)

    if (!current || priority < current.priority) {
      selectedByName.set(configName, { filePath, priority })
    }
  }

  return [...selectedByName.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([configName, entry]) => ({
      configName,
      filePath: entry.filePath,
    }))
}

function renderGeneratedConfigTypes(
  projectRoot: string,
  entries: readonly { configName: string, filePath: string }[],
): string {
  const customEntries = entries.filter(entry => !['app', 'database', 'storage', 'queue', 'media'].includes(entry.configName))

  if (customEntries.length === 0) {
    return [
      '// Generated by holo prepare. Do not edit.',
      '',
      'declare module \'@holo-js/config\' {',
      '  interface HoloConfigRegistry {}',
      '}',
      '',
      'export {}',
      '',
    ].join('\n')
  }

  const imports = customEntries.map((entry, index) => {
    return `import type holoConfig${index} from '${relativeImportPath(GENERATED_CONFIG_TYPES_PATH, makeProjectRelativePath(projectRoot, entry.filePath))}'`
  })

  const members = customEntries.map((entry, index) => {
    return `    ${JSON.stringify(entry.configName)}: typeof holoConfig${index}`
  })

  return [
    '// Generated by holo prepare. Do not edit.',
    '',
    ...imports,
    '',
    'declare module \'@holo-js/config\' {',
    '  interface HoloConfigRegistry {',
    ...members,
    '  }',
    '}',
    '',
    'export {}',
    '',
  ].join('\n')
}

async function writeFileIfChanged(path: string, contents: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === contents) {
      return
    }
  } catch {
    // File does not exist yet or cannot be read. Fall through and write it.
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

function stripGeneratedAt(registry: GeneratedProjectRegistry): Omit<GeneratedProjectRegistry, 'generatedAt'> {
  const { generatedAt: _generatedAt, ...stableRegistry } = registry
  return stableRegistry
}

async function ensureGeneratedRegistryOwnership(projectRoot: string): Promise<void> {
  await mkdir(resolve(projectRoot, GENERATED_ROOT), { recursive: true })
  await writeFileIfChanged(resolve(projectRoot, GENERATED_GITIGNORE_PATH), '*\n!.gitignore\n')
  await writeFileIfChanged(resolve(projectRoot, GENERATED_TSCONFIG_PATH), renderGeneratedTsconfig())
}

async function writeGeneratedProjectRegistry(
  projectRoot: string,
  registry: GeneratedProjectRegistry,
): Promise<void> {
  await ensureGeneratedRegistryOwnership(projectRoot)
  const configEntries = await collectProjectConfigEntries(projectRoot)
  const existingRegistry = await loadGeneratedProjectRegistry(projectRoot)
  const nextRegistry = existingRegistry && JSON.stringify(stripGeneratedAt(existingRegistry)) === JSON.stringify(stripGeneratedAt(registry))
    ? {
        ...registry,
        generatedAt: existingRegistry.generatedAt,
      }
    : registry

  await writeFileIfChanged(resolve(projectRoot, GENERATED_METADATA_PATH), renderGeneratedModule('metadata', {
    version: nextRegistry.version,
    generatedAt: nextRegistry.generatedAt,
    paths: nextRegistry.paths,
  }))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_MODELS_PATH), renderGeneratedModule('models', nextRegistry.models))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_MIGRATIONS_PATH), renderGeneratedModule('migrations', nextRegistry.migrations))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_SEEDERS_PATH), renderGeneratedModule('seeders', nextRegistry.seeders))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_COMMANDS_PATH), renderGeneratedModule('commands', nextRegistry.commands))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_JOBS_PATH), renderGeneratedModule('jobs', nextRegistry.jobs))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_EVENTS_PATH), renderGeneratedModule('events', nextRegistry.events))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_LISTENERS_PATH), renderGeneratedModule('listeners', nextRegistry.listeners))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_CONFIG_TYPES_PATH), renderGeneratedConfigTypes(projectRoot, configEntries))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_EVENT_TYPES_PATH), renderGeneratedEventTypes(nextRegistry.events, nextRegistry.listeners))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_QUEUE_TYPES_PATH), renderGeneratedQueueTypes(nextRegistry.jobs))
  await writeFileIfChanged(resolve(projectRoot, GENERATED_INDEX_PATH), renderGeneratedIndexModule())
  await writeFileIfChanged(resolve(projectRoot, GENERATED_REGISTRY_JSON_PATH), `${JSON.stringify(nextRegistry, null, 2)}\n`)
}

function isGeneratedProjectRegistry(value: unknown): value is GeneratedProjectRegistry {
  if (isRecord(value) && isRecord(value.paths)) {
    value.paths.events ??= DEFAULT_HOLO_PROJECT_PATHS.events
    value.paths.listeners ??= DEFAULT_HOLO_PROJECT_PATHS.listeners
  }

  if (isRecord(value)) {
    value.events ??= []
    value.listeners ??= []
  }

  return isRecord(value)
    && value.version === 1
    && isRecord(value.paths)
    && Array.isArray(value.models)
    && Array.isArray(value.migrations)
    && Array.isArray(value.seeders)
    && Array.isArray(value.commands)
    && Array.isArray(value.jobs)
    && Array.isArray(value.events)
    && Array.isArray(value.listeners)
}

export async function loadGeneratedProjectRegistry(
  projectRoot: string,
): Promise<GeneratedProjectRegistry | undefined> {
  const filePath = resolve(projectRoot, GENERATED_INDEX_PATH)
  if (!(await pathExists(filePath))) {
    return undefined
  }

  const moduleValue = await importProjectModule(projectRoot, filePath)
  if (isRecord(moduleValue) && isGeneratedProjectRegistry(moduleValue.default)) {
    return moduleValue.default
  }

  if (isRecord(moduleValue) && isGeneratedProjectRegistry(moduleValue.registry)) {
    return moduleValue.registry
  }

  return undefined
}

export async function discoverAppCommands(
  projectRoot: string,
  config: NormalizedHoloProjectConfig = normalizeHoloProjectConfig(),
): Promise<DiscoveredAppCommand[]> {
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, config)

  return [...registry.commands]
    .map(entry => ({
      sourcePath: entry.sourcePath,
      name: entry.name,
      aliases: entry.aliases,
      description: entry.description,
      ...(entry.usage ? { usage: entry.usage } : {}),
      async load() {
        const moduleValue = await importProjectModule(projectRoot, resolve(projectRoot, entry.sourcePath))
        const command = resolveCommandExport(moduleValue)
        if (!command) {
          throw new Error(`Discovered command "${entry.sourcePath}" does not export a Holo command.`)
        }

        return command
      },
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function resolveRegisteredPath(projectRoot: string, entry: string): string {
  return resolve(projectRoot, entry)
}

function resolveNamedExport<TValue>(
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

function resolveNamedExportEntry<TValue>(
  moduleValue: unknown,
  matcher: (value: unknown) => value is TValue,
): { exportName: string, value: TValue } | undefined {
  if (isRecord(moduleValue) && matcher(moduleValue.default)) {
    return {
      exportName: 'default',
      value: moduleValue.default,
    }
  }

  if (isRecord(moduleValue)) {
    for (const [exportName, value] of Object.entries(moduleValue)) {
      if (matcher(value)) {
        return {
          exportName,
          value,
        }
      }
    }
  }

  return undefined
}

function isCliModelReference(value: unknown): value is CliModelReference {
  return isRecord(value)
    && isRecord(value.definition)
    && value.definition.kind === 'model'
    && typeof value.definition.name === 'string'
    && typeof value.prune === 'function'
}

function isMissingGeneratedSchemaModelError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('is not present in the generated schema registry')
}

function isInactiveGeneratedModelModule(value: unknown): value is InactiveGeneratedModelModule {
  return isRecord(value) && value.holoModelPendingSchema === true
}

function isMigrationDefinition(value: unknown): value is MigrationDefinition {
  return isRecord(value)
    && typeof value.up === 'function'
}

function isSeederDefinition(value: unknown): value is SeederDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.run === 'function'
}

function resolveListenerEventNamesForDiscovery(
  listener: MinimalListenerDefinition,
  eventNamesByReference: ReadonlyMap<object, string> = new Map(),
): readonly string[] {
  return Object.freeze([...new Set(listener.listensTo.map((reference: string | { name?: string }) => {
    if (typeof reference === 'string') {
      return reference.trim()
    }

    if (typeof reference.name === 'string' && reference.name.trim()) {
      return reference.name.trim()
    }

    if (eventNamesByReference.has(reference as object)) {
      return eventNamesByReference.get(reference as object)!
    }

    throw new Error('[Holo Events] Listener event references must resolve to explicit event names before discovery registration.')
  }))])
}

function collectImportedBindingsBySource(sourceText: string): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>()
  const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g

  for (const match of sourceText.matchAll(importPattern)) {
    const clause = match[1]?.trim()
    const source = match[2]?.trim()
    if (!clause || !source) {
      continue
    }

    const namedMatch = clause.match(/\{([\s\S]+)\}/)
    const defaultClause = clause.replace(/\{[\s\S]+\}/, '').replace(/,$/, '').trim()

    if (defaultClause && defaultClause !== '*') {
      bindings.set(defaultClause, source)
    }

    if (namedMatch?.[1]) {
      for (const specifier of namedMatch[1].split(',')) {
        const trimmed = specifier.trim()
        if (!trimmed) {
          continue
        }

        const [imported, local] = trimmed.split(/\s+as\s+/)
        const bindingName = (local ?? imported)?.trim()
        if (bindingName) {
          bindings.set(bindingName, source)
        }
      }
    }
  }

  return bindings
}

function extractListensToItems(sourceText: string): readonly string[] {
  const markerIndex = sourceText.indexOf('listensTo')
  if (markerIndex < 0) {
    return []
  }

  const colonIndex = sourceText.indexOf(':', markerIndex)
  if (colonIndex < 0) {
    return []
  }

  let cursor = colonIndex + 1
  while (cursor < sourceText.length && /\s/.test(sourceText[cursor]!)) {
    cursor += 1
  }

  const startChar = sourceText[cursor]
  let depth = 0
  let inString: '"' | '\'' | '`' | undefined
  let expression = ''

  for (; cursor < sourceText.length; cursor += 1) {
    const char = sourceText[cursor]!
    expression += char

    if (inString) {
      if (char === inString && sourceText[cursor - 1] !== '\\') {
        inString = undefined
      }
      continue
    }

    if (char === '\'' || char === '"' || char === '`') {
      inString = char
      continue
    }

    if (char === '[' || char === '{' || char === '(') {
      depth += 1
      continue
    }

    if (char === ']' || char === '}' || char === ')') {
      depth -= 1
      if (depth === 0 && startChar === '[') {
        break
      }
      continue
    }

    if (depth === 0 && startChar !== '[' && (char === ',' || char === '\n' || char === '\r')) {
      expression = expression.slice(0, -1)
      break
    }
  }

  if (startChar !== '[') {
    const item = expression.trim().replace(/\s+as\s+const$/, '')
    return item ? [item] : []
  }

  return expression
    .slice(1, -1)
    .split(',')
    .map(item => item.trim().replace(/\s+as\s+const$/, ''))
    .filter(Boolean)
}

async function resolveListenerEventNamesFromSource(
  projectRoot: string,
  listenerPath: string,
  discoveredEventNamesBySourcePath: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  const sourceText = await readTextFile(listenerPath) ?? ''
  const bindingsByName = collectImportedBindingsBySource(sourceText)
  const discoveredEventNamesByExtensionlessSourcePath = new Map<string, string>(
    [...discoveredEventNamesBySourcePath.entries()].map(([sourcePath, eventName]) => {
      return [sourcePath.replace(/\.[^.]+$/, ''), eventName]
    }),
  )
  const resolvedEventNames: string[] = []

  for (const item of extractListensToItems(sourceText)) {
    const quoted = item.match(/^['"](.+)['"]$/)
    if (quoted) {
      resolvedEventNames.push(quoted[1]!.trim())
      continue
    }

    const importSource = bindingsByName.get(item)
    if (!importSource) {
      throw new Error('[Holo Events] Listener event references must resolve to explicit event names before discovery registration.')
    }

    const importedPath = makeProjectRelativePath(projectRoot, resolve(dirname(listenerPath), importSource))
    const eventName = discoveredEventNamesBySourcePath.get(importedPath)
      ?? discoveredEventNamesByExtensionlessSourcePath.get(importedPath.replace(/\.[^.]+$/, ''))
    if (!eventName) {
      throw new Error('[Holo Events] Listener event references must resolve to explicit event names before discovery registration.')
    }

    resolvedEventNames.push(eventName)
  }

  return Object.freeze([...new Set(resolvedEventNames)])
}

export async function prepareProjectDiscovery(
  projectRoot: string,
  config: NormalizedHoloProjectConfig = normalizeHoloProjectConfig(),
): Promise<GeneratedProjectRegistry> {
  const loadedConfig = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  })
  const modelsRoot = resolve(projectRoot, config.paths.models)
  const migrationsRoot = resolve(projectRoot, config.paths.migrations)
  const seedersRoot = resolve(projectRoot, config.paths.seeders)
  const commandsRoot = resolve(projectRoot, config.paths.commands)
  const jobsRoot = resolve(projectRoot, config.paths.jobs)
  const eventsRoot = resolve(projectRoot, config.paths.events)
  const listenersRoot = resolve(projectRoot, config.paths.listeners)

  const [modelFiles, migrationFiles, seederFiles, commandFiles, jobFiles, eventFiles, listenerFiles] = await Promise.all([
    collectFiles(modelsRoot),
    collectFiles(migrationsRoot),
    collectFiles(seedersRoot),
    collectFiles(commandsRoot),
    collectFiles(jobsRoot),
    collectFiles(eventsRoot),
    collectFiles(listenersRoot),
  ])

  const models: GeneratedModelRegistryEntry[] = []
  for (const filePath of modelFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    try {
      const moduleValue = await importProjectModule(projectRoot, filePath)
      const model = resolveNamedExport(moduleValue, isCliModelReference)
      if (!model) {
        if (isInactiveGeneratedModelModule(moduleValue)) {
          continue
        }

        throw new Error(`Discovered model "${relativePath}" does not export a Holo model.`)
      }

      models.push({
        sourcePath: relativePath,
        name: model.definition.name,
        prunable: Boolean(model.definition.prunable),
      })
    } catch (error) {
      if (!isMissingGeneratedSchemaModelError(error)) {
        throw error
      }
    }
  }
  assertUniqueEntries('model', models)

  const migrations: GeneratedMigrationRegistryEntry[] = []
  for (const filePath of migrationFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const migration = resolveNamedExport(moduleValue, isMigrationDefinition)
    if (!migration) {
      throw new Error(`Discovered migration "${relativePath}" does not export a Holo migration.`)
    }

    migrations.push({
      sourcePath: relativePath,
      name: migration.name ? validateMigrationName(migration.name) : inferMigrationNameFromEntry(relativePath),
    })
  }
  assertUniqueEntries('migration', migrations)

  const seeders: GeneratedSeederRegistryEntry[] = []
  for (const filePath of seederFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const seeder = resolveNamedExport(moduleValue, isSeederDefinition)
    if (!seeder) {
      throw new Error(`Discovered seeder "${relativePath}" does not export a Holo seeder.`)
    }

    seeders.push({
      sourcePath: relativePath,
      name: seeder.name,
    })
  }
  assertUniqueEntries('seeder', seeders)

  const commands: GeneratedCommandRegistryEntry[] = []
  for (const filePath of commandFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const command = resolveCommandExport(moduleValue)
    if (!command) {
      throw new Error(`Discovered command "${relativePath}" does not export a Holo command.`)
    }

    const aliases = normalizeCommandAliases(command.aliases) ?? []
    commands.push({
      sourcePath: relativePath,
      name: command.name?.trim() || deriveCommandNameFromPath(commandsRoot, filePath),
      aliases,
      description: command.description,
      ...(command.usage ? { usage: command.usage } : {}),
    })
  }
  assertUniqueEntries('command', commands)
  assertUniqueCommandTokens(commands)

  const jobs: GeneratedJobRegistryEntry[] = []
  const queueDiscovery = jobFiles.length > 0
    ? await loadQueueDiscoveryModule(projectRoot)
    : undefined
  for (const filePath of jobFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const exportedJob = resolveNamedExportEntry(
      moduleValue,
      (value): value is unknown => queueDiscovery!.isQueueJobDefinition(value),
    )
    if (!exportedJob) {
      throw new Error(`Discovered job "${relativePath}" does not export a Holo job.`)
    }

    const normalizedJob = queueDiscovery!.normalizeQueueJobDefinition(exportedJob.value)
    jobs.push({
      ...resolveDiscoveredJobMetadata(
        normalizedJob,
        relativePath,
        deriveJobNameFromPath(jobsRoot, filePath),
        loadedConfig.queue,
      ),
      exportName: exportedJob.exportName,
    })
  }
  assertUniqueEntries('job', jobs)

  const events: GeneratedEventRegistryEntry[] = []
  const eventsDiscovery = (eventFiles.length > 0 || listenerFiles.length > 0)
    ? await loadEventsDiscoveryModule(projectRoot)
    : undefined
  const eventNamesByReference = new Map<object, string>()
  const discoveredEventNamesBySourcePath = new Map<string, string>()
  for (const filePath of eventFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedEvent = resolveNamedExportEntry(
      await importProjectModule(projectRoot, filePath),
      (value): value is object => hasEventDefinitionMarker(value),
    )
    if (!exportedEvent || !eventsDiscovery!.isEventDefinition(exportedEvent.value)) {
      throw new Error(`Discovered event "${relativePath}" does not export a Holo event.`)
    }

    const normalizedEvent = eventsDiscovery!.normalizeEventDefinition(exportedEvent.value)
    const name = normalizedEvent.name?.trim() || deriveEventNameFromPath(eventsRoot, filePath)
    eventNamesByReference.set(exportedEvent.value, name)
    discoveredEventNamesBySourcePath.set(relativePath, name)
    events.push({
      sourcePath: relativePath,
      name,
      exportName: exportedEvent.exportName,
    })
  }
  assertUniqueEntries('event', events)
  const discoveredEventNames = new Set(events.map(entry => entry.name))

  const listeners: GeneratedListenerRegistryEntry[] = []
  for (const filePath of listenerFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedListener = resolveNamedExportEntry(
      await importProjectModule(projectRoot, filePath),
      (value): value is object => hasListenerDefinitionMarker(value),
    )
    if (!exportedListener || !eventsDiscovery!.isListenerDefinition(exportedListener.value)) {
      throw new Error(`Discovered listener "${relativePath}" does not export a Holo listener.`)
    }

    let eventNames: readonly string[]
    try {
      eventNames = resolveListenerEventNamesForDiscovery(
        exportedListener.value as MinimalListenerDefinition,
        eventNamesByReference,
      )
    } catch (error) {
      if (
        !(error instanceof Error)
        || error.message !== '[Holo Events] Listener event references must resolve to explicit event names before discovery registration.'
      ) {
        /* v8 ignore next 3 -- defensive passthrough for unexpected listener discovery errors */
        throw error
      }

      eventNames = await resolveListenerEventNamesFromSource(projectRoot, filePath, discoveredEventNamesBySourcePath)
    }
    const normalizedListener = eventsDiscovery!.normalizeListenerDefinition(exportedListener.value)
    const listenerId = normalizedListener.name?.trim() || deriveListenerIdFromPath(listenersRoot, filePath)
    for (const eventName of eventNames) {
      if (!discoveredEventNames.has(eventName)) {
        throw new Error(`Listener "${listenerId}" references unknown event "${eventName}".`)
      }
    }

    listeners.push({
      sourcePath: relativePath,
      id: listenerId,
      eventNames,
      exportName: exportedListener.exportName,
    })
  }
  assertUniqueEntries('listener', listeners.map(entry => ({
    name: entry.id,
    sourcePath: entry.sourcePath,
  })))
  listeners.sort((left, right) => left.id.localeCompare(right.id))

  const registry: GeneratedProjectRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    paths: {
      models: config.paths.models,
      migrations: config.paths.migrations,
      seeders: config.paths.seeders,
      commands: config.paths.commands,
      jobs: config.paths.jobs,
      events: config.paths.events,
      listeners: config.paths.listeners,
      generatedSchema: config.paths.generatedSchema,
    },
    models,
    migrations,
    seeders,
    commands,
    jobs,
    events,
    listeners,
  }

  await writeGeneratedProjectRegistry(projectRoot, registry)
  return registry
}

export async function loadRegisteredModels(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<CliModelReference[]> {
  const models: CliModelReference[] = []

  for (const entry of config.models) {
    const moduleValue = await importProjectModule(projectRoot, resolveRegisteredPath(projectRoot, entry))
    const model = resolveNamedExport(moduleValue, isCliModelReference)
    if (!model) {
      throw new Error(`Registered model "${entry}" does not export a Holo model.`)
    }

    models.push(model)
  }

  return models
}

export async function loadRegisteredMigrations(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<MigrationDefinition[]> {
  const migrations: MigrationDefinition[] = []

  for (const entry of config.migrations) {
    const moduleValue = await importProjectModule(projectRoot, resolveRegisteredPath(projectRoot, entry))
    const migration = resolveNamedExport(moduleValue, isMigrationDefinition)
    if (!migration) {
      throw new Error(`Registered migration "${entry}" does not export a Holo migration.`)
    }

    migrations.push({
      ...migration,
      name: migration.name ? validateMigrationName(migration.name) : inferMigrationNameFromEntry(entry),
    })
  }

  return migrations
}

function inferMigrationNameFromEntry(entry: string): string {
  const fileName = basename(entry, extname(entry))
  return validateMigrationName(
    fileName,
    `Registered migration "${entry}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`,
  )
}

function validateMigrationName(name: string, message?: string): string {
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new Error(
      message ?? `Migration name "${name}" must match YYYY_MM_DD_HHMMSS_description.`,
    )
  }

  return name
}

export async function loadRegisteredSeeders(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<SeederDefinition[]> {
  const seeders: SeederDefinition[] = []

  for (const entry of config.seeders) {
    const moduleValue = await importProjectModule(projectRoot, resolveRegisteredPath(projectRoot, entry))
    const seeder = resolveNamedExport(moduleValue, isSeederDefinition)
    if (!seeder) {
      throw new Error(`Registered seeder "${entry}" does not export a Holo seeder.`)
    }

    seeders.push(seeder)
  }

  return seeders
}

export function makeProjectRelativePath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(relative(projectRoot, absolutePath))
}

export function resolveDefaultArtifactPath(
  projectRoot: string,
  relativeDir: string,
  fileName: string,
): string {
  return resolve(projectRoot, relativeDir, fileName)
}

export function resolveGeneratedSchemaPath(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): string {
  return resolve(projectRoot, config.paths.generatedSchema)
}

export async function ensureGeneratedSchemaPlaceholder(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<string> {
  const filePath = resolveGeneratedSchemaPath(projectRoot, config)
  if (await pathExists(filePath)) {
    return filePath
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, renderGeneratedSchemaPlaceholder(), 'utf8')
  return filePath
}

export function stripFileExtension(filePath: string): string {
  return filePath.slice(0, filePath.length - extname(filePath).length)
}

export async function readTextFile(path: string): Promise<string | undefined> {
  if (!(await pathExists(path))) {
    return undefined
  }

  return readFile(path, 'utf8')
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

export function defaultProjectConfig(): NormalizedHoloProjectConfig {
  return normalizeHoloProjectConfig({
    paths: DEFAULT_HOLO_PROJECT_PATHS,
    models: [],
    migrations: [],
    seeders: [],
  })
}
