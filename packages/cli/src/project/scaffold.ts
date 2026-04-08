import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  loadConfigDirectory,
  holoStorageDefaults,
  type SupportedDatabaseDriver,
} from '@holo-js/config'
import {
  normalizeHoloProjectConfig,
  renderGeneratedSchemaPlaceholder,
} from '@holo-js/db'
import {
  ESBUILD_PACKAGE_VERSION,
  HOLO_PACKAGE_VERSION,
  SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS,
  SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_PACKAGE_MANAGER_VERSIONS,
} from '../metadata'
import { loadProjectConfig, resolveGeneratedSchemaPath } from './config'
import {
  DB_DRIVER_PACKAGE_NAMES,
  QUEUE_CONFIG_FILE_NAMES,
  type EventsInstallResult,
  type ProjectScaffoldOptions,
  type QueueInstallResult,
  type SupportedQueueInstallerDriver,
  type SupportedScaffoldPackageManager,
  isSupportedQueueInstallerDriver,
  normalizeScaffoldOptionalPackages,
  pathExists,
  sanitizePackageName,
} from './shared'
import {
  readTextFile,
  resolveFirstExistingPath,
  writeTextFile,
} from './runtime'

type ScaffoldedFile = {
  readonly path: string
  readonly contents: string
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

function normalizeDependencyMap(value: unknown): Record<string, string> {
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

function resolvePackageManagerVersion(value: SupportedScaffoldPackageManager): string {
  return SCAFFOLD_PACKAGE_MANAGER_VERSIONS[value]
}

function resolveDefaultDatabaseUrl(driver: SupportedDatabaseDriver): string | undefined {
  if (driver === 'sqlite') {
    return './storage/database.sqlite'
  }

  return undefined
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
    esbuild: ESBUILD_PACKAGE_VERSION,
  }
  const devDependencies: Record<string, string> = {
    typescript: '^5.7.2',
    '@types/node': '^22.10.2',
  }

  if (options.framework === 'nuxt') {
    dependencies.nuxt = SCAFFOLD_FRAMEWORK_VERSIONS.nuxt
    dependencies['@holo-js/adapter-nuxt'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.nuxt
  }

  if (options.framework === 'next') {
    dependencies.next = SCAFFOLD_FRAMEWORK_VERSIONS.next
    dependencies.react = '^19.0.0'
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
    dependencies.svelte = '^5.0.0'
    dependencies.vite = '^5.0.0'
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
  await mkdir(resolve(projectRoot, '.holo-js', 'framework'), { recursive: true })
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

export {
  hasLoadedConfigFile,
  inferConnectionDriver,
  inferDatabaseDriverFromUrl,
  isSupportedQueueInstallerDriver,
  normalizeScaffoldOptionalPackages,
  renderFrameworkFiles,
  renderFrameworkRunner,
  renderMediaConfig,
  renderQueueConfig,
  renderQueueEnvFiles,
  renderScaffoldAppConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldGitignore,
  renderScaffoldPackageJson,
  renderScaffoldTsconfig,
  renderScaffoldEnvFiles,
  renderStorageConfig,
  resolveDefaultDatabaseUrl,
  resolvePackageManagerVersion,
  sanitizePackageName,
  upsertEventsPackageDependency,
}
