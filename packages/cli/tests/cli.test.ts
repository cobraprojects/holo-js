import { prepareProjectSchema } from '../src/project-prepare'
import { isIgnorableWatchError } from '../src/watch-paths'
import { copyWorkspaceDist, isWorkspaceDistCurrent, runWorkspaceBuild } from '../../../tests/support/workspace-dist'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { initializeHolo } from '@holo-js/core'
import { DB, TableQueryBuilder, createDatabase, createDialect, createSchemaService, generateMigrationTemplate } from '@holo-js/db'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import {
  stageWorkspacePackagesSync,
  resolveInstalledDependencyRoot,
  symlinkPackageDependencySync,
} from '../../../tests/support/published-package'
import type * as HoloConfigModule from '@holo-js/config'
import type * as HoloCoreModule from '@holo-js/core'
import type * as HoloDbModule from '@holo-js/db'
import type * as ProjectModule from '../src/project'
import type * as ParsingInternalModule from '../src/parsing'
import type * as CacheInternalModule from '../src/cache'
import type * as ProjectConfigInternalModule from '../src/project/config'
import type * as ProjectDiscoveryInternalModule from '../src/project/discovery'
import type * as ProjectRuntimeInternalModule from '../src/project/runtime'
import type * as ProjectScaffoldInternalModule from '../src/project/scaffold'
import type * as DevInternalModule from '../src/dev'
import type * as HoloQueueModule from '@holo-js/queue'
import type * as HoloQueueDbModule from '@holo-js/queue-db'
import type { QueueWorkerRunOptions } from '@holo-js/queue'
import {
  defineCommand,
} from '../src'
import {
  createAppCommandDefinition,
  createCommandContext,
  createInternalCommands,
  commandTokens,
  findCommand,
  findCommandConflict,
  printCommandHelp,
  printCommandList,
  resolvePackageManagerDevCommand,
  resolvePackageManagerInstallCommand,
  runCli,
} from '../src/cli'
import {
  generateProjectAppKey,
  renderEnvWithAppKey,
} from '../src/app-key'
import {
  collectMultiStringFlag,
  isInteractive,
  normalizeChoice,
  normalizeOptionalPackages,
  parseNumberFlag,
  parseTokens,
  promptChoice,
  promptMultiChoice,
  promptOptionalPackages,
  resolveBooleanFlag,
  resolveNewProjectInput,
  resolveStringFlag,
  splitCsv,
} from '../src/parsing'
import {
  cleanupRuntimeDependencyLink,
  createEnvRuntimeConfig,
  createRuntimeInvocation,
  ensureRuntimeDependencyLink,
  getRuntimeEnvironment,
  getRuntimeFailureMessage,
  inferRuntimeMigrationName,
  mergeRuntimeDatabaseConfig,
  normalizeRuntimeMigration,
  parseBooleanEnv,
  resolveConfigModuleUrl,
  runRuntimeInvocation,
  withRuntimeEnvironment,
} from '../src/runtime'
import {
  buildQueueWorkArgs,
  getQueueRuntimeEnvironment,
  hasQueueRestartSignalSince,
  initializeQueueMaintenanceEnvironment,
  isQueueListenRelevantPath,
  readQueueRestartSignal,
  resolveCliEntrypointPath,
  resolveModuleExport,
  resolveQueueRestartSignalPath,
  resolveRunnableCliEntrypoint,
  runQueueClearCommand,
  runQueueFailedCommand,
  runQueueFlushCommand,
  runQueueForgetCommand,
  runQueueRestartCommand,
  runQueueRetryCommand,
  runQueueWorkCommand,
  writeQueueRestartSignal,
} from '../src/queue'
import { runBroadcastWorkCommand } from '../src/broadcast'
import {
  loadSecurityCliModule,
  runRateLimitClearCommand,
} from '../src/security'
import {
  cacheCommandInternals,
  initializeCacheMaintenanceEnvironment,
  loadCacheCliModule,
  runCacheClearCommand,
  runCacheForgetCommand,
} from '../src/cache'
import {
  cacheMigrationInternals,
  DEFAULT_CACHE_DATABASE_LOCK_TABLE,
  DEFAULT_CACHE_DATABASE_TABLE,
  loadCacheConfig,
  normalizeCacheMigrationName,
  renderCacheTableMigration,
  resolveDatabaseCacheTables,
  runCacheTableCommand,
} from '../src/cache-migrations'
import {
  renderFailedJobsTableMigration,
  renderQueueTableMigration,
  resolveDatabaseQueueTables,
  runQueueFailedTableCommand,
  runQueueTableCommand,
} from '../src/queue-migrations'
import {
  resolvePackageManagerCommand,
  resolvePackageManagerInstallInvocation,
  runProjectDevServer,
  runProjectPrepare,
  runProjectStartServer,
} from '../src/dev'
import {
  generatorInternals,
  runMakeBroadcast,
  runMakeChannel,
  runMakeEvent,
  runMakeFactory,
  runMakeJob,
  runMakeListener,
  runMakeMail,
  runMakeMigration,
  runMakeModel,
  runMakeObserver,
  runMakeSeeder,
} from '../src/generators'
import { ensureAbsent, ensureEmptyDirectory, fileExists } from '../src/fs-utils'
import { hasProjectDependency, upsertProjectDependency } from '../src/package-json'
import {
  getRegistryMigrationSlug,
  hasRegisteredCreateTableMigration,
  hasRegisteredMigrationSlug,
  nextMigrationTemplate,
} from '../src/migrations'
import { installRealtimeIntoProject } from '../src/project/scaffold'
import {
  defaultProjectConfig,
  discoverAppCommands,
  ensureGeneratedSchemaPlaceholder,
  ensureProjectConfig,
  findProjectRoot,
  loadGeneratedProjectRegistry,
  loadRegisteredMigrations,
  loadRegisteredModels,
  loadRegisteredSeeders,
  loadProjectConfig,
  loadHoloPluginFromPackage,
  loadProjectPluginCommands,
  loadProjectPluginFrameworkDescriptors,
  prepareProjectDiscovery,
  projectInternals,
  readTextFile,
  readProjectPluginNames,
  resolveProjectPlugins,
  stripFileExtension,
  upsertProjectRegistration,
  writeProjectConfig,
  writeProjectPluginNames,
  writeTextFile,
} from '../src/project'
import {
  frameworkDescriptorSupportsManagedBroadcastAuthRoute,
  frameworkSupportsManagedBroadcastAuthRoute,
  getFrameworkDescriptor,
  getFrameworkDescriptorByIdFrom,
  getFrameworkDescriptorsWith,
  isSupportedFrameworkId,
  type FrameworkDescriptor,
} from '../src/project/frameworks'
import { normalizeHoloPluginDefinition } from '../src/project/plugins'
import { renderFrameworkAwareTsconfig, writeGeneratedProjectRegistry } from '../src/project/registry'
import {
  ensureSuffix,
  pluralize,
  relativeImportPath,
  renderNextMailViewTemplate,
  renderViewMailTemplate,
  renderGenericMailViewTemplate,
  renderBroadcastTemplate,
  renderChannelTemplate,
  renderModelTemplate,
  renderNuxtMailViewTemplate,
  renderSvelteMailViewTemplate,
  resolveNameInfo,
  splitRequestedName,
  toPascalCase,
  toSnakeCase,
} from '../src/templates'
import {
  ESBUILD_PACKAGE_VERSION,
  HOLO_PACKAGE_VERSION,
  IOREDIS_PACKAGE_VERSION,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_NUXT_DEPENDENCY_VERSIONS,
  SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS,
} from '../src/metadata'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const workspaceCatalog = (JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { workspaces: { catalog: Record<string, string> } }).workspaces.catalog
type BuiltWorkspacePackages = {
  readonly root: string
  readonly adapterNextPackageRoot: string
  readonly adapterSharedPackageRoot: string
  readonly authorizationPackageRoot: string
  readonly authPackageRoot: string
  readonly broadcastPackageRoot: string
  readonly cachePackageRoot: string
  readonly cacheDbPackageRoot: string
  readonly cacheRedisPackageRoot: string
  readonly corePackageRoot: string
  readonly configPackageRoot: string
  readonly dbPackageRoot: string
  readonly dbMysqlPackageRoot: string
  readonly dbPostgresPackageRoot: string
  readonly dbSqlitePackageRoot: string
  readonly eventsPackageRoot: string
  readonly fluxPackageRoot: string
  readonly fluxReactPackageRoot: string
  readonly kernelPackageRoot: string
  readonly mailPackageRoot: string
  readonly mediaPackageRoot: string
  readonly notificationsPackageRoot: string
  readonly queuePackageRoot: string
  readonly queueRedisPackageRoot: string
  readonly queueDbPackageRoot: string
  readonly securityPackageRoot: string
  readonly sessionPackageRoot: string
  readonly storagePackageRoot: string
  readonly storageS3PackageRoot: string
  readonly validationPackageRoot: string
  readonly cliPackageRoot: string
  readonly cliBinPath: string
  readonly packages: readonly { readonly name: string, readonly directory: string }[]
}

const tempBuildRoots: string[] = []
let builtWorkspacePackages: BuiltWorkspacePackages | null = null
const expectedHoloPackageRange = `^${HOLO_PACKAGE_VERSION}`
const nativeAppDependencies = {
  '@holo-js/config': expectedHoloPackageRange,
  '@holo-js/core': expectedHoloPackageRange,
  '@holo-js/db': expectedHoloPackageRange,
  '@holo-js/kernel': expectedHoloPackageRange,
}
const expectedNextPackageRange = SCAFFOLD_FRAMEWORK_VERSIONS.next
const expectedNuxtPackageRange = SCAFFOLD_FRAMEWORK_VERSIONS.nuxt
const expectedSvelteKitPackageRange = SCAFFOLD_FRAMEWORK_VERSIONS.sveltekit
const expectedVueRouterPackageRange = SCAFFOLD_NUXT_DEPENDENCY_VERSIONS['vue-router']
const expectedSvelteCheckPackageRange = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['svelte-check']
const expectedSvelteVitePluginPackageRange = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['@sveltejs/vite-plugin-svelte']
const outdatedHoloPackageRange = '^0.0.1'

function createTempBuildRootSync(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempBuildRoots.push(root)
  return root
}


function ensureBuiltWorkspacePackagesSync(): BuiltWorkspacePackages {
  if (builtWorkspacePackages) {
    return builtWorkspacePackages
  }

  const root = createTempBuildRootSync('holo-cli-build-')
  const adapterNextPackageRoot = join(root, 'packages/adapter-next')
  const adapterSharedPackageRoot = join(root, 'packages/adapter-shared')
  const authorizationPackageRoot = join(root, 'packages/authorization')
  const authPackageRoot = join(root, 'packages/auth')
  const cachePackageRoot = join(root, 'packages/cache')
  const cacheDbPackageRoot = join(root, 'packages/cache-db')
  const cacheRedisPackageRoot = join(root, 'packages/cache-redis')
  const dbPackageRoot = join(root, 'packages/db')
  const dbSqlitePackageRoot = join(root, 'packages/db-sqlite')
  const dbPostgresPackageRoot = join(root, 'packages/db-postgres')
  const dbMysqlPackageRoot = join(root, 'packages/db-mysql')
  const corePackageRoot = join(root, 'packages/core')
  const configPackageRoot = join(root, 'packages/config')
  const kernelPackageRoot = join(root, 'packages/kernel')
  const queuePackageRoot = join(root, 'packages/queue')
  const queueRedisPackageRoot = join(root, 'packages/queue-redis')
  const queueDbPackageRoot = join(root, 'packages/queue-db')
  const eventsPackageRoot = join(root, 'packages/events')
  const broadcastPackageRoot = join(root, 'packages/broadcast')
  const fluxPackageRoot = join(root, 'packages/flux')
  const fluxReactPackageRoot = join(root, 'packages/flux-react')
  const mailPackageRoot = join(root, 'packages/mail')
  const mediaPackageRoot = join(root, 'packages/media')
  const notificationsPackageRoot = join(root, 'packages/notifications')
  const securityPackageRoot = join(root, 'packages/security')
  const sessionPackageRoot = join(root, 'packages/session')
  const storagePackageRoot = join(root, 'packages/storage')
  const storageS3PackageRoot = join(root, 'packages/storage-s3')
  const validationPackageRoot = join(root, 'packages/validation')
  const cliPackageRoot = join(root, 'packages/cli')

  const packages = stageWorkspacePackagesSync(
    workspaceRoot,
    join(root, 'packages'),
    Object.keys(workspaceCatalog).filter(name => name.startsWith('@holo-js/')),
  )
  // The built runtime loads each package's optional peers from that package's own location, as an app install provides them.
  for (const { directory } of packages) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { peerDependencies?: Record<string, string> }
    for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
      const peer = packages.find(({ name }) => name === peerName)
      if (peer) symlinkPackageDependencySync(join(directory, 'node_modules'), peerName, peer.directory)
    }
  }
  // The integration global setup rebuilds stale workspace packages before any worker starts, so each dist copied here is
  // current. A stale one means that setup did not run, and building it here would block this worker's event loop.
  for (const { name, directory } of packages) {
    const workspacePackageRoot = join(workspaceRoot, 'packages', basename(directory))
    if (!isWorkspaceDistCurrent(workspacePackageRoot, workspaceRoot)) {
      throw new Error(`Workspace package ${name} has no current dist. Run the cli integration suite through its test:integration script.`)
    }
    copyWorkspaceDist(join(workspacePackageRoot, 'dist'), join(directory, 'dist'))
  }

  builtWorkspacePackages = {
    root,
    adapterNextPackageRoot,
    adapterSharedPackageRoot,
    authorizationPackageRoot,
    authPackageRoot,
    broadcastPackageRoot,
    cachePackageRoot,
    cacheDbPackageRoot,
    cacheRedisPackageRoot,
    corePackageRoot,
    configPackageRoot,
    dbPackageRoot,
    dbMysqlPackageRoot,
    dbPostgresPackageRoot,
    dbSqlitePackageRoot,
    eventsPackageRoot,
    fluxPackageRoot,
    fluxReactPackageRoot,
    kernelPackageRoot,
    mailPackageRoot,
    mediaPackageRoot,
    notificationsPackageRoot,
    queuePackageRoot,
    queueRedisPackageRoot,
    queueDbPackageRoot,
    securityPackageRoot,
    sessionPackageRoot,
    storagePackageRoot,
    storageS3PackageRoot,
    validationPackageRoot,
    cliPackageRoot,
    cliBinPath: join(cliPackageRoot, 'dist/bin/holo.mjs'),
    packages,
  }

  return builtWorkspacePackages
}

async function runWorkspacePackageBuild(filter: string) {
  const root = await mkdtemp(join(tmpdir(), 'holo-package-build-'))
  tempBuildRoots.push(root)
  const outDir = join(root, 'dist')
  const result = await runWorkspaceBuild(filter, workspaceRoot, { ...process.env, HOLO_BUILD_OUT_DIR: outDir })

  return {
    ...result,
    outDir,
  }
}

async function linkWorkspaceCli(projectRoot: string): Promise<void> {
  const { cliPackageRoot, cliBinPath } = ensureBuiltWorkspacePackagesSync()
  const packagesDir = join(projectRoot, 'node_modules')
  const binariesDir = join(packagesDir, '.bin')
  await mkdir(packagesDir, { recursive: true })
  await mkdir(binariesDir, { recursive: true })
  await linkWorkspaceDb(projectRoot)
  await rm(join(packagesDir, '@holo-js', 'cli'), { recursive: true, force: true }).catch(() => {})
  await rm(join(binariesDir, 'holo'), { force: true }).catch(() => {})
  await symlink(cliPackageRoot, join(packagesDir, '@holo-js', 'cli')).catch(() => {})
  await symlink(cliBinPath, join(binariesDir, 'holo')).catch(() => {})
}

async function linkWorkspaceAuthFlowPackages(projectRoot: string): Promise<void> {
  const {
    adapterNextPackageRoot,
    adapterSharedPackageRoot,
    authorizationPackageRoot,
    authPackageRoot,
    broadcastPackageRoot,
    cachePackageRoot,
    cacheDbPackageRoot,
    cacheRedisPackageRoot,
    corePackageRoot,
    dbMysqlPackageRoot,
    dbPostgresPackageRoot,
    dbSqlitePackageRoot,
    eventsPackageRoot,
    fluxPackageRoot,
    fluxReactPackageRoot,
    kernelPackageRoot,
    mailPackageRoot,
    mediaPackageRoot,
    notificationsPackageRoot,
    queuePackageRoot,
    queueRedisPackageRoot,
    queueDbPackageRoot,
    securityPackageRoot,
    sessionPackageRoot,
    storagePackageRoot,
    validationPackageRoot,
  } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')

  await linkWorkspaceCli(projectRoot)
  await mkdir(targetDir, { recursive: true })

  for (const [packageName, packageRoot] of [
    ['adapter-next', adapterNextPackageRoot],
    ['adapter-shared', adapterSharedPackageRoot],
    ['authorization', authorizationPackageRoot],
    ['auth', authPackageRoot],
    ['broadcast', broadcastPackageRoot],
    ['cache', cachePackageRoot],
    ['cache-db', cacheDbPackageRoot],
    ['cache-redis', cacheRedisPackageRoot],
    ['core', corePackageRoot],
    ['db-mysql', dbMysqlPackageRoot],
    ['db-postgres', dbPostgresPackageRoot],
    ['db-sqlite', dbSqlitePackageRoot],
    ['events', eventsPackageRoot],
    ['flux', fluxPackageRoot],
    ['flux-react', fluxReactPackageRoot],
    ['kernel', kernelPackageRoot],
    ['mail', mailPackageRoot],
    ['media', mediaPackageRoot],
    ['notifications', notificationsPackageRoot],
    ['queue', queuePackageRoot],
    ['queue-db', queueDbPackageRoot],
    ['queue-redis', queueRedisPackageRoot],
    ['security', securityPackageRoot],
    ['session', sessionPackageRoot],
    ['storage', storagePackageRoot],
    ['validation', validationPackageRoot],
  ] as const) {
    await rm(join(targetDir, packageName), { recursive: true, force: true }).catch(() => {})
    await symlink(packageRoot, join(targetDir, packageName)).catch(() => {})
  }
}

function parseLastJsonLine<TValue>(stdout: string): TValue {
  const line = stdout
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .at(-1)

  if (!line) {
    throw new Error('Expected command stdout to contain a JSON line.')
  }

  return JSON.parse(line) as TValue
}

function runCliProcess(
  projectRoot: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const { cliBinPath } = ensureBuiltWorkspacePackagesSync()
  linkBuiltWorkspacePackagesSync(projectRoot)

  return spawnSync('node', [cliBinPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  })
}

function linkBuiltWorkspacePackagesSync(projectRoot: string): void {
  const {
    adapterNextPackageRoot,
    adapterSharedPackageRoot,
    authorizationPackageRoot,
    authPackageRoot,
    broadcastPackageRoot,
    cachePackageRoot,
    cacheDbPackageRoot,
    cacheRedisPackageRoot,
    cliBinPath,
    cliPackageRoot,
    corePackageRoot,
    dbMysqlPackageRoot,
    dbPackageRoot,
    dbPostgresPackageRoot,
    dbSqlitePackageRoot,
    eventsPackageRoot,
    fluxPackageRoot,
    fluxReactPackageRoot,
    kernelPackageRoot,
    mailPackageRoot,
    mediaPackageRoot,
    notificationsPackageRoot,
    queueDbPackageRoot,
    queuePackageRoot,
    queueRedisPackageRoot,
    securityPackageRoot,
    sessionPackageRoot,
    storagePackageRoot,
    storageS3PackageRoot,
    validationPackageRoot,
  } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  const binariesDir = join(projectRoot, 'node_modules', '.bin')
  mkdirSync(targetDir, { recursive: true })
  mkdirSync(binariesDir, { recursive: true })

  for (const [packageName, packageRoot] of [
    ['adapter-next', adapterNextPackageRoot],
    ['adapter-shared', adapterSharedPackageRoot],
    ['authorization', authorizationPackageRoot],
    ['auth', authPackageRoot],
    ['broadcast', broadcastPackageRoot],
    ['cache', cachePackageRoot],
    ['cache-db', cacheDbPackageRoot],
    ['cache-redis', cacheRedisPackageRoot],
    ['cli', cliPackageRoot],
    ['core', corePackageRoot],
    ['db', dbPackageRoot],
    ['db-mysql', dbMysqlPackageRoot],
    ['db-postgres', dbPostgresPackageRoot],
    ['db-sqlite', dbSqlitePackageRoot],
    ['events', eventsPackageRoot],
    ['flux', fluxPackageRoot],
    ['flux-react', fluxReactPackageRoot],
    ['kernel', kernelPackageRoot],
    ['mail', mailPackageRoot],
    ['media', mediaPackageRoot],
    ['notifications', notificationsPackageRoot],
    ['queue', queuePackageRoot],
    ['queue-db', queueDbPackageRoot],
    ['queue-redis', queueRedisPackageRoot],
    ['security', securityPackageRoot],
    ['session', sessionPackageRoot],
    ['storage', storagePackageRoot],
    ['storage-s3', storageS3PackageRoot],
    ['validation', validationPackageRoot],
  ] as const) {
    const packagePath = join(targetDir, packageName)
    rmSync(packagePath, { recursive: true, force: true })
    symlinkSync(packageRoot, packagePath)
  }

  const binaryPath = join(binariesDir, 'holo')
  rmSync(binaryPath, { force: true })
  symlinkSync(cliBinPath, binaryPath)
}

function runNode(projectRoot: string, entryPath: string) {
  return spawnSync('node', [entryPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  })
}

function runNodeScript(projectRoot: string, entryPath: string, args: readonly string[]) {
  return spawnSync('node', [entryPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  })
}

function createIo(projectRoot: string, options: { tty?: boolean, input?: string } = {}) {
  const tty = options.tty === true
  const stdin = Object.assign(new PassThrough(), { isTTY: tty }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), { isTTY: tty }) as unknown as NodeJS.WriteStream
  const stderr = Object.assign(new PassThrough(), { isTTY: tty }) as unknown as NodeJS.WriteStream
  let stdoutText = ''
  let stderrText = ''

  stdout.on('data', (chunk) => {
    stdoutText += chunk.toString()
  })
  stderr.on('data', (chunk) => {
    stderrText += chunk.toString()
  })

  if (options.input) {
    stdin.write(options.input)
    stdin.end()
  }

  return {
    io: {
      cwd: projectRoot,
      stdin,
      stdout,
      stderr,
    },
    read() {
      return {
        stdout: stdoutText,
        stderr: stderrText,
      }
    },
  }
}

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holo-cli-test-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2))
  await writeProjectFile(dir, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({})
`)
  await writeProjectFile(dir, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({})
`)
  await linkWorkspaceDb(dir)
  return dir
}

async function writeFakeHoloPluginPackage(
  projectRoot: string,
  packageName = 'holo-plugin-demo',
  holoDependencies: readonly string[] = ['@holo-js/broadcast'],
): Promise<string> {
  const packageRoot = join(projectRoot, 'node_modules', ...packageName.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.2.3',
    type: 'module',
    holo: {
      plugin: './plugin.mjs',
    },
  }, null, 2))
  await writeFile(join(packageRoot, 'plugin.mjs'), `
export default {
  id: 'demo',
  name: 'Demo Plugin',
  description: 'Adds demo support.',
  contributes: {
    dependencies: {
      runtime: ['ably'],
      holo: ${JSON.stringify(holoDependencies)},
    },
    config: {
      files: ['config/demo.ts'],
      env: ['DEMO_KEY'],
    },
    framework: {
      id: 'demo-framework',
      displayName: 'Demo Framework',
      detectPackages: ['demo-framework'],
      adapterPackage: '@holo-js/adapter-demo',
      scaffold: {
        dependencies: {
          'demo-framework': '^1.0.0',
          '@holo-js/adapter-demo': '^1.0.0',
        },
        devDependencies: {},
        scripts: {},
        lintScript: 'eslint . --fix',
        typecheckScript: 'tsc -p tsconfig.json --noEmit',
        defaultUrl: 'http://localhost:4000',
        tsconfig: 'next',
      },
      runner: {
        commandName: 'demo-framework',
        buildArgs: ['build'],
        start: ['start'],
        startUsesFrameworkBinary: true,
        preloadNextRuntime: false,
        suppressSvelteKitOutput: false,
        nextDevServerConflictHandling: false,
      },
      capabilities: {
        managedBroadcastAuthRoute: false,
      },
    },
    broadcast: {
      drivers: {
        ably: {
          runtime: './broadcast.mjs',
        },
      },
    },
    runtime: {
      boot: 'holo-plugin-demo/runtime',
    },
    cli: {
      commands: './commands.mjs',
    },
    migrations: {
      publish: 'holo-plugin-demo/migrations',
    },
  },
}
`)
  await writeFile(join(packageRoot, 'commands.mjs'), `
export default {
  name: 'demo:sync',
  description: 'Run demo plugin sync.',
  async run(context) {
    context.loadProject
    context.flags
    process.stdout.write('demo plugin synced')
  },
}
`)
  await writeFile(join(packageRoot, 'broadcast.mjs'), `
export default {
  async send(input, context) {
    return {
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }
  },
}
`)
  const ablyRoot = join(projectRoot, 'node_modules/ably')
  await mkdir(ablyRoot, { recursive: true })
  await writeFile(join(ablyRoot, 'package.json'), JSON.stringify({
    name: 'ably',
    version: '2.0.0',
  }, null, 2))

  return packageRoot
}

async function createTempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'holo-cli-dir-'))
}

const shimmedPackageManagers = ['bun', 'npm', 'pnpm', 'yarn'] as const
let packageManagerShimRoot = ''
let packageManagerInstallLog = ''

function findExecutableOnPath(name: string, searchPath: string): string | undefined {
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
  }
  return undefined
}

async function createPackageManagerShims(searchPath: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-package-manager-'))
  packageManagerInstallLog = join(root, 'install-requests.log')
  for (const name of shimmedPackageManagers) {
    const realBinary = findExecutableOnPath(name, searchPath)
    const forward = realBinary ? `exec '${realBinary}' "$@"` : `echo '${name} is not installed' >&2\nexit 127`
    await writeFile(join(root, name), [
      '#!/bin/sh',
      'if [ "$1" = "install" ]; then',
      `  pwd -P >> '${packageManagerInstallLog}'`,
      '  if [ -f install-hook.cjs ]; then node install-hook.cjs || exit $?; fi',
      '  exit 0',
      'fi',
      forward,
      '',
    ].join('\n'), { mode: 0o755 })
  }
  return root
}

async function writeFrameworkSyncBinary(projectRoot: string, name: string): Promise<void> {
  const binRoot = join(projectRoot, 'node_modules', '.bin')
  await mkdir(binRoot, { recursive: true })
  await writeFile(join(binRoot, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

async function expectPackageManagerInstallRequested(projectRoot: string): Promise<void> {
  const requests = (await readFile(packageManagerInstallLog, 'utf8').catch(() => '')).split('\n')
  expect(requests).toContain(await realpath(projectRoot))
}

async function writeProjectFile(projectRoot: string, relativePath: string, contents: string): Promise<void> {
  const pathSegments = relativePath.split('/')
  if (pathSegments[0] === 'node_modules' && pathSegments[1] === '@holo-js' && pathSegments[2]) {
    const packagePath = join(projectRoot, 'node_modules', '@holo-js', pathSegments[2])
    const packageStats = await lstat(packagePath).catch(() => undefined)
    if (packageStats?.isSymbolicLink()) {
      await rm(packagePath, { recursive: true, force: true })
      await mkdir(packagePath, { recursive: true })
    }
  }
  const target = join(projectRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function linkWorkspaceExternalDependency(projectRoot: string, dependencyName: string): Promise<void> {
  const dependencyPath = join(projectRoot, 'node_modules', ...dependencyName.split('/'))
  await mkdir(dirname(dependencyPath), { recursive: true })
  await rm(dependencyPath, { recursive: true, force: true }).catch(() => {})
  await symlink(resolveInstalledDependencyRoot(workspaceRoot, dependencyName), dependencyPath).catch(() => {})
}

async function linkWorkspaceConfig(projectRoot: string): Promise<void> {
  const {
    authPackageRoot,
    broadcastPackageRoot,
    cachePackageRoot,
    configPackageRoot,
    dbPackageRoot,
    kernelPackageRoot,
    mailPackageRoot,
    mediaPackageRoot,
    notificationsPackageRoot,
    queuePackageRoot,
    securityPackageRoot,
    sessionPackageRoot,
    storagePackageRoot,
  } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await rm(join(targetDir, 'config'), { recursive: true, force: true }).catch(() => {})
  await mkdir(targetDir, { recursive: true })
  await linkWorkspaceEvents(projectRoot)
  for (const [packageName, packageRoot] of [
    ['auth', authPackageRoot],
    ['broadcast', broadcastPackageRoot],
    ['cache', cachePackageRoot],
    ['db', dbPackageRoot],
    ['kernel', kernelPackageRoot],
    ['mail', mailPackageRoot],
    ['media', mediaPackageRoot],
    ['notifications', notificationsPackageRoot],
    ['queue', queuePackageRoot],
    ['security', securityPackageRoot],
    ['session', sessionPackageRoot],
    ['storage', storagePackageRoot],
  ] as const) {
    await rm(join(targetDir, packageName), { recursive: true, force: true }).catch(() => {})
    await symlink(packageRoot, join(targetDir, packageName)).catch(() => {})
  }
  await symlink(configPackageRoot, join(targetDir, 'config')).catch(() => {})
}

async function linkWorkspaceDb(projectRoot: string): Promise<void> {
  const {
    dbMysqlPackageRoot,
    dbPackageRoot,
    dbPostgresPackageRoot,
    dbSqlitePackageRoot,
  } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await mkdir(targetDir, { recursive: true })
  await linkWorkspaceConfig(projectRoot)
  for (const [packageName, packageRoot] of [
    ['db', dbPackageRoot],
    ['db-mysql', dbMysqlPackageRoot],
    ['db-postgres', dbPostgresPackageRoot],
    ['db-sqlite', dbSqlitePackageRoot],
  ] as const) {
    await rm(join(targetDir, packageName), { recursive: true, force: true }).catch(() => {})
    await symlink(packageRoot, join(targetDir, packageName)).catch(() => {})
  }
}

async function linkWorkspaceQueue(projectRoot: string): Promise<void> {
  const { queuePackageRoot } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await mkdir(targetDir, { recursive: true })
  await rm(join(targetDir, 'queue'), { recursive: true, force: true }).catch(() => {})
  await symlink(queuePackageRoot, join(targetDir, 'queue')).catch(() => {})
}

async function linkWorkspaceEvents(projectRoot: string): Promise<void> {
  const { eventsPackageRoot } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await mkdir(targetDir, { recursive: true })
  await linkWorkspaceQueue(projectRoot)
  await rm(join(targetDir, 'events'), { recursive: true, force: true }).catch(() => {})
  await symlink(eventsPackageRoot, join(targetDir, 'events')).catch(() => {})
}

async function linkWorkspaceBroadcast(projectRoot: string): Promise<void> {
  const { broadcastPackageRoot } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await mkdir(targetDir, { recursive: true })
  await rm(join(targetDir, 'broadcast'), { recursive: true, force: true }).catch(() => {})
  await symlink(broadcastPackageRoot, join(targetDir, 'broadcast')).catch(() => {})
  await linkWorkspaceExternalDependency(projectRoot, 'valibot')
}

async function linkWorkspaceAuthorization(projectRoot: string): Promise<void> {
  const { authorizationPackageRoot } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await mkdir(targetDir, { recursive: true })
  await rm(join(targetDir, 'authorization'), { recursive: true, force: true }).catch(() => {})
  await symlink(authorizationPackageRoot, join(targetDir, 'authorization')).catch(() => {})
}



function linkNativeFramework(projectRoot: string, framework: 'nuxt' | 'sveltekit'): void {
  const dependencies = framework === 'nuxt'
    ? ['nuxt', '@nuxt/kit', 'vue', 'vue-router']
    : ['@sveltejs/kit', '@sveltejs/adapter-node', '@sveltejs/vite-plugin-svelte', 'svelte', 'vite']
  const nodeModulesRoot = join(projectRoot, 'node_modules')
  for (const dependency of dependencies) {
    symlinkPackageDependencySync(nodeModulesRoot, dependency, resolveInstalledDependencyRoot(workspaceRoot, dependency))
  }
  symlinkPackageDependencySync(nodeModulesRoot, `@holo-js/adapter-${framework}`, join(workspaceRoot, 'packages', `adapter-${framework}`))
}

const tempDirs: string[] = []
let inheritedPath: string | undefined

beforeAll(async () => {
  ensureBuiltWorkspacePackagesSync()
  inheritedPath = process.env.PATH
  packageManagerShimRoot = await createPackageManagerShims(inheritedPath ?? '')
  process.env.PATH = `${packageManagerShimRoot}${delimiter}${inheritedPath ?? ''}`
}, 300_000)

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

afterAll(async () => {
  if (inheritedPath === undefined) delete process.env.PATH
  else process.env.PATH = inheritedPath
  if (packageManagerShimRoot) await rm(packageManagerShimRoot, { recursive: true, force: true })
  for (const root of tempBuildRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('Holo CLI', () => {
  it.each(['--version', '-v'])('prints the installed CLI version for %s outside a project', async (flag) => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'holo-cli-version-'))
    tempDirs.push(workingDirectory)
    const versionIo = createIo(workingDirectory)

    await expect(runCli([flag], versionIo.io)).resolves.toBe(0)
    expect(versionIo.read()).toEqual({
      stdout: `${HOLO_PACKAGE_VERSION}\n`,
      stderr: '',
    })
  })

  it('lists internal commands and auto-discovers nested app commands', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'server/commands/courses/reindex.ts', `
export default {
  description: 'Reindex course data.',
  async run() {
    console.log('courses reindexed')
  },
}
`)

    const listed = runCliProcess(projectRoot, ['list'])
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain('Usage:')
    expect(listed.stdout).toContain('  holo <command> [options] [arguments]')
    expect(listed.stdout).toContain('Internal commands:')
    expect(listed.stdout).toContain('  list                            List all available internal and app commands.')
    expect(listed.stdout).toContain('  make:broadcast                  Create and register a broadcast definition file.')
    expect(listed.stdout).toContain('  make:channel                    Create and register a channel authorization definition file.')
    expect(listed.stdout).toContain('  make:job                        Create and register a queue job file.')
    expect(listed.stdout).toContain('  make:mail                       Create a mail definition file.')
    expect(listed.stdout).toContain('  make:model                      Create a model and optionally related database artifacts.')
    expect(listed.stdout).toContain('App commands:')
    expect(listed.stdout).toContain('  courses:reindex                 Reindex course data.')

    const executed = runCliProcess(projectRoot, ['courses:reindex'])
    expect(executed.status).toBe(0)
    expect(executed.stdout).toContain('courses reindexed')
  }, 90000)

  it('loads and activates Holo plugin packages from package manifests', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeFakeHoloPluginPackage(projectRoot)

    const loadedPlugin = await loadHoloPluginFromPackage(projectRoot, 'holo-plugin-demo')
    expect(loadedPlugin.definition).toMatchObject({
      id: 'demo',
      name: 'Demo Plugin',
      description: 'Adds demo support.',
    })
    expect(loadedPlugin.definition.contributes?.dependencies?.runtime).toEqual(['ably'])
    expect(loadedPlugin.definition.contributes?.broadcast?.drivers?.ably).toEqual({
      runtime: './broadcast.mjs',
    })

    await expect(readProjectPluginNames(projectRoot)).resolves.toEqual([])
    await expect(writeProjectPluginNames(projectRoot, ['holo-plugin-demo'])).resolves.toBe(true)
    await expect(readProjectPluginNames(projectRoot)).resolves.toEqual(['holo-plugin-demo'])

    const appConfig = await readFile(join(projectRoot, 'config/app.ts'), 'utf8')
    expect(appConfig).toContain('plugins: [')
    expect(appConfig).toContain('"holo-plugin-demo"')

    const resolvedPlugins = await resolveProjectPlugins(projectRoot)
    expect(resolvedPlugins).toHaveLength(1)
    expect(resolvedPlugins[0]?.loaded?.definition.id).toBe('demo')

    const pluginCommands = await loadProjectPluginCommands(projectRoot)
    expect(pluginCommands).toHaveLength(1)
    expect(pluginCommands[0]?.name).toBe('demo:sync')
    expect(pluginCommands[0]?.aliases).toBeUndefined()
    await expect(pluginCommands[0]?.load()).resolves.toMatchObject({
      name: 'demo:sync',
      description: 'Run demo plugin sync.',
    })

    const pluginFrameworks = await loadProjectPluginFrameworkDescriptors(projectRoot)
    expect(pluginFrameworks[0]?.id).toBe('demo-framework')
  }, 90000)

  it('normalizes plugin command aliases before registering commands', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const packageRoot = await writeFakeHoloPluginPackage(projectRoot)
    await writeFile(join(packageRoot, 'commands.mjs'), `
export default {
  name: 'demo:sync',
  aliases: [' demo ', '', 'demo', 'demo'],
  description: 'Run demo plugin sync.',
  async run() {},
}
`)
    await writeProjectPluginNames(projectRoot, ['holo-plugin-demo'])

    const pluginCommands = await loadProjectPluginCommands(projectRoot)

    expect(pluginCommands[0]?.aliases).toEqual(['demo'])
  }, 90000)

  it('replaces quoted plugin config keys without duplicating the property', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  "plugins": [
    "holo-plugin-old",
  ],
  paths: {},
})
`)

    await expect(writeProjectPluginNames(projectRoot, ['holo-plugin-z', 'holo-plugin-a'])).resolves.toBe(true)

    const appConfig = await readFile(join(projectRoot, 'config/app.ts'), 'utf8')
    expect(appConfig.match(/plugins/g)).toHaveLength(1)
    expect(appConfig.indexOf('"holo-plugin-z"')).toBeLessThan(appConfig.indexOf('"holo-plugin-a"'))
    expect(appConfig).not.toContain('holo-plugin-old')
  }, 90000)

  it('refuses to rewrite non-literal plugin config without duplicating the property', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

const activePlugins = ['holo-plugin-old']

export default defineAppConfig({
  plugins: activePlugins,
  paths: {},
})
`)

    await expect(readProjectPluginNames(projectRoot)).resolves.toEqual(['holo-plugin-old'])
    await expect(writeProjectPluginNames(projectRoot, ['holo-plugin-old', 'holo-plugin-demo']))
      .rejects.toThrow('Unable to update')

    const appConfig = await readFile(join(projectRoot, 'config/app.ts'), 'utf8')
    expect(appConfig.match(/plugins/g)).toHaveLength(1)
    expect(appConfig).not.toContain('holo-plugin-demo')
  }, 90000)

  it('runs plugin doctor without preloading broken plugin command modules', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const packageRoot = join(projectRoot, 'node_modules/holo-plugin-broken-command')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'holo-plugin-broken-command',
      type: 'module',
      holo: {
        plugin: './plugin.mjs',
      },
    }, null, 2))
    await writeFile(join(packageRoot, 'plugin.mjs'), `
export default {
  id: 'broken-command',
  contributes: {
    cli: {
      commands: './missing.mjs',
    },
  },
}
`)
    await writeProjectPluginNames(projectRoot, ['holo-plugin-broken-command'])

    const io = createIo(projectRoot)
    await expect(import('../src/cli').then(module => module.runCli(['plugin:doctor'], io.io))).resolves.toBe(0)

    expect(io.read().stdout).toContain('Loaded holo-plugin-broken-command: broken-command')
  }, 90000)

  it('runs internal commands without preloading broken plugin command modules', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const packageRoot = join(projectRoot, 'node_modules/holo-plugin-broken-command')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'holo-plugin-broken-command',
      type: 'module',
      holo: {
        plugin: './plugin.mjs',
      },
    }, null, 2))
    await writeFile(join(packageRoot, 'plugin.mjs'), `
export default {
  id: 'broken-command',
  contributes: {
    cli: {
      commands: './missing.mjs',
    },
  },
}
`)
    await writeProjectPluginNames(projectRoot, ['holo-plugin-broken-command'])
    await ensureGeneratedSchemaPlaceholder(projectRoot, defaultProjectConfig())

    const io = createIo(projectRoot)
    await expect(import('../src/cli').then(module => module.runCli(['make:model', 'PluginSafe'], io.io))).resolves.toBe(0)
    const model = await readFile(join(projectRoot, 'server/models/PluginSafe.ts'), 'utf8')
    expect(model).toContain('defineModel(')
  }, 90000)

  it('preserves existing concrete dependency versions when re-adding dependencies', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-dependency-version-'))

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'dependency-version-fixture',
        private: true,
        dependencies: {
          vite: '^7.2.0',
        },
      }, null, 2))

      await expect(upsertProjectDependency(projectRoot, 'vite')).resolves.toBe(false)
      const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(packageJson.dependencies?.vite).toBe('^7.2.0')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('writes installed third-party dependency versions instead of latest', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-installed-dependency-version-'))

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'installed-dependency-version-fixture',
        private: true,
        dependencies: {},
      }, null, 2))
      await mkdir(join(projectRoot, 'node_modules/vite'), { recursive: true })
      await writeFile(join(projectRoot, 'node_modules/vite/package.json'), JSON.stringify({
        name: 'vite',
        version: '7.2.0',
      }, null, 2))

      await expect(upsertProjectDependency(projectRoot, 'vite')).resolves.toBe(true)
      const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(packageJson.dependencies?.vite).toBe('^7.2.0')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects uppercase dependency package names before rewriting package.json', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-invalid-dependency-name-'))

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'invalid-dependency-name-fixture',
        private: true,
        dependencies: {},
      }, null, 2))

      await expect(upsertProjectDependency(projectRoot, 'MyPlugin')).rejects.toThrow('Invalid dependency package name')
      await expect(upsertProjectDependency(projectRoot, '@Scope/Pkg')).rejects.toThrow('Invalid dependency package name')
      const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(packageJson.dependencies).toEqual({})
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('prioritizes plugin framework descriptors and rejects malformed framework contributions', () => {
    const customNextDescriptor: FrameworkDescriptor = {
      ...getFrameworkDescriptor('next'),
      displayName: 'Custom Next',
    }
    const descriptors = getFrameworkDescriptorsWith([customNextDescriptor])

    expect(getFrameworkDescriptorByIdFrom('next', descriptors)?.displayName).toBe('Custom Next')
    expect(normalizeHoloPluginDefinition({
      id: 'broken-framework-plugin',
      contributes: {
        framework: {
          id: 'broken-framework',
        },
      },
    }).contributes?.framework).toBeUndefined()
  })

  it('only advertises managed broadcast auth routes for frameworks with generated routes', () => {
    expect(frameworkSupportsManagedBroadcastAuthRoute('next')).toBe(true)
    expect(frameworkSupportsManagedBroadcastAuthRoute('nuxt')).toBe(false)
    expect(frameworkSupportsManagedBroadcastAuthRoute('sveltekit')).toBe(false)
    expect(frameworkDescriptorSupportsManagedBroadcastAuthRoute(getFrameworkDescriptor('next'))).toBe(true)
    expect(frameworkDescriptorSupportsManagedBroadcastAuthRoute(undefined)).toBe(false)
    expect(isSupportedFrameworkId('next')).toBe(true)
    expect(isSupportedFrameworkId('demo-framework')).toBe(false)
  })

  it('fails fast when a required argument is missing in non-interactive mode', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const result = runCliProcess(projectRoot, ['make:model'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing required argument: Model name.')
  }, 90000)

  it('generates app keys without requiring an openssl binary', async () => {
    expect(renderEnvWithAppKey(undefined, 'test-key')).toEqual({
      contents: 'APP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('', 'test-key')).toEqual({
      contents: 'APP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('APP_NAME=Demo\r\n', 'test-key')).toEqual({
      contents: 'APP_NAME=Demo\nAPP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('APP_NAME=Demo', 'test-key')).toEqual({
      contents: 'APP_NAME=Demo\nAPP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('APP_KEY=""\n', 'test-key')).toEqual({
      contents: 'APP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('APP_KEY = ""\n', 'test-key')).toEqual({
      contents: 'APP_KEY = test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('export APP_KEY=\'\'\n', 'test-key')).toEqual({
      contents: 'export APP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('# APP_KEY=\n', 'test-key')).toEqual({
      contents: '# APP_KEY=\nAPP_KEY=test-key\n',
      changed: true,
    })
    expect(renderEnvWithAppKey('APP_KEY=existing\n', 'test-key')).toEqual({
      contents: 'APP_KEY=existing\n',
      changed: false,
    })
    expect(renderEnvWithAppKey('APP_KEY=\'existing\'\n', 'test-key')).toEqual({
      contents: 'APP_KEY=\'existing\'\n',
      changed: false,
    })

    const generatedRoot = await createTempDirectory()
    const skippedRoot = await createTempDirectory()
    const commandRoot = await createTempDirectory()
    const commandSkippedRoot = await createTempDirectory()
    tempDirs.push(generatedRoot, skippedRoot, commandRoot, commandSkippedRoot)

    const generated = await generateProjectAppKey(generatedRoot)
    expect(generated.generated).toBe(true)
    expect(generated.key).toBeDefined()
    expect(Buffer.from(generated.key!, 'base64')).toHaveLength(32)
    await expect(readFile(join(generatedRoot, '.env'), 'utf8')).resolves.toBe(`APP_KEY=${generated.key}\n`)

    await writeProjectFile(skippedRoot, '.env', 'APP_KEY=already-set\n')
    const skipped = await generateProjectAppKey(skippedRoot)
    expect(skipped.generated).toBe(false)
    expect(skipped.key).toBeUndefined()
    await expect(readFile(join(skippedRoot, '.env'), 'utf8')).resolves.toBe('APP_KEY=already-set\n')

    await writeProjectFile(commandRoot, '.env', 'APP_KEY=\n')
    const commandIo = createIo(commandRoot)
    const keyCommand = createInternalCommands({
      ...commandIo.io,
      projectRoot: commandRoot,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }).find(command => command.name === 'key:generate')

    expect(keyCommand).toBeDefined()
    await expect(keyCommand!.run({
      projectRoot: commandRoot,
      cwd: commandRoot,
      args: [],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    })).resolves.toBeUndefined()
    const commandEnv = await readFile(join(commandRoot, '.env'), 'utf8')
    const commandKey = commandEnv.match(/^APP_KEY=(.+)$/m)?.[1]
    expect(commandKey).toBeDefined()
    expect(Buffer.from(commandKey!, 'base64')).toHaveLength(32)
    expect(commandIo.read().stdout).toContain('Generated APP_KEY')

    await writeProjectFile(commandSkippedRoot, '.env', 'APP_KEY=already-set\n')
    const skippedCommandIo = createIo(commandSkippedRoot)
    const skippedKeyCommand = createInternalCommands({
      ...skippedCommandIo.io,
      projectRoot: commandSkippedRoot,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }).find(command => command.name === 'key:generate')

    expect(skippedKeyCommand).toBeDefined()
    await expect(skippedKeyCommand!.prepare?.({ args: [], flags: {} }, {
      ...skippedCommandIo.io,
      projectRoot: commandSkippedRoot,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    })).resolves.toEqual({ args: [], flags: {} })
    await expect(skippedKeyCommand!.run({
      projectRoot: commandSkippedRoot,
      cwd: commandSkippedRoot,
      args: [],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    })).resolves.toBeUndefined()
    expect(skippedCommandIo.read().stdout).toContain('APP_KEY is already set')

    const processRoot = await createTempProject()
    tempDirs.push(processRoot)
    await writeProjectFile(processRoot, '.env', 'APP_KEY=\n')

    const processGenerated = runCliProcess(processRoot, ['key:generate'])
    expect(processGenerated.status).toBe(0)
    expect(processGenerated.stdout).toContain('Generated APP_KEY')

    const processEnv = await readFile(join(processRoot, '.env'), 'utf8')
    const processKey = processEnv.match(/^APP_KEY=(.+)$/m)?.[1]
    expect(processKey).toBeDefined()
    expect(Buffer.from(processKey!, 'base64')).toHaveLength(32)

    const processSkipped = runCliProcess(processRoot, ['key:generate'])
    expect(processSkipped.status).toBe(0)
    expect(processSkipped.stdout).toContain('APP_KEY is already set')
    await expect(readFile(join(processRoot, '.env'), 'utf8')).resolves.toBe(processEnv)
  }, 90000)

  it('generates app keys before loading project config', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.env', 'APP_KEY=\n')
    await writeProjectFile(projectRoot, 'config/app.ts', `
throw new Error('APP_KEY is required before config can load')
`)

    const commandIo = createIo(projectRoot)
    await expect(import('../src/cli').then(module => module.runCli(['key:generate'], commandIo.io))).resolves.toBe(0)
    expect(commandIo.read().stdout).toContain('Generated APP_KEY')
    expect(commandIo.read().stderr).toBe('')

    const env = await readFile(join(projectRoot, '.env'), 'utf8')
    const generatedKey = env.match(/^APP_KEY=(.+)$/m)?.[1]
    expect(generatedKey).toBeDefined()
    expect(Buffer.from(generatedKey!, 'base64')).toHaveLength(32)
  }, 90000)

  it('normalizes scaffold env segments and renders empty env file contents directly', () => {
    expect(projectInternals.normalizeScaffoldEnvSegments(`
APP_NAME=test

  # comment
APP_ENV=development
`)).toEqual([
      'APP_NAME=test',
      '# comment',
      'APP_ENV=development',
    ])
    expect(projectInternals.renderEnvFileContents(['APP_NAME=test\n', '', 'APP_ENV=development'])).toBe([
      'APP_NAME=test',
      'APP_ENV=development',
      '',
    ].join('\n'))
    expect(projectInternals.renderEnvFileContents(['', '\n'])).toBe('')
  })

  it('renders scaffolded current-auth routes that honor guard query parameters', () => {
    const renderCurrentAuthRoute = (framework: 'next' | 'nuxt' | 'sveltekit', path: string): string => {
      return projectInternals.renderFrameworkFiles({
        projectName: 'Guarded Auth App',
        framework,
        databaseDriver: 'sqlite',
        packageManager: 'bun',
        storageDefaultDisk: 'local',
        optionalPackages: ['auth'],
      }).find(file => file.path === path)?.contents ?? ''
    }

    const nextCurrentAuthRoute = renderCurrentAuthRoute('next', 'app/api/auth/user/route.ts')
    expect(nextCurrentAuthRoute).toContain('import auth, { check, isAuthError, provider, user } from \'@holo-js/auth\'')
    expect(nextCurrentAuthRoute).not.toContain('.holo-js/generated')
    expect(nextCurrentAuthRoute).not.toContain('holo.getApp')
    expect(nextCurrentAuthRoute).toContain('new URL(request.url).searchParams.get(\'guard\')')
    expect(nextCurrentAuthRoute).toContain('const guardAuth = guard ? auth.guard(guard) : undefined')
    expect(nextCurrentAuthRoute).toContain('error.code === \'guard_not_configured\'')
    expect(nextCurrentAuthRoute).toContain('{ status: 400 }')
    expect(nextCurrentAuthRoute).toContain('authenticated: guardAuth ? await guardAuth.check() : await check()')
    expect(nextCurrentAuthRoute).toContain('provider: guardAuth ? await guardAuth.provider() : await provider()')
    expect(nextCurrentAuthRoute).toContain('user: guardAuth ? await guardAuth.user() : await user()')

    const nuxtCurrentAuthRoute = renderCurrentAuthRoute('nuxt', 'server/api/auth/user.get.ts')
    expect(nuxtCurrentAuthRoute).toContain('const query = getQuery(event)')
    expect(nuxtCurrentAuthRoute).toContain('const guardAuth = guard ? auth.guard(guard) : undefined')
    expect(nuxtCurrentAuthRoute).toContain('error.code === \'guard_not_configured\'')
    expect(nuxtCurrentAuthRoute).toContain('setResponseStatus(event, 400)')
    expect(nuxtCurrentAuthRoute).toContain('authenticated: guardAuth ? await guardAuth.check() : await check()')
    expect(nuxtCurrentAuthRoute).toContain('provider: guardAuth ? await guardAuth.provider() : await provider()')
    expect(nuxtCurrentAuthRoute).toContain('user: guardAuth ? await guardAuth.user() : await user()')

    const svelteCurrentAuthRoutePaths = projectInternals.renderFrameworkFiles({
      projectName: 'Guarded Auth App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)
    expect(svelteCurrentAuthRoutePaths).not.toContain('src/routes/api/auth/user/+server.ts')
  })

  it('renders scaffolded Nuxt pages through the root component', () => {
    const appVue = projectInternals.renderFrameworkFiles({
      projectName: 'Nuxt Pages App',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    }).find(file => file.path === 'app/app.vue')?.contents

    expect(appVue).toContain('<NuxtPage />')
  })

  it('installs queue support into an existing project with sync as the default driver', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.env', 'APP_NAME=Fixture\n')
    await writeProjectFile(projectRoot, '.env.example', 'APP_NAME=\n')

    const result = runCliProcess(projectRoot, ['install', 'queue'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed queue support.')
    expect(result.stdout).toContain('created config/queue.ts')
    expect(result.stdout).toContain('updated package.json')
    expect(result.stdout).toContain('created server/jobs')

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/queue']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/queue-db']).toBeUndefined()
    expect(packageJson.dependencies?.esbuild).toBe(ESBUILD_PACKAGE_VERSION)
    expect(await readFile(join(projectRoot, 'config/queue.ts'), 'utf8')).toContain("default: env('QUEUE_CONNECTION', 'sync')")
    expect(await readFile(join(projectRoot, 'config/queue.ts'), 'utf8')).toContain('failed: false')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toBe('APP_NAME=Fixture\n\nQUEUE_CONNECTION=sync\n')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toBe('APP_NAME=\n\nQUEUE_CONNECTION=\n')
    await expect(stat(join(projectRoot, 'server/jobs'))).resolves.toBeDefined()

    const rerun = runCliProcess(projectRoot, ['install', 'queue'])
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain('Queue support is already installed.')
  })

  it('installs redis queue support additively without duplicating env keys or overwriting queue config', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    jobs: 'modules/queues/jobs',
  },
})
`)
    await writeProjectFile(projectRoot, 'config/queue.ts', 'export default "keep-me"\n')
    await writeProjectFile(projectRoot, '.env', 'APP_NAME=Fixture\nREDIS_HOST=cache.internal\n')
    await writeProjectFile(projectRoot, '.env.example', 'APP_NAME=\n')
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      devDependencies: {
        '@holo-js/queue': outdatedHoloPackageRange,
      },
    }, null, 2))

    const result = runCliProcess(projectRoot, ['install', 'queue', '--driver', 'redis'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed queue support.')
    expect(result.stdout).toContain('updated package.json')
    expect(result.stdout).toContain('updated .env')
    expect(result.stdout).toContain('updated .env.example')
    expect(result.stdout).not.toContain('created config/queue.ts')
    expect(result.stdout).toContain('created server/jobs')

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/queue']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.esbuild).toBe(ESBUILD_PACKAGE_VERSION)
    expect(packageJson.devDependencies?.['@holo-js/queue']).toBeUndefined()
    expect(packageJson.devDependencies?.esbuild).toBeUndefined()
    expect(await readFile(join(projectRoot, 'config/queue.ts'), 'utf8')).toBe('export default "keep-me"\n')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_HOST=cache.internal')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_PORT=6379')
    expect((await readFile(join(projectRoot, '.env'), 'utf8')).match(/REDIS_HOST=/g)?.length).toBe(1)
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('REDIS_HOST=')
    await expect(stat(join(projectRoot, 'modules/queues/jobs'))).resolves.toBeDefined()

    const rerun = runCliProcess(projectRoot, ['install', 'queue', '--driver', 'redis'])
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain('Installed queue support.')
    expect((await readFile(join(projectRoot, '.env.example'), 'utf8')).match(/REDIS_HOST=/g)?.length).toBe(1)
  })

  it('installs auth support into an existing project with local defaults', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'auth'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed auth support.')
    expect(result.stdout).toContain('created config/auth.ts')
    expect(result.stdout).toContain('created config/session.ts')
    expect(result.stdout).toContain('created config/security.ts')
    expect(result.stdout).toContain('created config/cors.ts')
    expect(result.stdout).toContain('created server/models/User.ts')
    expect(result.stdout).toContain('created 8 auth migrations')

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/auth']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/session']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/security']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/auth-social']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/auth-social-google']).toBeUndefined()
    expect(await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')).toContain('provider: \'users\'')
    expect(await readFile(join(projectRoot, 'config/session.ts'), 'utf8')).toContain('driver: env(\'SESSION_DRIVER\', \'file\')')
    expect(await readFile(join(projectRoot, 'config/security.ts'), 'utf8')).toContain('defineSecurityConfig')
    expect(await readFile(join(projectRoot, 'config/cors.ts'), 'utf8')).toContain('defineCorsConfig')
    expect(await readFile(join(projectRoot, 'server/models/User.ts'), 'utf8')).toContain('fillable: [\'name\', \'email\', \'password\', \'avatar\']')
    expect((await readdir(join(projectRoot, 'server/db/migrations'))).filter(entry => entry.endsWith('.ts'))).toHaveLength(8)

    const rerun = runCliProcess(projectRoot, ['install', 'auth'])
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain('Auth support is already installed.')
    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)
    const database = new DatabaseSync(join(projectRoot, 'data/database.sqlite'))
    try {
      const insert = database.prepare('INSERT INTO auth_session_revocations (provider, user_id) VALUES (?, ?)')
      insert.run('users', '1')
      insert.run('admins', '1')
      expect(() => insert.run('users', '1')).toThrow('UNIQUE constraint failed')
    } finally {
      database.close()
    }
  })


  it('installs authorization support without forcing auth and is idempotent', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const first = await projectInternals.installAuthorizationIntoProject(projectRoot)
    expect(first).toMatchObject({
      updatedPackageJson: true,
      createdPoliciesDirectory: true,
      createdAbilitiesDirectory: true,
      createdPoliciesReadme: true,
      createdAbilitiesReadme: true,
    })

    const second = await projectInternals.installAuthorizationIntoProject(projectRoot)
    expect(second).toEqual({
      updatedPackageJson: false,
      createdPoliciesDirectory: false,
      createdAbilitiesDirectory: false,
      createdPoliciesReadme: false,
      createdAbilitiesReadme: false,
    })

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/authorization']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/auth']).toBeUndefined()
    expect((await stat(join(projectRoot, 'server/policies'))).isDirectory()).toBe(true)
    expect((await stat(join(projectRoot, 'server/abilities'))).isDirectory()).toBe(true)
    expect(await readFile(join(projectRoot, 'server/policies/README.md'), 'utf8')).toContain('Authorization Policies')
    expect(await readFile(join(projectRoot, 'server/abilities/README.md'), 'utf8')).toContain('Authorization Abilities')
  })

  it('installs authorization support through the CLI and is idempotent', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const first = runCliProcess(projectRoot, ['install', 'authorization'])

    expect(first.status).toBe(0)
    expect(first.stdout).toContain('Installed authorization support.')
    expect(first.stdout).toContain('  - updated package.json')
    expect(first.stdout).toContain('  - created server/policies')
    expect(first.stdout).toContain('  - created server/abilities')
    expect(first.stdout).toContain('  - created server/policies/README.md')
    expect(first.stdout).toContain('  - created server/abilities/README.md')

    const second = runCliProcess(projectRoot, ['install', 'authorization'])

    expect(second.status).toBe(0)
    expect(second.stdout).toContain('Authorization support is already installed.')
  })

  it('keeps auth installed when authorization is added afterward', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await projectInternals.installAuthIntoProject(projectRoot)
    const result = await projectInternals.installAuthorizationIntoProject(projectRoot)

    expect(result).toMatchObject({
      updatedPackageJson: true,
      createdPoliciesDirectory: true,
      createdAbilitiesDirectory: true,
    })

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/auth']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/session']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/authorization']).toBe(expectedHoloPackageRange)
  })

  it('does not scaffold broadcast auth files when installing auth without broadcast support', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
    })

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/auth']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/broadcast']).toBeUndefined()
    await expect(stat(join(projectRoot, 'app/broadcasting/auth/route.ts'))).rejects.toThrow()
  })

  it('reuses an existing standalone session config when installing auth support', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const existingSessionConfig = `
import { defineSessionConfig } from '@holo-js/session'

export default defineSessionConfig({
  driver: 'file',
  cookie: {
    name: 'existing_session',
  },
  stores: {
    file: {
      driver: 'file',
      path: './storage/custom-sessions',
    },
  },
})
`

    await writeProjectFile(projectRoot, 'config/session.ts', existingSessionConfig)

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
      createdSessionConfig: false,
      createdUserModel: true,
      updatedPackageJson: true,
    })

    expect(await readFile(join(projectRoot, 'config/session.ts'), 'utf8')).toBe(existingSessionConfig)
    expect(await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')).toContain('guard: env(\'AUTH_GUARD\', "web")')
  })

  it('installs auth provider packages without overwriting existing auth files and rejects collisions', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const initial = await projectInternals.installAuthIntoProject(projectRoot, { social: true })
    expect(initial).toMatchObject({
      updatedPackageJson: true,
      createdAuthConfig: true,
      createdSessionConfig: true,
      createdSecurityConfig: true,
      createdCorsConfig: true,
      createdUserModel: true,
    })
    expect(initial.createdMigrationFiles).toHaveLength(8)
    expect(await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')).toContain('AUTH_GOOGLE_CLIENT_ID')

    await expect(projectInternals.installAuthIntoProject(projectRoot, { workos: true, clerk: true })).resolves.toEqual({
      updatedPackageJson: true,
      createdAuthConfig: true,
      createdSessionConfig: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: true,
      updatedEnvExample: true,
    })
    const rerunAuthConfig = await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')
    expect(rerunAuthConfig).toContain('AUTH_GOOGLE_CLIENT_ID')
    expect(rerunAuthConfig).toContain('WORKOS_CLIENT_ID')
    expect(rerunAuthConfig).toContain('CLERK_PUBLISHABLE_KEY')
    const rerunEnv = await readFile(join(projectRoot, '.env'), 'utf8')
    expect(rerunEnv).toContain('AUTH_GOOGLE_CLIENT_ID=')
    expect(rerunEnv).toContain('WORKOS_CLIENT_ID=')
    expect(rerunEnv).toContain('CLERK_PUBLISHABLE_KEY=')
    expect(rerunEnv).toContain('CLERK_REDIRECT_URI=')
    const rerunEnvExample = await readFile(join(projectRoot, '.env.example'), 'utf8')
    expect(rerunEnvExample).toContain('CLERK_REDIRECT_URI=')

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies?.['@holo-js/auth-social']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/auth-social-google']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/auth-workos']).toBe(expectedHoloPackageRange)
    expect(packageJson.dependencies?.['@holo-js/auth-clerk']).toBe(expectedHoloPackageRange)

    const collisionRoot = await createTempProject()
    tempDirs.push(collisionRoot)
    await writeProjectFile(collisionRoot, 'server/models/User.ts', 'export default null\n')
    await expect(projectInternals.installAuthIntoProject(collisionRoot)).rejects.toThrow('Auth support is partially installed.')
  }, 90000)

  it('treats an existing session config as part of partial auth collisions once auth artifacts already exist', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/session.ts', `
import { defineSessionConfig } from '@holo-js/session'

export default defineSessionConfig({
  driver: 'file',
})
`)
    await writeProjectFile(projectRoot, 'server/models/User.ts', 'export default null\n')

    await expect(projectInternals.installAuthIntoProject(projectRoot)).rejects.toThrow('config/session.ts')
  })

  it('refuses to overwrite manually edited auth config when adding auth features', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await expect(projectInternals.installAuthIntoProject(projectRoot, { social: true })).resolves.toMatchObject({
      createdAuthConfig: true,
    })

    await writeProjectFile(projectRoot, 'config/auth.ts', `
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  defaults: {
    guard: 'admin',
    passwords: 'users',
  },
  guards: {
    admin: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
    },
  },
})
`)

    await expect(projectInternals.installAuthIntoProject(projectRoot, { workos: true })).rejects.toThrow(
      'Refusing to overwrite the existing auth config automatically.',
    )
    expect(await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')).toContain('guard: \'admin\'')
  })

  it('moves auth packages from devDependencies and no-ops when auth dependencies already match', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      devDependencies: {
        '@holo-js/auth': outdatedHoloPackageRange,
        '@holo-js/session': outdatedHoloPackageRange,
        '@holo-js/auth-social': outdatedHoloPackageRange,
        '@holo-js/auth-social-google': outdatedHoloPackageRange,
        '@holo-js/auth-social-discord': outdatedHoloPackageRange,
        '@holo-js/auth-clerk': outdatedHoloPackageRange,
      },
    }, null, 2))

    await expect(projectInternals.installAuthIntoProject(projectRoot, { social: true })).resolves.toMatchObject({
      updatedPackageJson: true,
      updatedEnv: true,
      updatedEnvExample: true,
    })

    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/auth': expectedHoloPackageRange,
        '@holo-js/session': expectedHoloPackageRange,
        '@holo-js/auth-social': expectedHoloPackageRange,
        '@holo-js/auth-social-google': expectedHoloPackageRange,
      },
    })
    const packageJsonAfterInstall = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(packageJsonAfterInstall.dependencies?.['@holo-js/auth-clerk']).toBeUndefined()
    expect(packageJsonAfterInstall.devDependencies?.['@holo-js/auth-clerk']).toBeUndefined()
    expect(packageJsonAfterInstall.dependencies?.['@holo-js/auth-social-discord']).toBeUndefined()
    expect(packageJsonAfterInstall.devDependencies?.['@holo-js/auth-social-discord']).toBeUndefined()

    await expect(projectInternals.installAuthIntoProject(projectRoot, { social: true })).resolves.toEqual({
      updatedPackageJson: false,
      createdAuthConfig: false,
      createdSessionConfig: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: false,
      updatedEnvExample: false,
    })
  }, 20_000)

  it('uses the project default database connection when updating auth env files', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'primary',
  connections: {
    primary: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toMatchObject({
      updatedEnv: true,
      updatedEnvExample: true,
    })

    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('SESSION_CONNECTION=primary')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('SESSION_CONNECTION=')
  })

  it('recognizes existing CommonJS auth config and auth migrations as already installed', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await rm(join(projectRoot, 'config', 'auth.ts'), { force: true })
    await rm(join(projectRoot, 'config', 'session.ts'), { force: true })
    await writeProjectFile(projectRoot, 'config/auth.cjs', `
module.exports = {
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
    },
  },
}
`)
    await writeProjectFile(projectRoot, 'config/session.cjs', `
module.exports = {
  driver: 'file',
  stores: {
    database: {
      driver: 'database',
      connection: 'main',
      table: 'sessions',
    },
    file: {
      driver: 'file',
      path: './storage/framework/sessions',
    },
  },
}
`)
    await writeProjectFile(projectRoot, 'server/models/User.ts', projectInternals.renderAuthUserModel('../../.holo-js/generated/schema.generated'))
    await rm(join(projectRoot, 'server/db/migrations'), { recursive: true, force: true })
    await mkdir(join(projectRoot, 'server/db/migrations'), { recursive: true })

    let index = 0
    for (const slug of [
      'create_users',
      'create_sessions',
      'create_auth_identities',
      'create_personal_access_tokens',
      'create_password_reset_tokens',
      'create_email_verification_tokens',
      'create_auth_multi_factor_credentials',
      'create_auth_session_revocations',
    ] as const) {
      const timestamp = `2026_01_01_00000${index + 1}`
      await writeProjectFile(
        projectRoot,
        `server/db/migrations/${timestamp}_${slug}.cjs`,
        projectInternals.renderAuthMigration(slug),
      )
      index += 1
    }

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toEqual({
      updatedPackageJson: true,
      createdAuthConfig: false,
      createdSessionConfig: false,
      createdSecurityConfig: true,
      createdCorsConfig: true,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: true,
      updatedEnvExample: true,
    })

    await expect(stat(join(projectRoot, 'config/auth.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'config/session.ts'))).rejects.toThrow()
  })

  it('updates generated CommonJS auth configs when enabling additional auth features', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
      createdSessionConfig: true,
      createdUserModel: true,
    })

    await rm(join(projectRoot, 'config', 'auth.ts'), { force: true })
    await writeProjectFile(projectRoot, 'config/auth.cjs', projectInternals.renderAuthConfig({}, 'cjs'))

    await expect(projectInternals.installAuthIntoProject(projectRoot, {
      social: true,
      workos: true,
      clerk: true,
    })).resolves.toEqual({
      updatedPackageJson: true,
      createdAuthConfig: true,
      createdSessionConfig: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: true,
      updatedEnvExample: true,
    })

    const authConfig = await readFile(join(projectRoot, 'config/auth.cjs'), 'utf8')
    expect(authConfig).toContain('module.exports = {')
    expect(authConfig).toContain('AUTH_GOOGLE_CLIENT_ID')
    expect(authConfig).toContain('WORKOS_CLIENT_ID')
    expect(authConfig).toContain('CLERK_PUBLISHABLE_KEY')
  })

  it('updates auth features even when auth relies on the default session runtime config', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
      createdSessionConfig: true,
      createdUserModel: true,
    })

    await rm(join(projectRoot, 'config', 'session.ts'), { force: true })

    await expect(projectInternals.installAuthIntoProject(projectRoot, {
      social: true,
      workos: true,
      clerk: true,
    })).resolves.toEqual({
      updatedPackageJson: true,
      createdAuthConfig: true,
      createdSessionConfig: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: true,
      updatedEnvExample: true,
    })

    const authConfig = await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')
    expect(authConfig).toContain('AUTH_GOOGLE_CLIENT_ID')
    expect(authConfig).toContain('WORKOS_CLIENT_ID')
    expect(authConfig).toContain('CLERK_PUBLISHABLE_KEY')
    await expect(stat(join(projectRoot, 'config/session.ts'))).rejects.toThrow()
  }, 20_000)

  it('uses configured project paths when scaffolding the auth User model', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    models: 'app/models',
    generatedSchema: 'app/db/schema.generated.ts',
  },
})
`)

    await expect(projectInternals.installAuthIntoProject(projectRoot)).resolves.toMatchObject({
      createdUserModel: true,
    })

    expect(await readFile(join(projectRoot, 'app/models/User.ts'), 'utf8')).toContain(
      "import { defineModel } from '@holo-js/db'",
    )
  })

  it('rejects unsupported or missing install targets and invalid queue drivers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const missingTarget = runCliProcess(projectRoot, ['install'])
    expect(missingTarget.status).toBe(1)
    expect(missingTarget.stderr).toContain('Missing required argument: Install target.')

    const unsupportedTarget = runCliProcess(projectRoot, ['install', 'mailer'])
    expect(unsupportedTarget.status).toBe(1)
    expect(unsupportedTarget.stderr).toContain('Unsupported install target: mailer. Expected one of queue, events, auth, authorization, notifications, mail, broadcast, realtime, security, cache, media.')

    const unsupportedDriver = runCliProcess(projectRoot, ['install', 'queue', '--driver', 'sqs'])
    expect(unsupportedDriver.status).toBe(1)
    expect(unsupportedDriver.stderr).toContain('Unsupported queue driver: sqs. Expected one of sync, redis, database.')

    const eventsDriver = runCliProcess(projectRoot, ['install', 'events', '--driver', 'redis'])
    expect(eventsDriver.status).toBe(1)
    expect(eventsDriver.stderr).toContain('The events installer does not support --driver.')

    const authDriver = runCliProcess(projectRoot, ['install', 'auth', '--driver', 'redis'])
    expect(authDriver.status).toBe(1)
    expect(authDriver.stderr).toContain('The auth installer does not support --driver.')

    const authorizationDriver = runCliProcess(projectRoot, ['install', 'authorization', '--driver', 'redis'])
    expect(authorizationDriver.status).toBe(1)
    expect(authorizationDriver.stderr).toContain('The authorization installer does not support --driver.')

    const notificationsDriver = runCliProcess(projectRoot, ['install', 'notifications', '--driver', 'redis'])
    expect(notificationsDriver.status).toBe(1)
    expect(notificationsDriver.stderr).toContain('The notifications installer does not support --driver.')

    const mailDriver = runCliProcess(projectRoot, ['install', 'mail', '--driver', 'redis'])
    expect(mailDriver.status).toBe(1)
    expect(mailDriver.stderr).toContain('The mail installer does not support --driver.')

    const broadcastDriver = runCliProcess(projectRoot, ['install', 'broadcast', '--driver', 'redis'])
    expect(broadcastDriver.status).toBe(1)
    expect(broadcastDriver.stderr).toContain('The broadcast installer does not support --driver.')

    const mediaDriver = runCliProcess(projectRoot, ['install', 'media', '--driver', 'redis'])
    expect(mediaDriver.status).toBe(1)
    expect(mediaDriver.stderr).toContain('The media installer does not support --driver.')
  }, 60000)

  it('installs Holo agent skills for selected coding agents', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const commandIo = createIo(projectRoot)
    const commandContext = {
      ...commandIo.io,
      projectRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const installCommand = createInternalCommands(commandContext as never)
      .find(command => command.name === 'agents:install')

    expect(installCommand).toBeDefined()
    expect(installCommand?.aliases).toContain('ai:install')
    await expect(installCommand?.prepare?.({
      args: [],
      flags: { agent: ['codex,cursor'], force: true },
    }, commandContext as never)).resolves.toEqual({
      args: [],
      flags: {
        agent: ['codex', 'cursor'],
        force: true,
      },
    })
    await expect(installCommand?.prepare?.({
      args: [],
      flags: { agent: 'unknown' },
    }, commandContext as never)).rejects.toThrow('Unsupported agent skill target: unknown.')

    const promptRoot = await createTempProject()
    tempDirs.push(promptRoot)
    const promptIo = createIo(promptRoot, {
      tty: true,
      input: 'codex, cursor\n',
    })
    const promptContext = {
      ...promptIo.io,
      projectRoot: promptRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const promptInstallCommand = createInternalCommands(promptContext as never)
      .find(command => command.name === 'agents:install')

    await expect(promptInstallCommand?.prepare?.({
      args: [],
      flags: {},
    }, promptContext as never)).resolves.toEqual({
      args: [],
      flags: {
        agent: ['codex', 'cursor'],
      },
    })

    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        agent: ['codex', 'cursor'],
      },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()

    const codexSkill = await readFile(join(projectRoot, '.codex/skills/holo-js/SKILL.md'), 'utf8')
    const cursorSkill = await readFile(join(projectRoot, '.cursor/skills/holo-js/SKILL.md'), 'utf8')

    expect(codexSkill).toContain('[framework integration](https://docs.holo-js.com/basics/forms/frameworks)')
    expect(cursorSkill).toBe(codexSkill)
    expect(commandIo.read().stdout).toContain('Installed Holo-JS agent skills.')

    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        agent: ['codex'],
      },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(commandIo.read().stdout).toContain('Holo-JS agent skills are already installed.')

    await writeFile(join(projectRoot, '.codex/skills/holo-js/SKILL.md'), 'custom guidance', 'utf8')
    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        agent: ['codex'],
      },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).rejects.toThrow('Refusing to overwrite existing codex skill')

    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        agent: ['codex'],
        force: true,
      },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    await expect(readFile(join(projectRoot, '.codex/skills/holo-js/SKILL.md'), 'utf8'))
      .resolves.toContain('Treat Holo-JS like Laravel.')

    const plainRoot = await createTempDirectory()
    tempDirs.push(plainRoot)
    const plainIo = createIo(plainRoot)

    await expect(import('../src/cli').then(module => module.runCli([
      'agents:install',
      '--agent',
      'codex',
    ], plainIo.io))).resolves.toBe(0)
    await expect(readFile(join(plainRoot, '.codex/skills/holo-js/SKILL.md'), 'utf8'))
      .resolves.toContain('https://docs.holo-js.com/')
  })

  it('covers the install command and queue installer helpers in-process', async () => {
    ensureBuiltWorkspacePackagesSync()
    await (async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.env', '# existing\nexport REDIS_HOST=cache.internal\nIGNORED\n')
    await writeProjectFile(projectRoot, '.env.example', 'APP_NAME=\n')

    const installCommandIo = createIo(projectRoot)
    const commandContext = {
      ...installCommandIo.io,
      projectRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const installCommand = createInternalCommands(commandContext as never)
      .find(command => command.name === 'install')

    expect(installCommand).toBeDefined()
    expect(installCommand?.usage).toContain('queue: sync|file|redis|database; cache: file|redis|database')
    expect(installCommand?.usage).not.toContain('security: file|redis')
    await expect(installCommand?.prepare?.({
      args: ['queue'],
      flags: { driver: 'redis' },
    }, commandContext as never)).resolves.toEqual({
      args: ['queue'],
      flags: { driver: 'redis' },
    })
    await expect(installCommand?.prepare?.({
      args: ['queue'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['queue'],
      flags: { driver: 'sync' },
    })
    await expect(installCommand?.prepare?.({
      args: ['events'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['events'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['events'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The events installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['auth'],
      flags: { social: true, workos: true },
    }, commandContext as never)).resolves.toEqual({
      args: ['auth'],
      flags: { social: true, workos: true },
    })
    await expect(installCommand?.prepare?.({
      args: ['auth'],
      flags: { provider: ['google,github'] },
    }, commandContext as never)).resolves.toEqual({
      args: ['auth'],
      flags: { social: true, provider: ['google', 'github'] },
    })
    await expect(installCommand?.prepare?.({
      args: ['auth'],
      flags: { provider: [''] },
    }, commandContext as never)).resolves.toEqual({
      args: ['auth'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['auth'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The auth installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['authorization'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The authorization installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['notifications'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['notifications'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['notifications'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The notifications installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['mail'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['mail'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['mail'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The mail installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['broadcast'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['broadcast'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['broadcast'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The broadcast installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['security'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['security'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['security'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The security installer does not support --driver.')
    await expect(installCommand?.prepare?.({
      args: ['media'],
      flags: {},
    }, commandContext as never)).resolves.toEqual({
      args: ['media'],
      flags: {},
    })
    await expect(installCommand?.prepare?.({
      args: ['media'],
      flags: { driver: 'redis' },
    }, commandContext as never)).rejects.toThrow('The media installer does not support --driver.')
    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: ['mailer'],
      flags: { driver: 'sync' },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).rejects.toThrow('Unsupported install target: mailer.')
    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).rejects.toThrow('Unsupported install target: (empty).')

    await linkWorkspaceDb(projectRoot)
    await expect(projectInternals.installEventsIntoProject(projectRoot)).resolves.toEqual({
      updatedPackageJson: true,
      createdEventsDirectory: true,
      createdListenersDirectory: true,
    })
    await expect(projectInternals.installEventsIntoProject(projectRoot)).resolves.toEqual({
      updatedPackageJson: false,
      createdEventsDirectory: false,
      createdListenersDirectory: false,
    })
    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: ['events'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(installCommandIo.read().stdout).toContain('Events support is already installed.')

    const svelteRealtimeRoot = await createTempProject()
    tempDirs.push(svelteRealtimeRoot)
    await writeProjectFile(svelteRealtimeRoot, 'package.json', JSON.stringify({
      name: 'svelte-realtime-variable',
      private: true,
      dependencies: {
        '@sveltejs/kit': 'catalog:',
      },
    }, null, 2))
    const variablePluginsConfig = [
      'import { sveltekit } from \'@sveltejs/kit/vite\'',
      'import { defineConfig } from \'vite\'',
      '',
      'const plugins = [sveltekit()]',
      '',
      'export default defineConfig({',
      '  plugins,',
      '})',
      '',
    ].join('\n')
    await writeProjectFile(svelteRealtimeRoot, 'vite.config.ts', variablePluginsConfig)
    await expect(installRealtimeIntoProject(svelteRealtimeRoot)).rejects.toThrow(
      'Unable to add holoSvelteKitRealtime() to vite.config.ts because the plugins option is not an inline array.',
    )
    expect(await readFile(join(svelteRealtimeRoot, 'vite.config.ts'), 'utf8')).toBe(variablePluginsConfig)

    await expect(projectInternals.installAuthorizationIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: true,
      createdPoliciesDirectory: true,
      createdAbilitiesDirectory: true,
    })
    await expect(installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: ['authorization'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(installCommandIo.read().stdout).toContain('Authorization support is already installed.')

    await expect(projectInternals.installQueueIntoProject(projectRoot, { driver: 'database' })).resolves.toEqual({
      createdQueueConfig: true,
      updatedPackageJson: true,
      updatedEnv: true,
      updatedEnvExample: true,
      createdJobsDirectory: true,
    })
    await expect(projectInternals.installAuthIntoProject(projectRoot, { social: true })).resolves.toMatchObject({
      updatedPackageJson: true,
      createdAuthConfig: true,
      createdSessionConfig: true,
      createdUserModel: true,
    })
    await expect(projectInternals.installNotificationsIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: true,
      createdNotificationsConfig: true,
    })
    await expect(projectInternals.installNotificationsIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: false,
      createdNotificationsConfig: false,
      createdMigrationFiles: [],
    })
    await expect(projectInternals.installMailIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: true,
      createdMailConfig: true,
      createdMailDirectory: true,
      updatedEnv: true,
      updatedEnvExample: true,
    })
    await expect(projectInternals.installMailIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: false,
      createdMailConfig: false,
      createdMailDirectory: false,
      updatedEnv: false,
      updatedEnvExample: false,
    })
    await expect(projectInternals.installSecurityIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
    })
    await expect(projectInternals.installSecurityIntoProject(projectRoot)).resolves.toMatchObject({
      updatedPackageJson: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
    })
    expect((await stat(join(projectRoot, 'storage/framework/rate-limits'))).isDirectory()).toBe(true)
    await expect(readFile(join(projectRoot, 'storage/framework/rate-limits/.gitignore'), 'utf8')).resolves.toBe('*\n!.gitignore\n')
    const queueReinstallResult = await projectInternals.installQueueIntoProject(projectRoot)
    expect(queueReinstallResult).toMatchObject({
      createdQueueConfig: false,
      updatedEnv: false,
      updatedEnvExample: false,
      createdJobsDirectory: false,
    })
    expect(typeof queueReinstallResult.updatedPackageJson).toBe('boolean')
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
      },
    })

    await writeProjectFile(projectRoot, 'config/queue.mjs', 'export default "keep"\n')
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    jobs: 'custom/jobs',
  },
})
`)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      devDependencies: {
        '@holo-js/queue': outdatedHoloPackageRange,
        'typescript': outdatedHoloPackageRange,
      },
      optionalDependencies: ['ignored'],
    }, null, 2))
    await rm(join(projectRoot, '.env.example'), { force: true })
    await rm(join(projectRoot, 'config/queue.ts'), { force: true })

    await expect(projectInternals.installQueueIntoProject(projectRoot, { driver: 'redis' })).resolves.toEqual({
      createdQueueConfig: false,
      updatedPackageJson: true,
      updatedEnv: true,
      updatedEnvExample: true,
      createdJobsDirectory: true,
    })
    expect(await readFile(join(projectRoot, 'config/queue.mjs'), 'utf8')).toBe('export default "keep"\n')
    expect(await readFile(join(projectRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    const envAfterFirstInstall = await readFile(join(projectRoot, '.env'), 'utf8')
    const envExampleAfterFirstInstall = await readFile(join(projectRoot, '.env.example'), 'utf8')
    expect(envAfterFirstInstall).toContain('export REDIS_HOST=cache.internal')
    expect(envAfterFirstInstall).toContain('REDIS_URL=')
    expect(envAfterFirstInstall).toContain('REDIS_PORT=6379')
    expect(envAfterFirstInstall.match(/REDIS_HOST=/g)?.length).toBe(1)
    expect(envAfterFirstInstall.match(/REDIS_URL=/g)?.length).toBe(1)
    expect(envExampleAfterFirstInstall).toContain('REDIS_DB=')
    expect(envExampleAfterFirstInstall.match(/REDIS_URL=/g)?.length).toBe(1)
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/queue-redis': expectedHoloPackageRange,
      },
      devDependencies: {
        typescript: outdatedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies['@holo-js/queue-db']).toBeUndefined()
    await expect(stat(join(projectRoot, 'custom/jobs'))).resolves.toBeDefined()
    await expect(projectInternals.installQueueIntoProject(projectRoot, { driver: 'redis' })).resolves.toEqual({
      createdQueueConfig: false,
      updatedPackageJson: false,
      updatedEnv: false,
      updatedEnvExample: false,
      createdJobsDirectory: false,
    })
    const envAfterRerun = await readFile(join(projectRoot, '.env'), 'utf8')
    const envExampleAfterRerun = await readFile(join(projectRoot, '.env.example'), 'utf8')
    expect(envAfterRerun.match(/REDIS_URL=/g)?.length).toBe(1)
    expect(envExampleAfterRerun.match(/REDIS_URL=/g)?.length).toBe(1)

    const implicitFailedStoreRoot = await createTempProject()
    tempDirs.push(implicitFailedStoreRoot)
    await writeProjectFile(implicitFailedStoreRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'redis',
  connections: {
    redis: {
      driver: 'redis',
      connection: 'cache',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
    },
  },
})
`)
    await writeProjectFile(implicitFailedStoreRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)
    await writeProjectFile(implicitFailedStoreRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/queue': expectedHoloPackageRange,
      },
    }, null, 2))
    await expect(projectInternals.installQueueIntoProject(implicitFailedStoreRoot)).resolves.toEqual({
      createdQueueConfig: false,
      updatedPackageJson: true,
      updatedEnv: true,
      updatedEnvExample: true,
      createdJobsDirectory: true,
    })
    expect(JSON.parse(await readFile(join(implicitFailedStoreRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
        '@holo-js/queue-redis': expectedHoloPackageRange,
      },
    })

    const runRoot = await createTempProject()
    tempDirs.push(runRoot)
    linkBuiltWorkspacePackagesSync(runRoot)
    await writeProjectFile(runRoot, '.env', 'APP_NAME=Run\n')
    await writeProjectFile(runRoot, '.env.example', 'APP_NAME=\n')
    const runIo = createIo(runRoot)
    const runCommandContext = {
      ...runIo.io,
      projectRoot: runRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const runInstallCommand = createInternalCommands(runCommandContext as never)
      .find(command => command.name === 'install')

    await expect((async () => runInstallCommand?.run({
      projectRoot: runRoot,
      cwd: runRoot,
      args: ['queue'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never))()).resolves.toBeUndefined()
    expect(runIo.read().stdout).toContain('Installed queue support.')
    expect(runIo.read().stdout).toContain('created config/queue.ts')

    const rerunIo = createIo(runRoot)
    const rerunContext = {
      ...rerunIo.io,
      projectRoot: runRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const rerunInstallCommand = createInternalCommands(rerunContext as never)
      .find(command => command.name === 'install')
    await expect((async () => rerunInstallCommand?.run({
      projectRoot: runRoot,
      cwd: runRoot,
      args: ['queue'],
      flags: { driver: 'sync' },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never))()).resolves.toBeUndefined()
    expect(rerunIo.read().stdout).toContain('Queue support is already installed.')

    const redisRunRoot = await createTempProject()
    tempDirs.push(redisRunRoot)
    linkBuiltWorkspacePackagesSync(redisRunRoot)
    await writeProjectFile(redisRunRoot, '.env', 'APP_NAME=Redis')
    await writeProjectFile(redisRunRoot, '.env.example', 'APP_NAME=\n')
    const redisRunIo = createIo(redisRunRoot)
    const redisRunContext = {
      ...redisRunIo.io,
      projectRoot: redisRunRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const redisInstallCommand = createInternalCommands(redisRunContext as never)
      .find(command => command.name === 'install')
    await expect((async () => redisInstallCommand?.run({
      projectRoot: redisRunRoot,
      cwd: redisRunRoot,
      args: ['queue'],
      flags: { driver: 'redis' },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never))()).resolves.toBeUndefined()
    expect(redisRunIo.read().stdout).toContain('updated .env')
    expect(redisRunIo.read().stdout).toContain('updated .env.example')
    const redisEnv = await readFile(join(redisRunRoot, '.env'), 'utf8')
    expect(redisEnv).toContain('APP_NAME=Redis')
    expect(redisEnv).toMatch(/\nREDIS_URL=/)
    expect(redisEnv).toContain('REDIS_HOST=127.0.0.1')

    const authProviderRunRoot = await createTempProject()
    tempDirs.push(authProviderRunRoot)
    linkBuiltWorkspacePackagesSync(authProviderRunRoot)
    await writeProjectFile(authProviderRunRoot, '.env', 'APP_NAME=Auth\n')
    await writeProjectFile(authProviderRunRoot, '.env.example', 'APP_NAME=\n')
    const authProviderRunIo = createIo(authProviderRunRoot)
    const authProviderRunContext = {
      ...authProviderRunIo.io,
      projectRoot: authProviderRunRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const authProviderInstallCommand = createInternalCommands(authProviderRunContext as never)
      .find(command => command.name === 'install')
    await expect(authProviderInstallCommand?.run({
      projectRoot: authProviderRunRoot,
      cwd: authProviderRunRoot,
      args: ['auth'],
      flags: { provider: ['google,github'] },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(authProviderRunIo.read().stdout).toContain('Installed auth support.')

    const eventsRunRoot = await createTempProject()
    tempDirs.push(eventsRunRoot)
    linkBuiltWorkspacePackagesSync(eventsRunRoot)
    const eventsRunIo = createIo(eventsRunRoot)
    const eventsRunContext = {
      ...eventsRunIo.io,
      projectRoot: eventsRunRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const eventsInstallCommand = createInternalCommands(eventsRunContext as never)
      .find(command => command.name === 'install')
    await expect(eventsInstallCommand?.run({
      projectRoot: eventsRunRoot,
      cwd: eventsRunRoot,
      args: ['events'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(eventsRunIo.read().stdout).toContain('Installed events support.')
    expect(eventsRunIo.read().stdout).toContain('updated package.json')
    expect(eventsRunIo.read().stdout).toContain('created server/events')
    expect(eventsRunIo.read().stdout).toContain('created server/listeners')
    await expect(eventsInstallCommand?.run({
      projectRoot: eventsRunRoot,
      cwd: eventsRunRoot,
      args: ['events'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(eventsRunIo.read().stdout).toContain('Events support is already installed.')

    const interactiveEventsRoot = await createTempProject()
    tempDirs.push(interactiveEventsRoot)
    linkBuiltWorkspacePackagesSync(interactiveEventsRoot)
    await writeProjectFile(interactiveEventsRoot, '.env', 'APP_NAME=Queued\n')
    await writeProjectFile(interactiveEventsRoot, '.env.example', 'APP_NAME=\n')
    const interactiveEventsIo = createIo(interactiveEventsRoot, {
      tty: true,
      input: 'enable\n',
    })
    const interactiveEventsContext = {
      ...interactiveEventsIo.io,
      projectRoot: interactiveEventsRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const interactiveEventsCommand = createInternalCommands(interactiveEventsContext as never)
      .find(command => command.name === 'install')
    await expect(interactiveEventsCommand?.run({
      projectRoot: interactiveEventsRoot,
      cwd: interactiveEventsRoot,
      args: ['events'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    const interactiveOutput = interactiveEventsIo.read().stdout
    expect(interactiveOutput).toContain('Installed events support.')
    expect(interactiveOutput).toContain('enabled queued listeners')
    expect(interactiveOutput).toContain('created config/queue.ts')
    expect(interactiveOutput).toContain('created server/jobs')
    expect(JSON.parse(await readFile(join(interactiveEventsRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/events': expectedHoloPackageRange,
        '@holo-js/queue': expectedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(interactiveEventsRoot, 'package.json'), 'utf8')).dependencies['@holo-js/queue-db']).toBeUndefined()
    await expect(readFile(join(interactiveEventsRoot, 'config/queue.ts'), 'utf8')).resolves.toContain("default: env('QUEUE_CONNECTION', 'sync')")

    const queueOnlyEventsRoot = await createTempProject()
    tempDirs.push(queueOnlyEventsRoot)
    linkBuiltWorkspacePackagesSync(queueOnlyEventsRoot)
    await writeProjectFile(queueOnlyEventsRoot, '.env', 'APP_NAME=Queued\n')
    await writeProjectFile(queueOnlyEventsRoot, '.env.example', 'APP_NAME=\n')
    const queueOnlyPackageJson = JSON.parse(await readFile(join(queueOnlyEventsRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    queueOnlyPackageJson.dependencies = {
      ...queueOnlyPackageJson.dependencies,
      '@holo-js/events': expectedHoloPackageRange,
    }
    await writeFile(join(queueOnlyEventsRoot, 'package.json'), JSON.stringify(queueOnlyPackageJson, null, 2), 'utf8')
    await mkdir(join(queueOnlyEventsRoot, 'server/events'), { recursive: true })
    await mkdir(join(queueOnlyEventsRoot, 'server/listeners'), { recursive: true })

    const queueOnlyEventsIo = createIo(queueOnlyEventsRoot, {
      tty: true,
      input: 'enable\n',
    })
    const queueOnlyEventsContext = {
      ...queueOnlyEventsIo.io,
      projectRoot: queueOnlyEventsRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const queueOnlyEventsCommand = createInternalCommands(queueOnlyEventsContext as never)
      .find(command => command.name === 'install')
    await expect(queueOnlyEventsCommand?.run({
      projectRoot: queueOnlyEventsRoot,
      cwd: queueOnlyEventsRoot,
      args: ['events'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    const queueOnlyOutput = queueOnlyEventsIo.read().stdout
    expect(queueOnlyOutput).toContain('Installed events support.')
    expect(queueOnlyOutput).toContain('updated package.json')
    expect(queueOnlyOutput).toContain('enabled queued listeners')

    const missingPackageRoot = await createTempDirectory()
    tempDirs.push(missingPackageRoot)
    await expect(projectInternals.installQueueIntoProject(missingPackageRoot, { driver: 'sync' })).rejects.toThrow(`Missing package.json in ${missingPackageRoot}.`)
    await expect(projectInternals.installEventsIntoProject(missingPackageRoot)).rejects.toThrow(`Missing package.json in ${missingPackageRoot}.`)
    await expect(projectInternals.installBroadcastIntoProject(missingPackageRoot)).rejects.toThrow(`Missing config/app.(ts|mts|js|mjs) in ${missingPackageRoot}.`)
    await expect(projectInternals.installMailIntoProject(missingPackageRoot)).rejects.toThrow(
      `Missing config/app.(ts|mts|js|mjs) in ${missingPackageRoot}.`,
    )
    await expect(stat(join(missingPackageRoot, 'config/mail.ts'))).rejects.toThrow()
    await expect(stat(join(missingPackageRoot, 'server/mail'))).rejects.toThrow()
    await writeProjectFile(missingPackageRoot, 'package.json', '{ invalid json')
    await expect(projectInternals.installQueueIntoProject(missingPackageRoot, { driver: 'sync' })).rejects.toThrow(`Invalid package.json in ${missingPackageRoot}.`)
    await expect(projectInternals.installEventsIntoProject(missingPackageRoot)).rejects.toThrow(`Invalid package.json in ${missingPackageRoot}.`)
    await expect(projectInternals.installBroadcastIntoProject(missingPackageRoot)).rejects.toThrow(`Missing config/app.(ts|mts|js|mjs) in ${missingPackageRoot}.`)
    await expect(projectInternals.installMailIntoProject(missingPackageRoot)).rejects.toThrow(
      `Missing config/app.(ts|mts|js|mjs) in ${missingPackageRoot}.`,
    )
    await expect(projectInternals.installQueueIntoProject(missingPackageRoot, { driver: 'bad' as never })).rejects.toThrow('Unsupported queue driver: bad.')

    const eventsDevDependencyRoot = await createTempProject()
    tempDirs.push(eventsDevDependencyRoot)
    await writeProjectFile(eventsDevDependencyRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      devDependencies: {
        '@holo-js/events': outdatedHoloPackageRange,
        typescript: outdatedHoloPackageRange,
      },
    }, null, 2))
    await expect(projectInternals.installEventsIntoProject(eventsDevDependencyRoot)).resolves.toEqual({
      updatedPackageJson: true,
      createdEventsDirectory: true,
      createdListenersDirectory: true,
    })
    expect(JSON.parse(await readFile(join(eventsDevDependencyRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/events': expectedHoloPackageRange,
      },
      devDependencies: {
        typescript: outdatedHoloPackageRange,
      },
    })

    const dependencySyncRoot = await createTempProject()
    tempDirs.push(dependencySyncRoot)
    await writeProjectFile(dependencySyncRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
        '@holo-js/adapter-next': expectedHoloPackageRange,
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(dependencySyncRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'postgres',
      url: 'postgres://localhost/app',
    },
  },
})
`)
    await writeProjectFile(dependencySyncRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'redis',
  failed: false,
  connections: {
    redis: {
      driver: 'redis',
      connection: 'cache',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
    },
  },
})
`)
    await writeProjectFile(dependencySyncRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)
    await writeProjectFile(dependencySyncRoot, 'config/storage.ts', `
import { defineStorageConfig } from '@holo-js/storage'

export default defineStorageConfig({
  defaultDisk: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    },
  },
})
`)
    await expect(projectInternals.syncManagedDriverDependencies(dependencySyncRoot)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(dependencySyncRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/adapter-next': expectedHoloPackageRange,
        '@holo-js/core': expectedHoloPackageRange,
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-postgres': expectedHoloPackageRange,
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/queue-redis': expectedHoloPackageRange,
        '@holo-js/storage': expectedHoloPackageRange,
        '@holo-js/storage-s3': expectedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(dependencySyncRoot, 'package.json'), 'utf8')).dependencies['@holo-js/db-sqlite']).toBeUndefined()
    expect(JSON.parse(await readFile(join(dependencySyncRoot, 'package.json'), 'utf8')).dependencies['@holo-js/queue-db']).toBeUndefined()
    await expect(projectInternals.syncManagedDriverDependencies(dependencySyncRoot)).resolves.toBe(false)
    expect(projectInternals.inferConnectionDriver('sqlserver://localhost/app')).toBeUndefined()
    expect(projectInternals.inferConnectionDriver({ url: 'sqlserver://localhost/app' })).toBeUndefined()

    const queueDefaultFailedStoreRoot = await createTempProject()
    tempDirs.push(queueDefaultFailedStoreRoot)
    await writeProjectFile(queueDefaultFailedStoreRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-postgres': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(queueDefaultFailedStoreRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'postgres',
      url: 'postgres://localhost/app',
    },
  },
})
`)
    await writeProjectFile(queueDefaultFailedStoreRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'redis',
  connections: {
    redis: {
      driver: 'redis',
      connection: 'cache',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
    },
  },
})
`)
    await writeProjectFile(queueDefaultFailedStoreRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)
    await expect(projectInternals.syncManagedDriverDependencies(queueDefaultFailedStoreRoot)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(queueDefaultFailedStoreRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
        '@holo-js/queue-redis': expectedHoloPackageRange,
      },
    })

    const queueFailedStoreRoot = await createTempProject()
    tempDirs.push(queueFailedStoreRoot)
    await writeProjectFile(queueFailedStoreRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-postgres': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(queueFailedStoreRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'postgres',
      url: 'postgres://localhost/app',
    },
  },
})
`)
    await writeProjectFile(queueFailedStoreRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'redis',
  failed: {
    driver: 'database',
  },
  connections: {
    redis: {
      driver: 'redis',
      connection: 'cache',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
    },
  },
})
`)
    await writeProjectFile(queueFailedStoreRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)
    await expect(projectInternals.syncManagedDriverDependencies(queueFailedStoreRoot)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(queueFailedStoreRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
        '@holo-js/queue-redis': expectedHoloPackageRange,
      },
    })

    const staleQueuePackagesRoot = await createTempProject()
    tempDirs.push(staleQueuePackagesRoot)
    await writeProjectFile(staleQueuePackagesRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
        '@holo-js/queue-redis': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(staleQueuePackagesRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)
    await expect(projectInternals.syncManagedDriverDependencies(staleQueuePackagesRoot)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(staleQueuePackagesRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(staleQueuePackagesRoot, 'package.json'), 'utf8')).dependencies['@holo-js/queue-db']).toBeUndefined()
    expect(JSON.parse(await readFile(join(staleQueuePackagesRoot, 'package.json'), 'utf8')).dependencies['@holo-js/queue-redis']).toBeUndefined()

    const pluginFrameworkSyncRoot = await createTempProject()
    tempDirs.push(pluginFrameworkSyncRoot)
    await writeFakeHoloPluginPackage(pluginFrameworkSyncRoot)
    await writeProjectFile(pluginFrameworkSyncRoot, 'package.json', JSON.stringify({
      name: 'plugin-framework-sync-fixture',
      private: true,
      dependencies: {
        'demo-framework': '^1.0.0',
      },
    }, null, 2))
    await writeProjectPluginNames(pluginFrameworkSyncRoot, ['holo-plugin-demo'])
    await writeProjectFile(pluginFrameworkSyncRoot, 'config/broadcast.ts', `
import { defineBroadcastConfig } from '@holo-js/broadcast'

export default defineBroadcastConfig({})
`)

    await expect(projectInternals.syncManagedDriverDependencies(pluginFrameworkSyncRoot)).resolves.toBe(true)
    const pluginFrameworkPackageJson = JSON.parse(await readFile(join(pluginFrameworkSyncRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pluginFrameworkPackageJson.dependencies).toMatchObject({
      '@holo-js/broadcast': expectedHoloPackageRange,
      '@holo-js/flux': expectedHoloPackageRange,
      '@holo-js/adapter-demo': expectedHoloPackageRange,
    })
    expect(pluginFrameworkPackageJson.dependencies?.['@holo-js/adapter-next']).toBeUndefined()
    })()
  }, 180000)

  it('prepares selectable install prompts in-process', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)

    const prepareInstall = async (input: string, args: readonly string[] = []) => {
      const io = createIo(projectRoot, { tty: true, input })
      const context = {
        ...io.io,
        projectRoot,
        registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
        loadProject: async () => ({ config: defaultProjectConfig() }),
      }
      const installCommand = createInternalCommands(context as never)
        .find(command => command.name === 'install')

      return installCommand?.prepare?.({ args, flags: {} }, context as never)
    }

    await expect(prepareInstall('media\n')).resolves.toEqual({
      args: ['media'],
      flags: {},
    })
    await expect(prepareInstall('redis\n', ['cache'])).resolves.toEqual({
      args: ['cache'],
      flags: { driver: 'redis' },
    })
    await expect(prepareInstall('workos,clerk\n', ['auth'])).resolves.toEqual({
      args: ['auth'],
      flags: {
        workos: true,
        clerk: true,
      },
    })
  })

  it('normalizes workspace versions when the packages do not belong to a workspace', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/auth': 'workspace:*',
        '@holo-js/cache': 'workspace:*',
        '@holo-js/db': 'workspace:*',
        '@holo-js/db-sqlite': 'workspace:*',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/auth.ts', `
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'database',
  drivers: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'cache',
    },
  },
})
`)

    await expect(projectInternals.syncManagedDriverDependencies(projectRoot)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/auth': expectedHoloPackageRange,
        '@holo-js/cache': expectedHoloPackageRange,
        '@holo-js/cache-db': expectedHoloPackageRange,
        '@holo-js/core': expectedHoloPackageRange,
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
        '@holo-js/security': expectedHoloPackageRange,
        '@holo-js/session': expectedHoloPackageRange,
      },
    })
  }, 60000)

  it('does not infer framework workspace versions from a workspace plugin', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const packageJson = {
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/adapter-next': 'catalog:',
        '@holo-js/core': 'catalog:',
        '@holo-js/db': 'catalog:',
        '@holo-js/db-sqlite': '^99.0.0',
        '@holo-js/kernel': 'catalog:',
        '@holo-js/panels': 'workspace:*',
        '@holo-js/security': 'catalog:',
        '@holo-js/session': 'catalog:',
        next: expectedNextPackageRange,
      },
    }
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify(packageJson, null, 2))
    await writeProjectFile(projectRoot, 'config/security.ts', `
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({})
    `)

    await expect(projectInternals.syncManagedDriverDependencies(projectRoot)).resolves.toBe(false)
    await expect(readFile(join(projectRoot, 'package.json'), 'utf8').then(JSON.parse)).resolves.toEqual(packageJson)
  }, 60000)

  it('adds session for a security config that exports a plain object without importing @holo-js/security', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'fixture', private: true }, null, 2))
    await writeProjectFile(projectRoot, 'config/security.ts', 'export default {}\n')

    await expect(projectInternals.syncManagedDriverDependencies(projectRoot)).resolves.toBe(true)
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies).toMatchObject({
      '@holo-js/security': expectedHoloPackageRange,
      '@holo-js/session': expectedHoloPackageRange,
    })
  }, 60000)

  it('keeps an existing session dependency for a security config that exports a plain object', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/security': expectedHoloPackageRange,
        '@holo-js/session': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/security.ts', 'export default {}\n')

    await projectInternals.syncManagedDriverDependencies(projectRoot)
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies['@holo-js/session']).toBe(expectedHoloPackageRange)
  }, 60000)

  it('does not require session when a plain security config turns csrf off', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'fixture', private: true }, null, 2))
    await writeProjectFile(projectRoot, 'config/security.ts', 'export default { csrf: { enabled: false } }\n')

    await expect(projectInternals.syncManagedDriverDependencies(projectRoot)).resolves.toBe(true)
    const dependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies
    expect(dependencies['@holo-js/security']).toBe(expectedHoloPackageRange)
    expect(dependencies['@holo-js/session']).toBeUndefined()
  }, 60000)

  it('syncs lazy optional holo packages from config and discovery registry entries', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/auth.ts', `
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  social: {
    google: {},
  },
  workos: {
    admin: {},
  },
  clerk: {
    app: {},
  },
})
`)
    await writeProjectFile(projectRoot, 'config/session.ts', `
import { defineSessionConfig } from '@holo-js/session'

export default defineSessionConfig({
  driver: 'redis',
  stores: {
    redis: {
      driver: 'redis',
      connection: 'cache',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/security.ts', `
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'redis',
    redis: {
      connection: 'cache',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/mail.ts', `
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  queue: {
    queued: true,
  },
  mailers: {
    default: {
      driver: 'log',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/notifications.ts', `
import { defineNotificationsConfig } from '@holo-js/notifications'

export default defineNotificationsConfig({})
`)
    await writeProjectFile(projectRoot, 'config/broadcast.ts', `
import { defineBroadcastConfig } from '@holo-js/broadcast'

export default defineBroadcastConfig({
  default: 'holo',
  connections: {
    holo: {
      driver: 'holo',
      key: 'key',
      secret: 'secret',
      appId: 'app',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)

    await expect(projectInternals.syncManagedDriverDependencies(projectRoot, {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: '.holo-js/generated/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [{
        sourcePath: 'server/jobs/send-email.ts',
        name: 'send-email',
      }],
      events: [{
        sourcePath: 'server/events/user-registered.ts',
        name: 'user.registered',
      }],
      listeners: [{
        sourcePath: 'server/listeners/send-welcome-email.ts',
        id: 'send-welcome-email',
        eventNames: ['user.registered'],
      }],
      broadcast: [{
        sourcePath: 'server/broadcast/orders.ts',
        name: 'orders.updated',
        channels: [],
      }],
      channels: [{
        sourcePath: 'server/channels/orders.ts',
        pattern: 'orders.{orderId}',
        type: 'private',
        params: ['orderId'],
        whispers: [],
      }],
      authorizationPolicies: [{
        sourcePath: 'server/policies/PostPolicy.ts',
        name: 'posts',
        target: 'Post',
        classActions: [],
        recordActions: [],
      }],
      authorizationAbilities: [{
        sourcePath: 'server/abilities/exportReports.ts',
        name: 'reports.export',
      }],
    })).resolves.toBe(true)

    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/auth': expectedHoloPackageRange,
        '@holo-js/auth-clerk': expectedHoloPackageRange,
        '@holo-js/auth-social': expectedHoloPackageRange,
        '@holo-js/auth-social-google': expectedHoloPackageRange,
        '@holo-js/auth-workos': expectedHoloPackageRange,
        '@holo-js/authorization': expectedHoloPackageRange,
        '@holo-js/broadcast': expectedHoloPackageRange,
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/events': expectedHoloPackageRange,
        '@holo-js/mail': expectedHoloPackageRange,
        '@holo-js/notifications': expectedHoloPackageRange,
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/security': expectedHoloPackageRange,
        '@holo-js/session': expectedHoloPackageRange,
        'ioredis': IOREDIS_PACKAGE_VERSION,
      },
    })
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies['@holo-js/storage']).toBeUndefined()
    await expect(projectInternals.syncManagedDriverDependencies(projectRoot, {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: '.holo-js/generated/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [{
        sourcePath: 'server/jobs/send-email.ts',
        name: 'send-email',
      }],
      events: [{
        sourcePath: 'server/events/user-registered.ts',
        name: 'user.registered',
      }],
      listeners: [{
        sourcePath: 'server/listeners/send-welcome-email.ts',
        id: 'send-welcome-email',
        eventNames: ['user.registered'],
      }],
      broadcast: [{
        sourcePath: 'server/broadcast/orders.ts',
        name: 'orders.updated',
        channels: [],
      }],
      channels: [{
        sourcePath: 'server/channels/orders.ts',
        pattern: 'orders.{orderId}',
        type: 'private',
        params: ['orderId'],
        whispers: [],
      }],
      authorizationPolicies: [{
        sourcePath: 'server/policies/PostPolicy.ts',
        name: 'posts',
        target: 'Post',
        classActions: [],
        recordActions: [],
      }],
      authorizationAbilities: [{
        sourcePath: 'server/abilities/exportReports.ts',
        name: 'reports.export',
      }],
    })).resolves.toBe(false)
  }, 60000)

  it('prunes stale lazy optional holo packages even when feature folders do not exist', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/auth': expectedHoloPackageRange,
        '@holo-js/auth-clerk': expectedHoloPackageRange,
        '@holo-js/auth-social': expectedHoloPackageRange,
        '@holo-js/auth-social-google': expectedHoloPackageRange,
        '@holo-js/auth-workos': expectedHoloPackageRange,
        '@holo-js/authorization': expectedHoloPackageRange,
        '@holo-js/broadcast': expectedHoloPackageRange,
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
        '@holo-js/events': expectedHoloPackageRange,
        '@holo-js/mail': expectedHoloPackageRange,
        '@holo-js/notifications': expectedHoloPackageRange,
        '@holo-js/queue': expectedHoloPackageRange,
        '@holo-js/security': expectedHoloPackageRange,
        '@holo-js/session': expectedHoloPackageRange,
        '@holo-js/storage': expectedHoloPackageRange,
        'ioredis': IOREDIS_PACKAGE_VERSION,
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)

    await expect(projectInternals.syncManagedDriverDependencies(projectRoot, {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: '.holo-js/generated/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      broadcast: [],
      channels: [],
      authorizationPolicies: [],
      authorizationAbilities: [],
    })).resolves.toBe(true)

    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies['@holo-js/auth']).toBeUndefined()
  }, 60000)

  it('skips builtin auth social packages when provider runtimes are explicit and no-ops cache dependency sync without cache config files', async () => {
    const authRuntimeRoot = await createTempProject()
    tempDirs.push(authRuntimeRoot)
    await writeProjectFile(authRuntimeRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(authRuntimeRoot, 'config/auth.ts', `
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  social: {
    google: {
      runtime: '@acme/custom-google-runtime',
    },
  },
})
`)
    await writeProjectFile(authRuntimeRoot, 'config/session.ts', `
import { defineSessionConfig } from '@holo-js/session'

export default defineSessionConfig({
  driver: 'file',
  stores: {
    file: {
      driver: 'file',
    },
  },
})
`)

    await expect(projectInternals.syncManagedDriverDependencies(authRuntimeRoot)).resolves.toBe(true)
    const authRuntimeDeps = JSON.parse(await readFile(join(authRuntimeRoot, 'package.json'), 'utf8')).dependencies
    expect(authRuntimeDeps['@holo-js/auth']).toBe(expectedHoloPackageRange)
    expect(authRuntimeDeps['@holo-js/auth-social']).toBe(expectedHoloPackageRange)
    expect(authRuntimeDeps['@holo-js/auth-social-google']).toBeUndefined()

    const cacheDepsRoot = await createTempProject()
    tempDirs.push(cacheDepsRoot)
    await writeProjectFile(cacheDepsRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
      },
    }, null, 2))

    await expect(projectInternals.upsertCachePackageDependencies(cacheDepsRoot)).resolves.toBe(false)
  }, 30_000)

  it('removes stale cache driver packages when cache config does not require them', async () => {
    const cacheDepsRoot = await createTempProject()
    tempDirs.push(cacheDepsRoot)
    await writeProjectFile(cacheDepsRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
        '@holo-js/cache-db': expectedHoloPackageRange,
        '@holo-js/cache-redis': expectedHoloPackageRange,
      },
    }, null, 2))

    await expect(projectInternals.upsertCachePackageDependencies(cacheDepsRoot)).resolves.toBe(true)

    const dependencies = JSON.parse(await readFile(join(cacheDepsRoot, 'package.json'), 'utf8')).dependencies
    expect(dependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
    expect(dependencies['@holo-js/cache-db']).toBeUndefined()
    expect(dependencies['@holo-js/cache-redis']).toBeUndefined()
  }, 30_000)

  it('keeps matching cache driver packages when cache config already requires database and redis', async () => {
    const cacheDepsRoot = await createTempProject()
    tempDirs.push(cacheDepsRoot)
    await writeProjectFile(cacheDepsRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
        '@holo-js/cache-db': expectedHoloPackageRange,
        '@holo-js/cache-redis': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(cacheDepsRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'database',
  drivers: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'cache',
      lockTable: 'cache_locks',
    },
    redis: {
      driver: 'redis',
      connection: 'default',
    },
  },
})
`)

    await expect(projectInternals.upsertCachePackageDependencies(cacheDepsRoot)).resolves.toBe(false)
  }, 30_000)



  it('resolves new project input defaults, flags, and storage package defaults', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: [],
      flags: {},
    })).rejects.toThrow('Missing required argument: Project name.')

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['optional-app'],
      flags: {
        'framework': 'nuxt',
        'database': 'sqlite',
        'package-manager': 'bun',
        'storage-default-disk': 'local',
        'package': 'validation,forms',
      },
    })).resolves.toEqual({
      projectName: 'optional-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['forms', 'validation'],
    })
    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['optional-array-app'],
      flags: {
        package: ['validation', 'forms'],
      },
    })).resolves.toEqual({
      projectName: 'optional-array-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'npm',
      storageDefaultDisk: 'local',
      optionalPackages: ['forms', 'validation'],
    })
    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['forms-app'],
      flags: {
        package: 'forms',
      },
    })).resolves.toEqual({
      projectName: 'forms-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'npm',
      storageDefaultDisk: 'local',
      optionalPackages: ['forms', 'validation'],
    })

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['defaults-app'],
      flags: {},
    })).resolves.toEqual({
      projectName: 'defaults-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'npm',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })
    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['storage-flag-app'],
      flags: {
        framework: 'nuxt',
        database: 'sqlite',
        'package-manager': 'bun',
        package: 'storage',
        'storage-default-disk': 'public',
      },
    })).resolves.toEqual({
      projectName: 'storage-flag-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage'],
    })

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['storage-default-app'],
      flags: {
        framework: 'nuxt',
        database: 'sqlite',
        'package-manager': 'bun',
        package: 'storage',
      },
    })).resolves.toEqual({
      projectName: 'storage-default-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['storage'],
    })
  })

  it('rejects a non-empty project destination before resolving project options', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)
    await writeProjectFile(baseRoot, 'existing-app/package.json', '{}\n')

    const io = createIo(baseRoot, { tty: true })
    const choose = vi.fn(async (_label, _allowed, defaultValue) => defaultValue)
    const optionalPackages = vi.fn(async () => [])
    const validateProjectName = vi.fn(
      async projectName => ensureEmptyDirectory(resolve(baseRoot, projectName), projectName),
    )

    await expect(resolveNewProjectInput(io.io, { args: [], flags: {} }, {
      prompt: async () => 'existing-app',
      choose,
      optionalPackages,
    }, validateProjectName)).rejects.toThrow(
      'The destination "existing-app" already exists and is not empty. Choose a different project name or empty that folder first.',
    )
    expect(validateProjectName).toHaveBeenCalledWith('existing-app')
    expect(choose).not.toHaveBeenCalled()
    expect(optionalPackages).not.toHaveBeenCalled()

    const newCommand = createInternalCommands({
      ...io.io,
      projectRoot: baseRoot,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never).find(command => command.name === 'new')

    await expect(newCommand?.prepare?.({ args: ['existing-app'], flags: {} }, {} as never)).rejects.toThrow(
      'The destination "existing-app" already exists and is not empty. Choose a different project name or empty that folder first.',
    )
    await expect(ensureEmptyDirectory(join(baseRoot, 'missing-app'))).resolves.toBeUndefined()
    await expect(projectInternals.scaffoldProject(resolve(baseRoot, 'existing-app'), {
      projectName: 'existing-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'npm',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).rejects.toThrow(`The destination "${resolve(baseRoot, 'existing-app')}" already exists and is not empty.`)

  })

  it('installs mail support through the CLI', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'mail'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed mail support.')
    expect(result.stdout).toContain('  - created config/mail.ts')
    expect(result.stdout).toContain('  - created server/mail')
    expect(await readFile(join(projectRoot, 'config/mail.ts'), 'utf8')).toContain('defineMailConfig')
    expect((await stat(join(projectRoot, 'server/mail'))).isDirectory()).toBe(true)
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('MAIL_MAILER=preview')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('MAIL_MAILER=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/mail": "${expectedHoloPackageRange}"`)
    await expectPackageManagerInstallRequested(projectRoot)
  })

  it('installs cache support through the CLI with the default file driver and is idempotent', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const first = runCliProcess(projectRoot, ['install', 'cache'])
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('Installed cache support.')
    expect(first.stdout).toContain('  - created config/cache.ts')
    expect(first.stdout).toContain('  - updated package.json')
    expect(first.stdout).toContain('  - updated .env')
    expect(first.stdout).toContain('  - updated .env.example')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain("default: env('CACHE_DRIVER', 'file')")
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('CACHE_PREFIX=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache-redis": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).not.toContain('"@holo-js/cache-db"')

    const second = runCliProcess(projectRoot, ['install', 'cache'])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('Cache support is already installed.')
  }, 30_000)

  it('installs media support through the CLI and is idempotent', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const first = runCliProcess(projectRoot, ['install', 'media'])
    expect(first.status, first.stderr || first.stdout).toBe(0)
    expect(first.stdout).toContain('Installed media support.')
    expect(first.stdout).toContain('  - created config/media.ts')
    expect(first.stdout).toContain('  - updated package.json')
    expect(first.stdout).toContain('  - created media migration')
    expect(await readFile(join(projectRoot, 'config/media.ts'), 'utf8')).toContain('defineMediaConfig')
    expect(await readFile(join(projectRoot, 'config/media.ts'), 'utf8')).toContain('disk: env(\'MEDIA_DISK\', \'public\')')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/media": "${expectedHoloPackageRange}"`)

    const migrations = await readdir(join(projectRoot, 'server/db/migrations'))
    expect(migrations.filter(entry => entry.endsWith('_create_media_table.ts'))).toHaveLength(1)
    expect(await readFile(join(projectRoot, 'server/db/migrations', migrations.find(entry => entry.endsWith('_create_media_table.ts'))!), 'utf8'))
      .toContain('schema.createTable("media"')

    const second = runCliProcess(projectRoot, ['install', 'media'])
    expect(second.status, second.stderr || second.stdout).toBe(0)
    expect(second.stdout).toContain('Media support is already installed.')
    expect((await readdir(join(projectRoot, 'server/db/migrations'))).filter(entry => entry.endsWith('_create_media_table.ts'))).toHaveLength(1)
  }, 30_000)

  it('generates the media table migration through the CLI', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const first = runCliProcess(projectRoot, ['media:table'])
    expect(first.status, first.stderr || first.stdout).toBe(0)
    expect(first.stdout).toContain('Created migration: server/db/migrations/')

    const migrations = await readdir(join(projectRoot, 'server/db/migrations'))
    expect(migrations.filter(entry => entry.endsWith('_create_media_table.ts'))).toHaveLength(1)

    const second = runCliProcess(projectRoot, ['media:table'])
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('A migration for table "media" already exists.')
  }, 30_000)

  it('serializes migration creation across CLI processes', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await prepareProjectDiscovery(projectRoot)
    const { cliBinPath } = ensureBuiltWorkspacePackagesSync()
    const run = (): Promise<{ code: number | null, output: string }> => new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [cliBinPath, 'make:migration', 'create_concurrent_items_table'], { cwd: projectRoot })
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { output += String(chunk) })
      child.on('error', reject)
      child.on('close', code => { resolveResult({ code, output }) })
    })
    const results = await Promise.all([run(), run()])
    expect(results.map(result => result.code).sort()).toEqual([0, 1])
    expect(results.find(result => result.code === 1)?.output).toContain('already exists')
    expect((await readdir(join(projectRoot, 'server/db/migrations'))).filter(name => name.endsWith('_create_concurrent_items_table.ts'))).toHaveLength(1)
  }, 30_000)

  it('installs cache support with the redis driver', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'redis'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed cache support.')
    expect(result.stdout).toContain('  - created config/cache.ts')
    expect(result.stdout).toContain('  - created config/redis.ts')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain("default: env('CACHE_DRIVER', 'redis')")
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('driver: \'redis\'')
    expect(await readFile(join(projectRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_PORT=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('REDIS_PORT=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache-redis": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('installs cache support with the redis driver using the configured redis default connection', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      host: '127.0.0.1',
      port: 6379,
    },
  },
})
`)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'redis'])
    expect(result.status).toBe(0)
    expect((await loadConfigDirectory(projectRoot, { preferCache: false })).cache.drivers.redis).toMatchObject({ connection: 'cache' })
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('REDIS_HOST=')
  }, 30_000)

  it('switches cache drivers after the user updates cache config and reruns the public install command', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    expect(runCliProcess(projectRoot, ['install', 'cache']).status).toBe(0)
    await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'redis',
  drivers: {
    redis: {
      driver: 'redis',
      connection: 'default',
    },
  },
})
`)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'redis'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed cache support.')
    expect(result.stdout).toContain('  - created config/redis.ts')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'redis\'')
    expect(await readFile(join(projectRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache-redis": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('fails instead of partially installing a mismatched cache driver when cache config already exists', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    expect(runCliProcess(projectRoot, ['install', 'cache']).status).toBe(0)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'database'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('config/cache.ts already exists')
    expect(result.stderr).toContain('does not configure the "database" cache driver')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain("default: env('CACHE_DRIVER', 'file')")
    await expect(readFile(join(projectRoot, 'config/redis.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('REDIS_URL=')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).not.toContain('"@holo-js/cache-db"')
  }, 30_000)

  it('installs cache support with the database driver and prints the migration hint', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'database'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed cache support.')
    expect(result.stdout).toContain('run "holo cache:table" to create the cache tables')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain("default: env('CACHE_DRIVER', 'database')")
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('driver: \'database\'')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('table: \'cache\'')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache-db": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('prepares a scaffolded broadcast project that has no .env, as a fresh clone would', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-clone-'))
    tempDirs.push(projectRoot)
    await projectInternals.scaffoldProject(projectRoot, {
      projectName: 'Broadcast Clone',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })
    await linkWorkspaceDb(projectRoot)
    await rm(join(projectRoot, '.env'), { force: true })
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts.prepare).toBe('holo key:generate && holo install broadcast && holo prepare')
    const keyGenerated = runCliProcess(projectRoot, ['key:generate'])
    expect(keyGenerated.status, keyGenerated.stderr || keyGenerated.stdout).toBe(0)
    const broadcastInstalled = runCliProcess(projectRoot, ['install', 'broadcast'])
    expect(broadcastInstalled.status, broadcastInstalled.stderr || broadcastInstalled.stdout).toBe(0)
    const prepared = runCliProcess(projectRoot, ['prepare'])
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0)

    const env = await readFile(join(projectRoot, '.env'), 'utf8')
    expect(env).toMatch(/^BROADCAST_APP_ID=[a-f0-9]{16}$/m)
    expect(env).toMatch(/^BROADCAST_APP_KEY=[a-f0-9]{32}$/m)
    expect(env).toMatch(/^BROADCAST_APP_SECRET=[A-Za-z0-9_-]{43}$/m)
  })

  it('installs Next.js broadcast support without requiring framework Flux bootstrap files', async () => {
    const nextRoot = await createTempProject()
    tempDirs.push(nextRoot)
    await writeProjectFile(nextRoot, 'package.json', JSON.stringify({
      name: 'next-broadcast-fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        ...nativeAppDependencies,
        next: expectedNextPackageRange,
      },
    }, null, 2))
    await writeProjectFile(nextRoot, 'app/layout.tsx', 'export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }\n')
    const nextResult = runCliProcess(nextRoot, ['install', 'broadcast'])
    expect(nextResult.status, `${nextResult.stdout}\n${nextResult.stderr}`).toBe(0)
    expect(nextResult.stdout).toContain('Installed broadcast support.')
    expect(nextResult.stdout).toContain('  - updated .env')
    expect(nextResult.stdout).toContain('  - updated .env.example')
    expect(nextResult.stdout).toContain('  - created config/broadcast.ts')
    expect(nextResult.stdout).not.toContain('  - created /broadcasting/auth route')
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain('defineBroadcastConfig')
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain("default: env('BROADCAST_CONNECTION', 'holo')")
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain("driver: 'holo'")
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain("host: env('BROADCAST_HOST', '127.0.0.1')")
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain("port: env('BROADCAST_PORT', 8080)")
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain('scheme: broadcastScheme')
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain('useTLS: broadcastScheme ===')
    await expect(readFile(join(nextRoot, '.env'), 'utf8')).resolves.toContain('BROADCAST_CONNECTION=holo')
    await expect(readFile(join(nextRoot, '.env.example'), 'utf8')).resolves.toContain('BROADCAST_CONNECTION=holo')
    await expect(readFile(join(nextRoot, '.env.example'), 'utf8')).resolves.toContain('BROADCAST_APP_ID=')
    await expect(readFile(join(nextRoot, '.env.example'), 'utf8')).resolves.toContain('BROADCAST_APP_KEY=')
    await expect(readFile(join(nextRoot, '.env.example'), 'utf8')).resolves.toContain('BROADCAST_APP_SECRET=')
    await expect(loadConfigDirectory(nextRoot)).resolves.toMatchObject({
      broadcast: {
        default: 'holo',
        connections: {
          holo: {
            driver: 'holo',
            options: {
              host: '127.0.0.1',
              port: 8080,
              scheme: 'http',
              useTLS: false,
            },
            clientOptions: {},
          },
        },
      },
    })
    await expect(stat(join(nextRoot, 'app/lib/flux.ts'))).rejects.toThrow()
    await expect(stat(join(nextRoot, 'app/broadcasting/auth/route.ts'))).rejects.toThrow()
    await expect(stat(join(nextRoot, 'app/api/broadcasting/auth/route.ts'))).rejects.toThrow()
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/broadcast": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-react": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-next": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('installs Nuxt broadcast support without requiring framework Flux bootstrap files', async () => {
    const nuxtRoot = await createTempProject()
    tempDirs.push(nuxtRoot)
    await writeProjectFile(nuxtRoot, 'package.json', JSON.stringify({
      name: 'nuxt-broadcast-fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        ...nativeAppDependencies,
        nuxt: expectedNuxtPackageRange,
      },
    }, null, 2))
    await writeFrameworkSyncBinary(nuxtRoot, 'nuxt')
    const nuxtResult = runCliProcess(nuxtRoot, ['install', 'broadcast'])
    expect(nuxtResult.status, `${nuxtResult.stdout}\n${nuxtResult.stderr}`).toBe(0)
    await expect(stat(join(nuxtRoot, 'app/plugins/flux.client.ts'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'server/routes/broadcasting/auth.post.ts'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'server/holo.ts'))).rejects.toThrow()
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-vue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-nuxt": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('installs SvelteKit broadcast support without requiring framework Flux bootstrap files', async () => {
    const svelteRoot = await createTempProject()
    tempDirs.push(svelteRoot)
    await writeProjectFile(svelteRoot, 'package.json', JSON.stringify({
      name: 'svelte-broadcast-fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        ...nativeAppDependencies,
        '@sveltejs/kit': expectedSvelteKitPackageRange,
      },
    }, null, 2))
    await writeFrameworkSyncBinary(svelteRoot, 'svelte-kit')
    const svelteResult = runCliProcess(svelteRoot, ['install', 'broadcast'])
    expect(svelteResult.status, `${svelteResult.stdout}\n${svelteResult.stderr}`).toBe(0)
    await expect(stat(join(svelteRoot, 'src/lib/flux.ts'))).rejects.toThrow()
    await expect(stat(join(svelteRoot, 'src/routes/broadcasting/auth/+server.ts'))).rejects.toThrow()
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-svelte": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-sveltekit": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('installs broadcast support with CommonJS configuration', async () => {
    const cjsRoot = await createTempDirectory()
    tempDirs.push(cjsRoot)
    await writeProjectFile(cjsRoot, 'package.json', JSON.stringify({
      name: 'cjs-broadcast-fixture',
      private: true,
      type: 'commonjs',
    }, null, 2))
    await writeProjectFile(cjsRoot, 'config/app.js', `
module.exports = {
  app: {},
}
`)
    await linkWorkspaceConfig(cjsRoot)

    const cjsInstall = await projectInternals.installBroadcastIntoProject(cjsRoot)
    expect(cjsInstall).toMatchObject({
      createdBroadcastConfig: true,
      createdBroadcastAuthRoute: false,
      updatedEnv: true,
      updatedEnvExample: true,
    })
    await expect(readFile(join(cjsRoot, 'config/broadcast.cjs'), 'utf8')).resolves.toContain('module.exports = defineBroadcastConfig(')
    await expect(readFile(join(cjsRoot, 'config/broadcast.cjs'), 'utf8')).resolves.not.toContain("env<'http' | 'https'>(")
    await expect(stat(join(cjsRoot, 'config/broadcast.ts'))).rejects.toThrow()
  }, 30_000)

  it('installs broadcast dependencies for active plugin framework descriptors', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeFakeHoloPluginPackage(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'plugin-framework-broadcast-fixture',
      private: true,
      dependencies: {
        'demo-framework': '^1.0.0',
      },
    }, null, 2))
    await writeProjectPluginNames(projectRoot, ['holo-plugin-demo'])

    const result = await projectInternals.installBroadcastIntoProject(projectRoot)
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(result.updatedPackageJson).toBe(true)
    expect(packageJson.dependencies?.['@holo-js/broadcast']).toBe(`^${HOLO_PACKAGE_VERSION}`)
    expect(packageJson.dependencies?.['@holo-js/flux']).toBe(`^${HOLO_PACKAGE_VERSION}`)
    expect(packageJson.dependencies?.['@holo-js/adapter-demo']).toBe(`^${HOLO_PACKAGE_VERSION}`)
    expect(packageJson.dependencies?.['@holo-js/adapter-next']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/adapter-nuxt']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/adapter-sveltekit']).toBeUndefined()
  }, 90000)

  it('uses active plugin framework capabilities when installing broadcast auth support', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'plugin-framework-broadcast-auth-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/auth.ts', 'export default {}\n')
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  plugins: ['holo-plugin-next-broadcast-override'],
})
`)
    const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-next-broadcast-override')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'holo-plugin-next-broadcast-override',
      type: 'module',
      holo: {
        plugin: './plugin.mjs',
      },
    }, null, 2))
    await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'next-broadcast-override',
  contributes: {
    framework: {
      id: 'next',
      displayName: 'Next Broadcast Override',
      detectPackages: ['next'],
      adapterPackage: '@holo-js/adapter-next',
      fluxPackage: '@holo-js/flux-react',
      scaffold: {
        dependencies: {
          next: '^15.0.0',
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          '@holo-js/adapter-next': '^1.0.0',
        },
        devDependencies: {
          '@types/react': '^19.0.0',
          '@types/react-dom': '^19.0.0',
        },
        scripts: {},
        lintScript: 'eslint app config server tests --fix',
        typecheckScript: 'tsc -p tsconfig.json --noEmit',
        defaultUrl: 'http://localhost:3000',
        tsconfig: 'next',
      },
      runner: {
        commandName: 'next',
        buildArgs: ['build'],
        start: ['start'],
        startUsesFrameworkBinary: true,
        preloadNextRuntime: true,
        suppressSvelteKitOutput: false,
        nextDevServerConflictHandling: true,
      },
      capabilities: {
        managedBroadcastAuthRoute: false,
      },
    },
  },
}
`)

    const result = await projectInternals.installBroadcastIntoProject(projectRoot)

    expect(result.createdBroadcastAuthRoute).toBe(false)
    await expect(readFile(join(projectRoot, 'config/broadcast.ts'), 'utf8')).resolves.not.toContain('authEndpoint')
    await expect(stat(join(projectRoot, 'app/broadcasting/auth/route.ts'))).rejects.toThrow()
  }, 90000)

  it('installs broadcast auth routes for supported frameworks via project internals', async () => {
    const nextRoot = await createTempProject()
    tempDirs.push(nextRoot)
    await writeProjectFile(nextRoot, 'package.json', JSON.stringify({
      name: 'next-direct-broadcast-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))
    await writeProjectFile(nextRoot, 'config/auth.ts', 'export default {}\n')
    const nextInstall = await projectInternals.installBroadcastIntoProject(nextRoot)
    expect(nextInstall).toMatchObject({
      createdBroadcastAuthRoute: true,
      updatedEnv: true,
      updatedEnvExample: true,
    })
    await expect(readFile(join(nextRoot, 'app/broadcasting/auth/route.ts'), 'utf8')).resolves.toContain('.holo-js/generated/next/broadcast-auth-route')
    await expect(readFile(join(nextRoot, 'app/broadcasting/auth/route.ts'), 'utf8')).resolves.not.toContain('holo.getApp')
    await expect(readFile(join(nextRoot, 'app/broadcasting/config/route.ts'), 'utf8')).resolves.toContain('.holo-js/generated/next/broadcast-config-route')
    await expect(readFile(join(nextRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).resolves.toContain('channelAuth')
    await expect(readFile(join(nextRoot, '.holo-js/generated/next/broadcast-config-route.ts'), 'utf8')).resolves.toContain('renderBroadcastClientConfigResponse')
    await expect(stat(join(nextRoot, 'server/holo.ts'))).rejects.toThrow()
    await expect(readFile(join(nextRoot, '.holo-js/generated/next/holo.ts'), 'utf8')).resolves.toContain('createNextHoloHelpers')
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-react": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-next": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nextRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)

    const nuxtRoot = await createTempProject()
    tempDirs.push(nuxtRoot)
    await writeProjectFile(nuxtRoot, 'package.json', JSON.stringify({
      name: 'nuxt-direct-broadcast-fixture',
      private: true,
      devDependencies: {
        nuxt: expectedNuxtPackageRange,
      },
    }, null, 2))
    await writeProjectFile(nuxtRoot, 'config/auth.ts', 'export default {}\n')
    const nuxtInstall = await projectInternals.installBroadcastIntoProject(nuxtRoot)
    expect(nuxtInstall).toMatchObject({
      createdBroadcastAuthRoute: false,
      updatedEnv: true,
      updatedEnvExample: true,
    })
    await expect(stat(join(nuxtRoot, 'server/routes/broadcasting/auth.post.ts'))).rejects.toThrow()
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-vue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-nuxt": "${expectedHoloPackageRange}"`)

    const svelteRoot = await createTempProject()
    tempDirs.push(svelteRoot)
    await writeProjectFile(svelteRoot, 'package.json', JSON.stringify({
      name: 'svelte-direct-broadcast-fixture',
      private: true,
      dependencies: {
        '@sveltejs/kit': expectedSvelteKitPackageRange,
      },
    }, null, 2))
    await writeProjectFile(svelteRoot, 'config/auth.ts', 'export default {}\n')
    const svelteInstall = await projectInternals.installBroadcastIntoProject(svelteRoot)
    expect(svelteInstall).toMatchObject({
      createdBroadcastAuthRoute: false,
      updatedEnv: true,
      updatedEnvExample: true,
    })
    await expect(stat(join(svelteRoot, 'src/routes/broadcasting/auth/+server.ts'))).rejects.toThrow()
    await expect(stat(join(svelteRoot, 'src/lib/server/holo.ts'))).rejects.toThrow()
    await expect(readFile(join(svelteRoot, '.holo-js/generated/sveltekit/holo.ts'), 'utf8')).resolves.toContain('createSvelteKitHoloHelpers')
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-svelte": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-sveltekit": "${expectedHoloPackageRange}"`)

    const genericRoot = await createTempProject()
    tempDirs.push(genericRoot)
    await writeProjectFile(genericRoot, 'package.json', JSON.stringify({
      name: 'generic-direct-broadcast-fixture',
      private: true,
      dependencies: {
        '@holo-js/broadcast': expectedHoloPackageRange,
        '@holo-js/flux': expectedHoloPackageRange,
      },
      devDependencies: {},
    }, null, 2))
    const genericInstall = await projectInternals.installBroadcastIntoProject(genericRoot)
    expect(genericInstall.updatedPackageJson).toBe(false)
    expect(genericInstall.createdBroadcastAuthRoute).toBe(false)
    expect(genericInstall.updatedEnv).toBe(true)
    expect(genericInstall.updatedEnvExample).toBe(true)
    await expect(readFile(join(genericRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    const genericSecondInstall = await projectInternals.installBroadcastIntoProject(genericRoot)
    expect(genericSecondInstall).toEqual({
      updatedPackageJson: false,
      createdBroadcastConfig: false,
      createdBroadcastDirectory: false,
      createdChannelsDirectory: false,
      createdBroadcastAuthRoute: false,
      createdFrameworkSetup: false,
      updatedEnv: false,
      updatedEnvExample: false,
    })

    const genericAuthRoot = await createTempProject()
    tempDirs.push(genericAuthRoot)
    await writeProjectFile(genericAuthRoot, 'package.json', JSON.stringify({
      name: 'generic-auth-broadcast-fixture',
      private: true,
      dependencies: {
        '@holo-js/broadcast': expectedHoloPackageRange,
        '@holo-js/flux': expectedHoloPackageRange,
      },
      devDependencies: {},
    }, null, 2))
    await writeProjectFile(genericAuthRoot, 'config/auth.ts', 'export default {}\n')
    const genericAuthInstall = await projectInternals.installBroadcastIntoProject(genericAuthRoot)
    expect(genericAuthInstall.createdBroadcastAuthRoute).toBe(false)
    await expect(readFile(join(genericAuthRoot, 'config/broadcast.ts'), 'utf8')).resolves.not.toContain('authEndpoint:')
  }, 60000)

  it('backfills authEndpoint into existing broadcast configs when auth is already installed', async () => {
    const nextRoot = await createTempProject()
    tempDirs.push(nextRoot)
    await writeProjectFile(nextRoot, 'package.json', JSON.stringify({
      name: 'next-existing-broadcast-auth-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))
    await writeProjectFile(nextRoot, 'config/auth.ts', 'export default {}\n')
    await writeProjectFile(nextRoot, 'config/broadcast.ts', `
import { env } from '@holo-js/config'
import { defineBroadcastConfig } from '@holo-js/broadcast'

export default defineBroadcastConfig({
  default: env('BROADCAST_CONNECTION', 'holo'),
  connections: {
    holo: {
      driver: 'holo',
      appId: env('BROADCAST_APP_ID', 'app-id'),
      key: env('BROADCAST_APP_KEY', 'app-key'),
      secret: env('BROADCAST_APP_SECRET', 'app-secret'),
      options: {
        host: env('BROADCAST_HOST', '127.0.0.1'),
        port: env('BROADCAST_PORT', 8080),
        scheme: env<'http' | 'https'>('BROADCAST_SCHEME', 'http'),
        useTLS: env('BROADCAST_SCHEME', 'http') === 'https',
      },
    },
    log: {
      driver: 'log',
    },
    null: {
      driver: 'null',
    },
  },
})
`)

    const nextInstall = await projectInternals.installBroadcastIntoProject(nextRoot)
    expect(nextInstall).toMatchObject({
      createdBroadcastConfig: false,
      createdBroadcastAuthRoute: true,
    })
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain(
      "authEndpoint: `${env('APP_URL', 'http://localhost:3000')}/broadcasting/auth`",
    )
    await expect(readFile(join(nextRoot, 'app/broadcasting/auth/route.ts'), 'utf8')).resolves.toContain('.holo-js/generated/next/broadcast-auth-route')
    await expect(readFile(join(nextRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).resolves.toContain('channelAuth')
  }, 30000)

  it('backfills broadcast auth wiring when auth is installed after broadcast', async () => {
    const nextRoot = await createTempProject()
    tempDirs.push(nextRoot)
    await writeProjectFile(nextRoot, 'package.json', JSON.stringify({
      name: 'next-broadcast-auth-order-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))

    const broadcastInstall = await projectInternals.installBroadcastIntoProject(nextRoot)
    expect(broadcastInstall).toMatchObject({
      createdBroadcastConfig: true,
      createdBroadcastAuthRoute: false,
    })
    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.not.toContain('authEndpoint:')
    await expect(stat(join(nextRoot, 'app/broadcasting/auth/route.ts'))).rejects.toThrow()

    await expect(projectInternals.installAuthIntoProject(nextRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
    })

    await expect(readFile(join(nextRoot, 'config/broadcast.ts'), 'utf8')).resolves.toContain(
      "authEndpoint: `${env('APP_URL', 'http://localhost:3000')}/broadcasting/auth`",
    )
    await expect(readFile(join(nextRoot, 'app/broadcasting/auth/route.ts'), 'utf8')).resolves.toContain('.holo-js/generated/next/broadcast-auth-route')
    await expect(readFile(join(nextRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).resolves.toContain('channelAuth')

    const formattedNextRoot = await createTempProject()
    tempDirs.push(formattedNextRoot)
    await writeProjectFile(formattedNextRoot, 'package.json', JSON.stringify({
      name: 'next-broadcast-auth-formatted-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))

    await expect(projectInternals.installBroadcastIntoProject(formattedNextRoot)).resolves.toMatchObject({
      createdBroadcastConfig: true,
      createdBroadcastAuthRoute: false,
    })

    const formattedBroadcastConfigPath = join(formattedNextRoot, 'config/broadcast.ts')
    const formattedBroadcastConfig = await readFile(formattedBroadcastConfigPath, 'utf8')
    await writeProjectFile(
      formattedNextRoot,
      'config/broadcast.ts',
      formattedBroadcastConfig.replace(
        'export default defineBroadcastConfig({',
        'export default defineBroadcastConfig({\n  // formatted',
      ),
    )

    await expect(projectInternals.installAuthIntoProject(formattedNextRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
    })

    await expect(readFile(formattedBroadcastConfigPath, 'utf8')).resolves.toContain(
      "authEndpoint: `${env('APP_URL', 'http://localhost:3000')}/broadcasting/auth`",
    )
    await expect(readFile(join(formattedNextRoot, 'app/broadcasting/auth/route.ts'), 'utf8')).resolves.toContain('.holo-js/generated/next/broadcast-auth-route')
    await expect(readFile(join(formattedNextRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).resolves.toContain('channelAuth')

    const genericRoot = await createTempProject()
    tempDirs.push(genericRoot)
    await writeProjectFile(genericRoot, 'package.json', JSON.stringify({
      name: 'generic-broadcast-auth-order-fixture',
      private: true,
      dependencies: {
        '@holo-js/broadcast': expectedHoloPackageRange,
        '@holo-js/flux': expectedHoloPackageRange,
      },
      devDependencies: {},
    }, null, 2))

    await expect(projectInternals.installBroadcastIntoProject(genericRoot)).resolves.toMatchObject({
      createdBroadcastConfig: true,
      createdBroadcastAuthRoute: false,
    })
    await expect(readFile(join(genericRoot, 'config/broadcast.ts'), 'utf8')).resolves.not.toContain('authEndpoint:')

    await expect(projectInternals.installAuthIntoProject(genericRoot)).resolves.toMatchObject({
      createdAuthConfig: true,
    })

    await expect(readFile(join(genericRoot, 'config/broadcast.ts'), 'utf8')).resolves.not.toContain('authEndpoint:')
  }, 30000)

  it('supports interactive new project prompts', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    const defaultNamePromptIo = createIo(baseRoot, {
      tty: true,
      input: 'default-prompt-app\n',
    })
    await expect(resolveNewProjectInput(defaultNamePromptIo.io, {
      args: [],
      flags: {
        framework: 'nuxt',
        database: 'sqlite',
        'package-manager': 'bun',
        'storage-default-disk': 'local',
        package: 'none',
      },
    })).resolves.toEqual({
      projectName: 'default-prompt-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })
    const defaultChoicePromptIo = createIo(baseRoot, {
      tty: true,
      input: 'next\n',
    })
    await expect(resolveNewProjectInput(defaultChoicePromptIo.io, {
      args: ['default-choice-app'],
      flags: {
        database: 'sqlite',
        'package-manager': 'bun',
        'storage-default-disk': 'local',
        package: 'none',
      },
    })).resolves.toEqual({
      projectName: 'default-choice-app',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })
    const defaultOptionalPackagesIo = createIo(baseRoot, {
      tty: true,
      input: 'forms,validation\n',
    })
    await expect(resolveNewProjectInput(defaultOptionalPackagesIo.io, {
      args: ['default-packages-app'],
      flags: {
        framework: 'nuxt',
        database: 'sqlite',
        'package-manager': 'bun',
        'storage-default-disk': 'local',
      },
    })).resolves.toEqual({
      projectName: 'default-packages-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['forms', 'validation'],
    })

    const io = createIo(baseRoot, { tty: true })
    await expect(resolveNewProjectInput(io.io, { args: [], flags: {} }, {
      prompt: async () => 'prompted-app',
      choose: async (label, _allowed, defaultValue) => {
        if (label === 'Framework') return 'sveltekit' as typeof defaultValue
        if (label === 'Database driver') return 'sqlite' as typeof defaultValue
        if (label === 'Package manager') return 'yarn' as typeof defaultValue
        return 'local' as typeof defaultValue
      },
      optionalPackages: async () => ['validation'],
    })).resolves.toEqual({
      projectName: 'prompted-app',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'yarn',
      storageDefaultDisk: 'local',
      optionalPackages: ['validation'],
    })

    await expect(resolveNewProjectInput(io.io, { args: [], flags: {} }, {
      prompt: async () => 'storage-app',
      choose: async (label, _allowed, defaultValue) => {
        if (label === 'Framework') return 'nuxt' as typeof defaultValue
        if (label === 'Database driver') return 'sqlite' as typeof defaultValue
        if (label === 'Package manager') return 'bun' as typeof defaultValue
        return 'public' as typeof defaultValue
      },
      optionalPackages: async () => ['storage'],
    })).resolves.toEqual({
      projectName: 'storage-app',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage'],
    })

    await expect(resolveNewProjectInput(io.io, { args: [], flags: {} }, {
      prompt: async () => 'bad-app',
      choose: async () => {
        throw new Error('Unsupported Framework: invalid-framework. Expected one of nuxt, next, sveltekit.')
      },
      optionalPackages: async () => [],
    })).rejects.toThrow('Unsupported')

    await expect(resolveNewProjectInput(io.io, { args: [], flags: {} }, {
      prompt: async () => '',
      choose: async (_label, _allowed, defaultValue) => defaultValue,
      optionalPackages: async () => [],
    })).rejects.toThrow('Project creation cancelled.')
  }, 60000)

  it('validates prompt helpers and optional package aliases', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    const choiceIo = createIo(baseRoot, {
      tty: true,
      input: 'next\n',
    })
    await expect(promptChoice(choiceIo.io, 'Framework', ['nuxt', 'next'], 'nuxt')).resolves.toBe('next')

    const invalidChoiceIo = createIo(baseRoot, {
      tty: true,
      input: 'astro\n',
    })
    await expect(promptChoice(invalidChoiceIo.io, 'Framework', ['nuxt', 'next'], 'nuxt')).rejects.toThrow('Unsupported Framework')
    const optionalPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'forms,validation\n',
    })
    await expect(promptOptionalPackages(optionalPromptIo.io)).resolves.toEqual(['forms', 'validation'])
    const multiChoicePromptIo = createIo(baseRoot, {
      tty: true,
      input: 'workos, clerk\n',
    })
    await expect(promptMultiChoice(multiChoicePromptIo.io, 'Auth providers', ['social', 'workos', 'clerk'])).resolves.toEqual(['workos', 'clerk'])
    const securityPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'security\n',
    })
    await expect(promptOptionalPackages(securityPromptIo.io)).resolves.toEqual(['security'])
    const broadcastPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'broadcast\n',
    })
    await expect(promptOptionalPackages(broadcastPromptIo.io)).resolves.toEqual(['broadcast'])
    const formsOnlyPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'forms\n',
    })
    await expect(promptOptionalPackages(formsOnlyPromptIo.io)).resolves.toEqual(['forms', 'validation'])
    expect(normalizeChoice('next', ['nuxt', 'next'], 'Framework')).toBe('next')
    expect(() => normalizeChoice('astro', ['nuxt', 'next'], 'Framework')).toThrow('Unsupported Framework')
    expect(() => normalizeChoice(undefined, ['nuxt', 'next'], 'Framework')).toThrow('(empty)')
    expect(() => normalizeOptionalPackages(['weird-package'])).toThrow('Unsupported optional package')
    expect(normalizeOptionalPackages(['broadcast'])).toEqual(['broadcast'])
    expect(normalizeOptionalPackages(['realtime'])).toEqual(['realtime'])
    expect(normalizeOptionalPackages(['security'])).toEqual(['security'])
    expect(normalizeOptionalPackages(['forms'])).toEqual(['forms', 'validation'])
    expect(normalizeOptionalPackages(['forms', 'validation', 'forms'])).toEqual(['forms', 'validation'])
    expect(normalizeOptionalPackages(['form', 'validate', 'storage', 'queue', 'events'])).toEqual([
      'events',
      'forms',
      'queue',
      'storage',
      'validation',
    ])
    expect(normalizeOptionalPackages(['none'])).toEqual([])
  })

  it('rejects conflicting and unsupported new project input', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['demo'],
      flags: { name: 'other' },
    })).rejects.toThrow('Conflicting project names')

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['demo'],
      flags: { framework: 'astro' },
    })).rejects.toThrow('Unsupported framework')

    await expect(resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['demo'],
      flags: { package: 'weird-package' },
    })).rejects.toThrow('Unsupported optional package')
  })

  it('prepares discovery artifacts and syncs managed driver dependencies before installing them', async ({ signal }) => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceCli(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'postgres',
      url: 'postgres://localhost/app',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
      },
    }, null, 2))

    const io = createIo(projectRoot)
    await runProjectPrepare(projectRoot, io.io, { signal })

    expect(await readFile(join(projectRoot, '.holo-js/generated/registry.json'), 'utf8')).toContain('"version": 1')
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-postgres': expectedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies?.['@holo-js/db-sqlite']).toBeUndefined()
    await expectPackageManagerInstallRequested(projectRoot)
  })

  it('syncs cache optional packages from config/cache.ts during prepare', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceCli(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {},
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'redis',
  drivers: {
    redis: {
      driver: 'redis',
      connection: 'cache',
    },
    database: {
      driver: 'database',
      connection: 'main',
      table: 'cache',
      lockTable: 'cache_locks',
    },
  },
})
`)

    await runProjectPrepare(projectRoot)

    const syncedDependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {}
    expect(syncedDependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
    expect(syncedDependencies['@holo-js/cache-db']).toBe(expectedHoloPackageRange)
    expect(syncedDependencies['@holo-js/cache-redis']).toBe(expectedHoloPackageRange)
    expect(typeof syncedDependencies.ioredis).toBe('string')

    await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'file',
  drivers: {
    file: {
      driver: 'file',
      path: '.holo/cache',
    },
  },
})
`)

    await runProjectPrepare(projectRoot)

    const dependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {}
    expect(dependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
    expect(dependencies['@holo-js/cache-db']).toBeUndefined()
    expect(dependencies['@holo-js/cache-redis']).toBeUndefined()
    expect(dependencies.ioredis).toBeUndefined()
  })

  it('preserves package-only cache support during prepare when config/cache.ts is absent', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceCli(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
      },
    }, null, 2))

    const io = createIo(projectRoot)
    await runProjectPrepare(projectRoot, io.io)

    const dependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {}
    expect(dependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
    await expectPackageManagerInstallRequested(projectRoot)
  })

  it('caches evaluated config values and clears the cache through the CLI', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME'),
  key: env('APP_KEY'),
})
`)

    const cached = runCliProcess(projectRoot, ['config:cache'], {
      env: {
        APP_ENV: 'production',
        APP_NAME: 'Cached App',
        APP_KEY: 'super-secret',
      },
    })
    expect(cached.status, cached.stderr || cached.stdout).toBe(0)
    expect(cached.stdout).toContain('Config cached:')

    const cachePath = join(projectRoot, '.holo-js/generated/config-cache.json')
    const cacheContents = await readFile(cachePath, 'utf8')
    expect(cacheContents).toContain('"key": "super-secret"')
    expect(cacheContents).toContain('"name": "Cached App"')
    expect(cacheContents).not.toContain('__holoEnv')

    await writeProjectFile(projectRoot, 'config/app.ts', 'export default (() => { throw new Error("live config should not load") })()')

    const listed = runCliProcess(projectRoot, ['list'], {
      env: {
        APP_ENV: 'production',
        APP_NAME: 'Cached App',
        APP_KEY: 'super-secret',
      },
    })
    expect(listed.status, listed.stderr || listed.stdout).toBe(0)
    expect(listed.stdout).toContain('Internal commands:')

    const cleared = runCliProcess(projectRoot, ['config:clear'])
    expect(cleared.status, cleared.stderr || cleared.stdout).toBe(0)
    expect(cleared.stdout).toContain('Config cache cleared:')
    await expect(readTextFile(cachePath)).resolves.toBeUndefined()

    const clearedAgain = runCliProcess(projectRoot, ['config:clear'])
    expect(clearedAgain.status, clearedAgain.stderr || clearedAgain.stdout).toBe(0)
    expect(clearedAgain.stdout).toContain('Config cache was already clear:')
  }, 30000)

  it('lists internal commands without requiring prebuilt discovery artifacts', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await rm(join(projectRoot, '.holo-js'), { recursive: true, force: true })

    const listedIo = createIo(projectRoot)
    await expect(import('../src/cli').then(module => module.runCli(['list'], listedIo.io))).resolves.toBe(0)
    expect(listedIo.read().stdout).toContain('Internal commands:')
    expect(listedIo.read().stdout).toContain('App commands:')
    expect(listedIo.read().stdout).toContain('(none)')
  })

  it('creates nested model scaffolds and registers runtime artifacts', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const result = runCliProcess(projectRoot, ['make:model', 'courses/Course', '--migration', '--observer', '--seeder', '--factory'])
    expect(result.status).toBe(0)

    const model = await readFile(join(projectRoot, 'server/models/courses/Course.ts'), 'utf8')
    const observer = await readFile(join(projectRoot, 'server/db/observers/courses/CourseObserver.ts'), 'utf8')
    const factory = await readFile(join(projectRoot, 'server/db/factories/courses/CourseFactory.ts'), 'utf8')
    const seeder = await readFile(join(projectRoot, 'server/db/seeders/courses/CourseSeeder.ts'), 'utf8')
    const generatedModels = await readFile(join(projectRoot, '.holo-js/generated/models.ts'), 'utf8')
    const generatedSeeders = await readFile(join(projectRoot, '.holo-js/generated/seeders.ts'), 'utf8')
    const generatedMigrations = await readFile(join(projectRoot, '.holo-js/generated/migrations.ts'), 'utf8')

    expect(model).toContain('observers: [CourseObserver]')
    expect(model).toContain('defineModel(')
    expect(model).toContain('import { defineModel } from \'@holo-js/db\'')
    expect(model).toContain('export default defineModel("courses", {')
    expect(model).not.toContain('table => table')
    expect(model).not.toContain('.id()')
    expect(model).not.toContain('.timestamps()')
    expect(observer).toContain('export class CourseObserver')
    expect(factory).toContain('defineFactory')
    expect(seeder).toContain('defineSeeder')
    expect(generatedSeeders).toContain('server/db/seeders/courses/CourseSeeder.ts')
    expect(generatedMigrations).toContain('server/db/migrations/')

  }, 30000)

  it('detects duplicate generated model tables from source literals without matching comments', async () => {
    const duplicateRoot = await createTempProject()
    tempDirs.push(duplicateRoot)
    await linkWorkspaceDb(duplicateRoot)
    await ensureGeneratedSchemaPlaceholder(duplicateRoot, defaultProjectConfig())
    await writeProjectFile(duplicateRoot, 'server/models/LegacyPerson.ts', `
import '../../.holo-js/generated/schema.generated'
import { defineModel } from '@holo-js/db'

// defineModel("children", {}) is only documentation and should not block Child.
export default defineModel('people', {})
`)

    const duplicateIo = createIo(duplicateRoot)
    await expect(import('../src/cli').then(module => module.runCli(['make:model', 'Person'], duplicateIo.io))).resolves.toBe(1)
    expect(duplicateIo.read().stderr).toContain('Discovered duplicate model "LegacyPerson" for table "people".')

    const commentOnlyRoot = await createTempProject()
    tempDirs.push(commentOnlyRoot)
    await linkWorkspaceDb(commentOnlyRoot)
    await ensureGeneratedSchemaPlaceholder(commentOnlyRoot, defaultProjectConfig())
    await writeProjectFile(commentOnlyRoot, 'server/models/Notes.ts', `
// defineModel("children", {}) appears in a comment only.
/* defineModel("children", {}) also appears in a block comment only. */
if (false) {
  const tableName = 'children'
  notdefineModel("children", {})
  defineModel(tableName, {})
  defineModel("parents", {})
  defineModel("child\\\\ren", {})
}
export const holoModelPendingSchema = true
export default undefined
`)

    const commentOnlyIo = createIo(commentOnlyRoot)
    await expect(import('../src/cli').then(module => module.runCli(['make:model', 'Child'], commentOnlyIo.io))).resolves.toBe(0)
    await expect(readFile(join(commentOnlyRoot, 'server/models/Child.ts'), 'utf8')).resolves.toContain('export default defineModel("children", {')
  }, 30000)

  it('prunes all registered prunable models with no arguments and rejects explicit non-prunable models', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    observers: 'server/db/observers',
    factories: 'server/db/factories',
    commands: 'server/commands',
  },
  models: [
    'server/models/Session.ts',
    'server/models/User.ts',
  ],
  migrations: [],
  seeders: [],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    sessions: typeof sessions
    users: typeof users
  }
}

export const sessions = defineGeneratedTable('sessions', {
  id: column.id(),
  expires_at: column.string(),
})

export const users = defineGeneratedTable('users', {
  id: column.id(),
  name: column.string(),
})

export const tables = { sessions, users } as const

registerGeneratedTables(tables)
`)

    await writeProjectFile(projectRoot, 'server/models/Session.ts', `
import '../../.holo-js/generated/schema.generated'
import { defineModel } from '@holo-js/db'

export default defineModel('sessions', {
  prunable: query => query.where('expires_at', '<', '2026-01-01T00:00:00.000Z'),
})
`)

    await writeProjectFile(projectRoot, 'server/models/User.ts', `
import '../../.holo-js/generated/schema.generated'
import { defineModel } from '@holo-js/db'

export default defineModel('users')
`)

    await writeProjectFile(projectRoot, 'setup.mjs', `
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { configureDB, createSchemaService, DB, registerDatabaseDriverFactory, resolveRuntimeConnectionManagerOptions } from '@holo-js/db'

registerDatabaseDriverFactory(sqliteDatabaseDriverFactory)

const manager = resolveRuntimeConnectionManagerOptions({
  db: {
    connections: {
      default: {
        driver: 'sqlite',
        url: './data.sqlite',
      },
    },
  },
})

configureDB(manager)
await manager.initializeAll()

const schema = createSchemaService(DB.connection())
await schema.createTable('sessions', (table) => {
  table.id()
  table.string('expires_at')
})
await schema.createTable('users', (table) => {
  table.id()
  table.string('name')
})

const adapter = manager.connection().getAdapter()
await adapter.execute("INSERT INTO \\"sessions\\" (\\"id\\", \\"expires_at\\") VALUES (1, '2020-01-01T00:00:00.000Z')")
await adapter.execute("INSERT INTO \\"sessions\\" (\\"id\\", \\"expires_at\\") VALUES (2, '2020-02-01T00:00:00.000Z')")
await adapter.execute("INSERT INTO \\"sessions\\" (\\"id\\", \\"expires_at\\") VALUES (3, '2027-01-01T00:00:00.000Z')")

await adapter.execute("INSERT INTO \\"users\\" (\\"id\\", \\"name\\") VALUES (1, 'Amina')")

await manager.disconnectAll()
`)

    const setup = runNode(projectRoot, join(projectRoot, 'setup.mjs'))
    if (setup.status !== 0) {
      throw new Error(setup.stderr || setup.stdout)
    }

    const pruned = runCliProcess(projectRoot, ['prune'])
    if (pruned.status !== 0) {
      throw new Error(pruned.stderr || pruned.stdout)
    }
    expect(pruned.stdout).toContain('Session: deleted 2')
    expect(pruned.stdout).toContain('Total deleted: 2')

    const invalid = runCliProcess(projectRoot, ['prune', 'User'])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('Model "User" does not define a prunable query.')
  }, 120000)

  it('merges DB environment settings with manifest runtime config', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    observers: 'server/db/observers',
    factories: 'server/db/factories',
    commands: 'server/commands',
  },
  models: ['server/models/Session.ts'],
  migrations: [],
  seeders: [],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
    },
  },
})
`)

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    sessions: typeof sessions
  }
}

export const sessions = defineGeneratedTable('sessions', {
  id: column.id(),
  expires_at: column.string(),
})

export const tables = { sessions } as const

registerGeneratedTables(tables)
`)

    await writeProjectFile(projectRoot, 'server/models/Session.ts', `
import '../../.holo-js/generated/schema.generated'
import { defineModel } from '@holo-js/db'

export default defineModel('sessions', {
  prunable: query => query.where('expires_at', '<', '2026-01-01T00:00:00.000Z'),
})
`)

    await writeProjectFile(projectRoot, 'setup.mjs', `
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { configureDB, createSchemaService, DB, registerDatabaseDriverFactory, resolveRuntimeConnectionManagerOptions } from '@holo-js/db'

registerDatabaseDriverFactory(sqliteDatabaseDriverFactory)

const manager = resolveRuntimeConnectionManagerOptions({
  db: {
    connections: {
      default: {
        driver: 'sqlite',
        url: './env.sqlite',
      },
    },
  },
})

configureDB(manager)
await manager.initializeAll()

const schema = createSchemaService(DB.connection())
await schema.createTable('sessions', (table) => {
  table.id()
  table.string('expires_at')
})

const adapter = manager.connection().getAdapter()
await adapter.execute("INSERT INTO \\"sessions\\" (\\"id\\", \\"expires_at\\") VALUES (1, '2020-01-01T00:00:00.000Z')")
await adapter.execute("INSERT INTO \\"sessions\\" (\\"id\\", \\"expires_at\\") VALUES (2, '2027-01-01T00:00:00.000Z')")

await manager.disconnectAll()
`)

    const setup = runNode(projectRoot, join(projectRoot, 'setup.mjs'))
    if (setup.status !== 0) {
      throw new Error(setup.stderr || setup.stdout)
    }

    const pruned = runCliProcess(projectRoot, ['prune'], {
      env: {
        DB_DRIVER: 'sqlite',
        DB_URL: './env.sqlite',
      },
    })

    if (pruned.status !== 0) {
      throw new Error(pruned.stderr || pruned.stdout)
    }
    expect(pruned.stdout).toContain('Session: deleted 1')
    await expect(readFile(join(projectRoot, 'env.sqlite'))).resolves.toBeDefined()
    await expect(readFile(join(projectRoot, 'data/database.sqlite'))).rejects.toThrow()
  }, 120000)

  it('rewrites schema.generated.ts after migrate rollback', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    observers: 'server/db/observers',
    factories: 'server/db/factories',
    commands: 'server/commands',
  },
  models: [],
  migrations: ['server/db/migrations/2026_01_01_000001_create_users.ts'],
  seeders: [],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)

    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_users.ts', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('users')
  },
})
`)

    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)

    const generatedPath = join(projectRoot, '.holo-js/generated/schema.generated.ts')
    await expect(readFile(generatedPath, 'utf8')).resolves.toContain('export const users = defineGeneratedTable("users", {')

    const rolledBack = runCliProcess(projectRoot, ['migrate:rollback'], { env: { APP_ENV: 'development' } })
    expect(rolledBack.status, rolledBack.stderr || rolledBack.stdout).toBe(0)

    const generated = await readFile(generatedPath, 'utf8')
    expect(generated).toContain('registerGeneratedTables(tables)')
    expect(generated).not.toContain('defineGeneratedTable("users"')
  }, 30000)

  it('refuses destructive database commands in production without a terminal unless --force is passed', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    for (const args of [['seed'], ['migrate:rollback'], ['migrate:fresh']]) {
      const refused = runCliProcess(projectRoot, args, { env: { APP_ENV: 'production' } })
      expect(refused.status, args.join(' ')).toBe(1)
      expect(refused.stderr, args.join(' ')).toContain('needs --force to run without confirmation')
    }
  }, 30000)

  it('skips migrate --isolated while another runner holds the migration lock', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)
    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const created = runCliProcess(projectRoot, ['migrate', '--isolated'])
    expect(created.status, created.stderr || created.stdout).toBe(0)

    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_users.ts', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('users')
  },
})
`)
    const database = createDatabase({
      adapter: createSQLiteAdapter({ filename: join(projectRoot, 'data.sqlite') }),
      dialect: createDialect('sqlite'),
    })
    try {
      await new TableQueryBuilder('_holo_migration_locks', database).insert({
        name: 'migrations',
        owner: 'other-runner',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })

      const artifactPath = join(projectRoot, '.holo-js/generated/schema.generated.ts')
      await writeFile(artifactPath, '// written by the runner that holds the lock\n', 'utf8')
      const skipped = runCliProcess(projectRoot, ['migrate', '--isolated'])
      expect(skipped.status, skipped.stderr || skipped.stdout).toBe(0)
      expect(skipped.stdout).toContain('holds the migration lock; no migrations were executed.')
      await expect(createSchemaService(database).hasTable('users')).resolves.toBe(false)
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('// written by the runner that holds the lock\n')

      await new TableQueryBuilder('_holo_migration_locks', database).where('owner', 'other-runner').delete()
    } finally {
      await database.disconnect()
    }

    const applied = runCliProcess(projectRoot, ['migrate', '--isolated'])
    expect(applied.status, applied.stderr || applied.stdout).toBe(0)
    expect(applied.stdout).toContain('Migrations executed:')
  }, 30000)

  it('executes plugin-published migrations through the existing migration lifecycle', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  plugins: ['fixture-migrations'],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)
    const pluginRoot = join(projectRoot, 'node_modules/fixture-migrations')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'fixture-migrations',
      type: 'module',
      holo: { plugin: './plugin.mjs' },
    }))
    await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'fixture-migrations',
  contributes: {
    migrations: { publish: './migrations.mjs' },
  },
}
`)
    await writeFile(join(pluginRoot, 'migrations.mjs'), `
import { defineMigration } from '@holo-js/db'

export const migrations = [defineMigration({
  name: '2026_07_29_000001_create_plugin_roles',
  async up({ schema }) {
    await schema.createTable('plugin_roles', table => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('plugin_roles')
  },
})]
`)

    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)
    expect(migrated.stdout).toContain('2026_07_29_000001_create_plugin_roles')
    await expect(readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8'))
      .resolves.toContain('defineGeneratedTable("plugin_roles"')

    const rolledBack = runCliProcess(projectRoot, ['migrate:rollback'], { env: { APP_ENV: 'development' } })
    expect(rolledBack.status, rolledBack.stderr || rolledBack.stdout).toBe(0)
    expect(rolledBack.stdout).toContain('2026_07_29_000001_create_plugin_roles')
  }, 60000)

  it('rescans the migration directory before running migrate with an existing registry', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)

    const staleRegistry = await prepareProjectDiscovery(projectRoot)
    expect(staleRegistry.migrations).toEqual([])

    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_rooms.ts', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('rooms', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('rooms')
  },
})
`)

    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)

    const refreshedRegistry = await loadGeneratedProjectRegistry(projectRoot)
    expect(refreshedRegistry?.migrations).toEqual([
      expect.objectContaining({
        sourcePath: 'server/db/migrations/2026_01_01_000001_create_rooms.ts',
      }),
    ])
    await expect(readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8'))
      .resolves.toContain('export const rooms = defineGeneratedTable("rooms", {')
  }, 120000)

  it('rebuilds generated schema artifacts when an already-ran migration reads database state', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    observers: 'server/db/observers',
    factories: 'server/db/factories',
    commands: 'server/commands',
  },
  models: [],
  migrations: ['server/db/migrations/2026_01_01_000001_create_users.ts'],
  seeders: [],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)

    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_users.ts', `
import { DB, defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
    })

    await DB.table('users').insert({ name: 'Ada' })
    const users = await DB.table('users').get()
    if (users.length > 0) {
      await schema.createTable('profiles', (table) => {
        table.id()
        table.integer('user_id')
      })
    }
  },
  async down({ schema }) {
    await schema.dropTable('profiles')
    await schema.dropTable('users')
  },
})
`)

    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const users = defineGeneratedTable('users', {
  id: column.id(),
  stale_name: column.string(),
})

export const tables = { users } as const
registerGeneratedTables(tables)
`)
    await writeProjectFile(projectRoot, '.holo-js/generated/schema.mjs', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const users = defineGeneratedTable('users', {
  id: column.id(),
  stale_name: column.string(),
})

export const tables = Object.freeze({ users })
registerGeneratedTables(tables)
`)

    const repaired = runCliProcess(projectRoot, ['migrate'])
    expect(repaired.status, repaired.stderr || repaired.stdout).toBe(0)
    expect(repaired.stdout).toContain('No migrations were executed.')

    const generatedTypeScript = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
    const generatedRuntime = await readFile(join(projectRoot, '.holo-js/generated/schema.mjs'), 'utf8')
    expect(generatedTypeScript).toContain('"name": column.string()')
    expect(generatedTypeScript).toContain('export const profiles = defineGeneratedTable("profiles", {')
    expect(generatedTypeScript).not.toContain('stale_name')
    expect(generatedRuntime).toContain('"name": column.string()')
    expect(generatedRuntime).toContain('export const profiles = defineGeneratedTable("profiles", {')
    expect(generatedRuntime).not.toContain('stale_name')
  }, 90000)

  it('recovers migration metadata when a discovered model uses a generated table without a primary key', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: { driver: 'sqlite', url: './data.sqlite' },
  },
})
`)
    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_choices.ts', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('choices', table => {
      table.id()
      table.string('label')
    })
  },
  async down({ schema }) {
    await schema.dropTable('choices')
  },
})
`)
    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)

    const staleSchema = `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const choices = defineGeneratedTable('choices', { label: column.string() })
export const tables = { choices }
registerGeneratedTables(tables)
`
    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', staleSchema)
    await writeProjectFile(projectRoot, '.holo-js/generated/schema.mjs', staleSchema)
    await writeProjectFile(projectRoot, 'server/models/Choice.ts', `
import { defineModel } from '@holo-js/db'

export default defineModel('choices', { fillable: ['label'] })
`)
    await writeProjectFile(projectRoot, 'server/db/seeders/ChoiceSeeder.ts', `
import { defineSeeder } from '@holo-js/db'
import Choice from '../../models/Choice'

export default defineSeeder({
  name: 'ChoiceSeeder',
  async run() {
    await Choice.create({ label: 'Ready' })
  },
})
`)

    const repaired = runCliProcess(projectRoot, ['migrate'])
    expect(repaired.status, repaired.stderr || repaired.stdout).toBe(0)
    expect(repaired.stdout).toContain('No migrations were executed.')
    for (const path of ['schema.generated.ts', 'schema.mjs']) {
      expect(await readFile(join(projectRoot, '.holo-js/generated', path), 'utf8')).toContain('"id": column.id()')
    }

    const prepared = runCliProcess(projectRoot, ['prepare'])
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0)
    const registry = await loadGeneratedProjectRegistry(projectRoot)
    expect(registry?.models).toEqual([expect.objectContaining({ tableName: 'choices' })])
    expect(registry?.seeders).toEqual([expect.objectContaining({ name: 'ChoiceSeeder' })])

    const seeded = runCliProcess(projectRoot, ['seed'], { env: { APP_ENV: 'development' } })
    expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0)
    const database = new DatabaseSync(join(projectRoot, 'data.sqlite'))
    try {
      expect(database.prepare('SELECT label FROM choices').all()).toEqual([{ label: 'Ready' }])
    } finally {
      database.close()
    }
  }, 90000)

  it('refreshes generated-schema bundles before running migrate:fresh seeders', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const built = await runWorkspacePackageBuild('@holo-js/db')
    expect(built.status).toBe(0)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    observers: 'server/db/observers',
    factories: 'server/db/factories',
    commands: 'server/commands',
  },
  models: ['server/models/User.ts', 'server/models/Admin.ts'],
  migrations: ['server/db/migrations/2026_01_01_000001_create_users.ts'],
  seeders: ['server/db/seeders/UserSeeder.ts', 'server/db/seeders/AdminSeeder.ts'],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    users: typeof users
  }
}

export const users = defineGeneratedTable('users', {
  id: column.id(),
})

export const tables = { users } as const

registerGeneratedTables(tables)
`)

    await writeProjectFile(projectRoot, 'server/models/User.ts', `
import '../../.holo-js/generated/schema.generated'
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name'],
})
`)

    await writeProjectFile(projectRoot, 'server/models/Admin.ts', `
import '../../.holo-js/generated/schema.generated'
import { defineModel } from '@holo-js/db'

export default defineModel('admins', {
  fillable: ['name'],
})
`)

    await writeProjectFile(projectRoot, 'server/db/seeders/UserSeeder.ts', `
import User from '../../models/User'
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'UserSeeder',
  async run() {
    await User.query().where('name', '=', 'Alice').count()
  },
})
`)

    await writeProjectFile(projectRoot, 'server/db/seeders/AdminSeeder.ts', `
import Admin from '../../models/Admin'
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'AdminSeeder',
  async run() {
    await Admin.unguarded(() => Admin.create({
      name: 'Root',
    }))
  },
})
`)

    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_users.ts', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable('admins', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('admins')
    await schema.dropTable('users')
  },
})
`)

    const fresh = runCliProcess(projectRoot, ['migrate:fresh', '--seed'], { env: { APP_ENV: 'development' } })
    expect(fresh.status, fresh.stderr || fresh.stdout).toBe(0)
    expect(fresh.stdout).toContain('Seeders executed:')
    expect(fresh.stdout).toContain('UserSeeder')
    expect(fresh.stdout).toContain('AdminSeeder')

    const generated = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
    expect(generated).toContain('"name": column.string()')
    expect(generated).toContain('export const admins = defineGeneratedTable("admins", {')
  }, 30000)

  it('reads seeder fixtures relative to each source module', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  seeders: ['server/db/seeders/FixtureSeeder.ts'],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
export default {
  connections: {
    default: { driver: 'sqlite', url: './data.sqlite' },
  },
}
`)
    await writeProjectFile(projectRoot, 'server/db/seeders/fixture.txt', 'seeder fixture')
    await writeProjectFile(projectRoot, 'server/fixtures/fixture.txt', 'helper fixture')
    await writeProjectFile(projectRoot, 'server/fixtures/readFixture.ts', `
import { readFile } from 'node:fs/promises'

export function readFixture(): Promise<string> {
  return readFile(new URL('./fixture.txt', import.meta.url), 'utf8')
}
`)
    await writeProjectFile(projectRoot, 'server/db/seeders/FixtureSeeder.ts', `
import { readFile } from 'node:fs/promises'
import { defineSeeder } from '@holo-js/db'
import { readFixture } from '../../fixtures/readFixture'

export default defineSeeder({
  name: 'fixtures',
  async run() {
    const fixture = await readFile(new URL('./fixture.txt', import.meta.url), 'utf8')
    process.stdout.write(JSON.stringify({ fixture, helper: await readFixture() }) + '\\n')
  },
})
`)

    const result = runCliProcess(projectRoot, ['seed', '--only', 'fixtures'], {
      env: { NODE_NO_WARNINGS: '1', APP_ENV: 'development' },
    })

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(JSON.stringify({
      fixture: 'seeder fixture',
      helper: 'helper fixture',
    }))
  }, 30_000)

  it('boots configured application services before migrate:fresh runs seeders', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkBuiltWorkspacePackagesSync(projectRoot)
    const cachePath = join(projectRoot, 'storage/framework/cache')

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    observers: 'server/db/observers',
    factories: 'server/db/factories',
    commands: 'server/commands',
  },
  models: ['server/models/User.mjs'],
  migrations: ['server/db/migrations/2026_01_01_000001_create_users.mjs'],
  seeders: ['server/db/seeders/UserSeeder.mjs'],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'file',
  drivers: {
    file: {
      driver: 'file',
      path: ${JSON.stringify(cachePath)},
    },
  },
})
`)
    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const users = defineGeneratedTable('users', {
  id: column.id(),
  name: column.string(),
})

export const tables = { users } as const
registerGeneratedTables(tables)
`)
    await writeProjectFile(projectRoot, '.holo-js/generated/schema.mjs', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const users = defineGeneratedTable('users', {
  id: column.id(),
  name: column.string(),
})

export const tables = Object.freeze({ users })
registerGeneratedTables(tables)
`)
    await writeProjectFile(projectRoot, 'server/db/observers/UserObserver.mjs', `
import cache from '@holo-js/cache'
import { DB } from '@holo-js/db'

export class UserObserver {
  created() {
    DB.afterCommit(async () => {
      await cache.forget('users.index')
    })
  }
}
`)
    await writeProjectFile(projectRoot, 'server/models/User.mjs', `
import '../../.holo-js/generated/schema.mjs'
import { defineModel } from '@holo-js/db'
import { UserObserver } from '../db/observers/UserObserver.mjs'

export default defineModel('users', {
  fillable: ['name'],
  observers: [UserObserver],
})
`)
    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_users.mjs', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('users')
  },
})
`)
    await writeProjectFile(projectRoot, 'server/db/seeders/UserSeeder.mjs', `
import User from '../../models/User.mjs'
import { defineSeeder } from '@holo-js/db'

export default defineSeeder({
  name: 'UserSeeder',
  async run() {
    await User.create({ name: 'Amina' })
  },
})
`)
    await writeProjectFile(projectRoot, 'cache-fixture.mjs', `
import cache from '@holo-js/cache'
import { initializeHolo } from '@holo-js/core'
import User from './server/models/User.mjs'

const runtime = await initializeHolo(process.cwd())

try {
  if (process.argv[2] === 'prime') {
    await cache.put('users.index', 'stale', 300)
  } else {
    const user = await User.find(1)
    process.stdout.write(JSON.stringify({
      cached: await cache.get('users.index'),
      userName: user?.get('name'),
    }))
  }
} finally {
  await runtime.shutdown()
}
`)

    const primed = runNodeScript(projectRoot, join(projectRoot, 'cache-fixture.mjs'), ['prime'])
    expect(primed.status, primed.stderr || primed.stdout).toBe(0)

    const fresh = runCliProcess(projectRoot, ['migrate:fresh', '--seed'], { env: { APP_ENV: 'development' } })
    const verified = runNodeScript(projectRoot, join(projectRoot, 'cache-fixture.mjs'), ['verify'])

    expect(fresh.status, fresh.stderr || fresh.stdout).toBe(0)
    expect(verified.status, verified.stderr || verified.stdout).toBe(0)
    expect(JSON.parse(verified.stdout)).toEqual({
      cached: null,
      userName: 'Amina',
    })
  }, 30000)

  it('runs runtime commands without requiring the app to install @holo-js/db directly', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/app.ts', `
export default {
  models: [],
  migrations: [],
  seeders: [],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: './data.sqlite',
    },
  },
})
`)

    const result = runCliProcess(projectRoot, ['prune'])
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('No prunable models were registered.')
    await expect(readTextFile(join(projectRoot, '.holo-js/runtime/cli/node_modules/@holo-js/db/package.json'))).resolves.toBeUndefined()
  }, 30000)

  it('keeps shared runtime dependency links while concurrent invocations are active', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const [firstRoot, secondRoot] = await Promise.all([
      ensureRuntimeDependencyLink(projectRoot),
      ensureRuntimeDependencyLink(projectRoot),
    ])

    expect(firstRoot).toBe(secondRoot)
    await expect(readTextFile(join(firstRoot, 'node_modules/@holo-js/db/package.json'))).resolves.toContain('"name": "@holo-js/db"')
    await expect(readTextFile(join(secondRoot, 'node_modules/@holo-js/db/package.json'))).resolves.toContain('"name": "@holo-js/db"')

    await cleanupRuntimeDependencyLink(projectRoot)
    await expect(readTextFile(join(secondRoot, 'node_modules/@holo-js/db/package.json'))).resolves.toContain('"name": "@holo-js/db"')

    await cleanupRuntimeDependencyLink(projectRoot)
    await expect(readTextFile(join(secondRoot, 'node_modules/@holo-js/db/package.json'))).resolves.toBeUndefined()
  }, 30000)
})

describe('CLI helpers', () => {
  it('covers project loading and app command discovery with the Node bundler', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    commands: 'server/commands',
  },
})
`)
    await writeProjectFile(projectRoot, 'server/models/User.mjs', `
export default {
  definition: { kind: 'model', name: 'User', table: { tableName: 'users' }, prunable: true },
  async prune() { return 0 },
}
`)
    await writeProjectFile(projectRoot, 'server/commands/courses/reindex.mjs', `
export default {
  description: 'Reindex course data.',
  async run() {},
}
`)
    await writeProjectFile(projectRoot, 'server/nested/value.txt', 'x')

    await (async () => {
      await expect(findProjectRoot(join(projectRoot, 'server/nested'))).resolves.toBe(projectRoot)

      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.models).toEqual([])
      expect(loaded.config.paths.commands).toBe('server/commands')

      const commands = await discoverAppCommands(projectRoot, loaded.config)
      expect(commands).toHaveLength(1)
      expect(commands[0]?.name).toBe('courses:reindex')
    })()
  })

  it('covers command names from explicit exports and invalid command failures', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    commands: 'server/commands',
  },
})
`)
    await writeProjectFile(projectRoot, 'server/commands/renamed.mjs', `
export const command = {
  name: 'custom:renamed',
  description: 'Renamed command.',
  async run() {},
}
`)
    await writeProjectFile(projectRoot, 'server/commands/ignored.mjs', 'export default { nope: true }')

    await (async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      await expect(discoverAppCommands(projectRoot, loaded.config)).rejects.toThrow('does not export a Holo command')
    })()
  })

  it('discovers nested jobs, events, and listeners, including derived event names and invalid modules', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'default',
  connections: {
    default: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'redis',
  connections: {
    redis: {
      driver: 'redis',
      queue: 'emails',
    },
    database: {
      driver: 'database',
      queue: 'reports',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'server/jobs/media/generate-conversions.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  queue: 'media',
  tries: 3,
  backoff: [5, 30],
  timeout: 60,
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/jobs/reports/daily.mjs', `
import { defineJob } from '@holo-js/queue'

export const job = defineJob({
  connection: 'database',
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/jobs/send-email.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/jobs/fallback-queue.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  connection: 'sync',
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'

export default defineEvent({
  name: 'user.registered',
})
`)
    await writeProjectFile(projectRoot, 'server/events/audit/activity.mjs', `
import { defineEvent } from '@holo-js/events'

export const ActivityRecorded = defineEvent({
  name: 'audit.activity',
})
`)
    await writeProjectFile(projectRoot, 'server/listeners/user/send-welcome-email.mjs', `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered.mjs'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/listeners/audit/record-user-events.mjs', `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered.mjs'
import { ActivityRecorded } from '../../events/audit/activity.mjs'

export const listener = defineListener({
  name: 'audit.record-user-events-explicit',
  listensTo: [UserRegistered, ActivityRecorded],
  async handle() {},
})
`)

    await (async () => {
      const registry = await prepareProjectDiscovery(projectRoot)
      expect(registry.jobs).toEqual(expect.arrayContaining([
        {
          sourcePath: 'server/jobs/media/generate-conversions.mjs',
          name: 'media.generate-conversions',
          exportName: 'default',
          connection: 'redis',
          queue: 'media',
          tries: 3,
          backoff: [5, 30],
          timeout: 60,
        },
        {
          sourcePath: 'server/jobs/reports/daily.mjs',
          name: 'reports.daily',
          exportName: 'job',
          connection: 'database',
          queue: 'reports',
        },
        {
          sourcePath: 'server/jobs/send-email.mjs',
          name: 'send-email',
          exportName: 'default',
          connection: 'redis',
          queue: 'emails',
        },
        {
          sourcePath: 'server/jobs/fallback-queue.mjs',
          name: 'fallback-queue',
          exportName: 'default',
          connection: 'sync',
          queue: 'default',
        },
      ]))
      expect(registry.events).toEqual(expect.arrayContaining([
        {
          sourcePath: 'server/events/user/registered.mjs',
          name: 'user.registered',
          exportName: 'default',
        },
        {
          sourcePath: 'server/events/audit/activity.mjs',
          name: 'audit.activity',
          exportName: 'ActivityRecorded',
        },
      ]))
      expect(registry.listeners).toEqual(expect.arrayContaining([
        {
          sourcePath: 'server/listeners/user/send-welcome-email.mjs',
          id: 'user.send-welcome-email',
          eventNames: ['user.registered'],
          exportName: 'default',
        },
        {
          sourcePath: 'server/listeners/audit/record-user-events.mjs',
          id: 'audit.record-user-events-explicit',
          eventNames: ['user.registered', 'audit.activity'],
          exportName: 'listener',
        },
      ]))
      await expect(readFile(join(projectRoot, '.holo-js/generated/jobs.ts'), 'utf8')).resolves.toContain('"media.generate-conversions"')
      await expect(readFile(join(projectRoot, '.holo-js/generated/events.ts'), 'utf8')).resolves.toContain('"user.registered"')
      await expect(readFile(join(projectRoot, '.holo-js/generated/listeners.ts'), 'utf8')).resolves.toContain('"audit.record-user-events-explicit"')
      await expect(readFile(join(projectRoot, '.holo-js/generated/events.d.ts'), 'utf8')).resolves.toContain('declare module \'@holo-js/events\'')
    })()

    const invalidRoot = await createTempProject()
    tempDirs.push(invalidRoot)
    await writeProjectFile(invalidRoot, 'server/jobs/bad.mjs', 'export default { nope: true }')
    await (async () => {
      await expect(prepareProjectDiscovery(invalidRoot)).rejects.toThrow('does not export a Holo job')
    })()

    const invalidEventRoot = await createTempProject()
    tempDirs.push(invalidEventRoot)
    await writeProjectFile(invalidEventRoot, 'server/events/bad.mjs', 'export default { nope: true }')
    await (async () => {
      await expect(prepareProjectDiscovery(invalidEventRoot)).rejects.toThrow('does not export a Holo event')
    })()

    const invalidListenerRoot = await createTempProject()
    tempDirs.push(invalidListenerRoot)
    await writeProjectFile(invalidListenerRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await writeProjectFile(invalidListenerRoot, 'server/listeners/bad.mjs', 'export default { nope: true }')
    await (async () => {
      await expect(prepareProjectDiscovery(invalidListenerRoot)).rejects.toThrow('does not export a Holo listener')
    })()

    const hiddenEventRoot = await createTempProject()
    tempDirs.push(hiddenEventRoot)
    await writeProjectFile(hiddenEventRoot, 'server/events/.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(hiddenEventRoot)).rejects.toThrow('Derived event names require a non-empty source path.')
    })()

    const hiddenListenerRoot = await createTempProject()
    tempDirs.push(hiddenListenerRoot)
    await writeProjectFile(hiddenListenerRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await writeProjectFile(hiddenListenerRoot, 'server/listeners/.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  listensTo: ['user.registered'],
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(hiddenListenerRoot)).rejects.toThrow(
        'Derived listener identifiers require a non-empty source path.',
      )
    })()

    const stringListenerRoot = await createTempProject()
    tempDirs.push(stringListenerRoot)
    await writeProjectFile(stringListenerRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await writeProjectFile(stringListenerRoot, 'server/listeners/user/by-string.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  listensTo: [' user.registered '],
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(stringListenerRoot)).resolves.toMatchObject({
        listeners: [{
          id: 'user.by-string',
          eventNames: ['user.registered'],
        }],
      })
    })()

    const missingListenerEventRoot = await createTempProject()
    tempDirs.push(missingListenerEventRoot)
    await writeProjectFile(missingListenerEventRoot, 'server/events/audit/activity.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'audit.activity' })
`)
    await writeProjectFile(missingListenerEventRoot, 'server/listeners/user/missing-event.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  listensTo: ['user.registered'],
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(missingListenerEventRoot)).rejects.toThrow(
        'Listener "user.missing-event" references unknown event "user.registered".',
      )
    })()
    await writeProjectFile(missingListenerEventRoot, 'server/listeners/user/by-import.mjs', `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered.mjs'
export default defineListener({
  listensTo: [UserRegistered],
  async handle() {},
})
`)
    await expect(projectInternals.resolveListenerEventNamesFromSource(
      missingListenerEventRoot,
      join(missingListenerEventRoot, 'server/listeners/user/by-import.mjs'),
      new Map<string, string>([
        ['server/events/audit/activity.mjs', 'audit.activity'],
      ]),
    )).rejects.toThrow(
      'Listener event references must resolve to explicit event names before discovery registration.',
    )
    await writeProjectFile(missingListenerEventRoot, 'server/listeners/user/by-string-direct.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  listensTo: ['audit.activity'],
  async handle() {},
})
`)
    await expect(projectInternals.resolveListenerEventNamesFromSource(
      missingListenerEventRoot,
      join(missingListenerEventRoot, 'server/listeners/user/by-string-direct.mjs'),
      new Map<string, string>([
        ['server/events/audit/activity.mjs', 'audit.activity'],
      ]),
    )).resolves.toEqual(['audit.activity'])
    await writeProjectFile(missingListenerEventRoot, 'server/listeners/user/by-unbound-identifier.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  listensTo: [AuditActivity],
  async handle() {},
})
`)
    await expect(projectInternals.resolveListenerEventNamesFromSource(
      missingListenerEventRoot,
      join(missingListenerEventRoot, 'server/listeners/user/by-unbound-identifier.mjs'),
      new Map<string, string>([
        ['server/events/audit/activity.mjs', 'audit.activity'],
      ]),
    )).rejects.toThrow(
      'Listener event references must resolve to explicit event names before discovery registration.',
    )
    const referencedEvent = {}
    expect(projectInternals.resolveListenerEventNamesForDiscovery({
      listensTo: [referencedEvent],
      async handle() {},
    } as never, new Map<object, string>([
      [referencedEvent, 'audit.activity'],
    ]))).toEqual(['audit.activity'])
    expect(() => projectInternals.resolveListenerEventNamesForDiscovery({
      get listensTo() {
        throw new Error('boom')
      },
      async handle() {},
    } as never, new Map())).toThrow('boom')
    expect(projectInternals.collectImportedBindingsBySource(`
import Ignored from '   '
import { UserRegistered,  , AuditActivity as ActivityRecorded } from '../events/user'
`)).toEqual(new Map([
      ['UserRegistered', '../events/user'],
      ['ActivityRecorded', '../events/user'],
    ]))
    expect(projectInternals.extractListensToItems(`
export default defineListener({
  async handle() {},
})
`)).toEqual([])
    expect(projectInternals.extractListensToItems(`
export default defineListener({
  listensTo: ,
  async handle() {},
})
`)).toEqual([])
    expect(projectInternals.extractListensToItems(`
export default defineListener({
  listensTo ['audit.activity'],
  async handle() {},
})
`)).toEqual([])
    expect(projectInternals.extractListensToItems(`
export default defineListener({
  listensTo: resolveEventName(UserRegistered),
  async handle() {},
})
`)).toEqual(['resolveEventName(UserRegistered)'])
    await expect(projectInternals.resolveListenerEventNamesFromSource(
      missingListenerEventRoot,
      join(missingListenerEventRoot, 'server/listeners/user/missing-file.mjs'),
      new Map<string, string>(),
    )).resolves.toEqual([])

    const orderedListenersRoot = await createTempProject()
    tempDirs.push(orderedListenersRoot)
    await writeProjectFile(orderedListenersRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await writeProjectFile(orderedListenersRoot, 'server/listeners/a-first.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  name: 'z.listener',
  listensTo: ['user.registered'],
  async handle() {},
})
`)
    await writeProjectFile(orderedListenersRoot, 'server/listeners/z-last.mjs', `
import { defineListener } from '@holo-js/events'
export default defineListener({
  name: 'a.listener',
  listensTo: ['user.registered'],
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(orderedListenersRoot)).resolves.toMatchObject({
        listeners: [
          { id: 'a.listener' },
          { id: 'z.listener' },
        ],
      })
    })()

    const pathDerivedListenerRoot = await createTempProject()
    tempDirs.push(pathDerivedListenerRoot)
    await writeProjectFile(pathDerivedListenerRoot, 'server/events/audit/activity.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({})
`)
    await writeProjectFile(pathDerivedListenerRoot, 'server/listeners/audit/bad.mjs', `
import { defineListener } from '@holo-js/events'
import ActivityRecorded from '../../events/audit/activity.mjs'
export default defineListener({
  listensTo: [ActivityRecorded],
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(pathDerivedListenerRoot)).resolves.toMatchObject({
        events: [{
          name: 'audit.activity',
        }],
        listeners: [{
          id: 'audit.bad',
          eventNames: ['audit.activity'],
        }],
      })
    })()

    const singleReferenceListenerRoot = await createTempProject()
    tempDirs.push(singleReferenceListenerRoot)
    await writeProjectFile(singleReferenceListenerRoot, 'server/events/audit/activity.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({})
`)
    await writeProjectFile(singleReferenceListenerRoot, 'server/listeners/audit/single-reference.mjs', `
import { defineListener } from '@holo-js/events'
import ActivityRecorded from '../../events/audit/activity.mjs'
export default defineListener({
  listensTo: ActivityRecorded,
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(singleReferenceListenerRoot)).resolves.toMatchObject({
        events: [{
          name: 'audit.activity',
        }],
        listeners: [{
          id: 'audit.single-reference',
          eventNames: ['audit.activity'],
        }],
      })
    })()

    const extensionlessListenerImportRoot = await createTempProject()
    tempDirs.push(extensionlessListenerImportRoot)
    await writeProjectFile(extensionlessListenerImportRoot, 'server/events/audit/activity.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({})
`)
    await writeProjectFile(extensionlessListenerImportRoot, 'server/listeners/audit/by-extensionless-import.ts', `
import { defineListener } from '@holo-js/events'
import ActivityRecorded from '../../events/audit/activity'
export default defineListener({
  listensTo: [ActivityRecorded],
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(extensionlessListenerImportRoot)).resolves.toMatchObject({
        events: [{
          name: 'audit.activity',
        }],
        listeners: [{
          id: 'audit.by-extensionless-import',
          eventNames: ['audit.activity'],
        }],
      })
    })()

    const listenerDiscoveryErrorRoot = await createTempProject()
    tempDirs.push(listenerDiscoveryErrorRoot)
    await writeProjectFile(listenerDiscoveryErrorRoot, 'server/listeners/broken.mjs', `
const marker = Symbol.for('holo-js.events.listener')
const listener = {
  [marker]: true,
  get listensTo() {
    throw new Error('boom')
  },
  async handle() {},
}

export default listener
`)
    await (async () => {
      await expect(prepareProjectDiscovery(listenerDiscoveryErrorRoot)).rejects.toThrow('boom')
    })()

    const malformedRoot = await createTempProject()
    tempDirs.push(malformedRoot)
    await writeProjectFile(malformedRoot, 'server/jobs/malformed.mjs', `
export default {
  tries: 1.5,
  async handle() {},
}
`)
    await (async () => {
      await expect(prepareProjectDiscovery(malformedRoot)).rejects.toThrow('Job tries must be an integer when provided.')
    })()

    const fallbackRoot = await createTempDirectory()
    tempDirs.push(fallbackRoot)
    await linkWorkspaceQueue(fallbackRoot)
    await writeProjectFile(fallbackRoot, 'server/jobs/fallback.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(fallbackRoot)).resolves.toMatchObject({
        jobs: [{
          sourcePath: 'server/jobs/fallback.mjs',
          name: 'fallback',
          connection: 'sync',
          queue: 'default',
        }],
      })
    })()

    const authorizationFallbackRoot = await createTempProject()
    tempDirs.push(authorizationFallbackRoot)
    await writeProjectFile(authorizationFallbackRoot, 'server/policies/FallbackPolicy.mjs', `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    await writeProjectFile(authorizationFallbackRoot, 'server/abilities/fallback.mjs', `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('reports.export', () => true)
`)
    await expect(prepareProjectDiscovery(authorizationFallbackRoot)).resolves.toMatchObject({
      authorizationPolicies: [{ sourcePath: 'server/policies/FallbackPolicy.mjs', name: 'posts', target: 'Post' }],
      authorizationAbilities: [{ sourcePath: 'server/abilities/fallback.mjs', name: 'reports.export' }],
    })

    const duplicateRoot = await createTempProject()
    tempDirs.push(duplicateRoot)
    await writeProjectFile(duplicateRoot, 'server/jobs/shared.job.mjs', `
import { defineJob } from '@holo-js/queue'
export default defineJob({ async handle() {} })
`)
    await writeProjectFile(duplicateRoot, 'server/jobs/shared/job.mjs', `
import { defineJob } from '@holo-js/queue'
export default defineJob({ async handle() {} })
`)
    await (async () => {
      await expect(prepareProjectDiscovery(duplicateRoot)).rejects.toThrow('Discovered duplicate job "shared.job"')
    })()

    const duplicateEventRoot = await createTempProject()
    tempDirs.push(duplicateEventRoot)
    await writeProjectFile(duplicateEventRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'shared.event' })
`)
    await writeProjectFile(duplicateEventRoot, 'server/events/shared/event.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({})
`)
    await (async () => {
      await expect(prepareProjectDiscovery(duplicateEventRoot)).rejects.toThrow('Discovered duplicate event "shared.event"')
    })()
  }, 30000)

  it('covers direct config exports, empty command roots, and start-dir root fallback', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.mjs', `
export const config = {
  paths: {
    commands: 'server/commands',
  },
  models: [],
  migrations: [],
  seeders: [],
}
`)

    const nestedRoot = join(projectRoot, 'nested/inside')
    await mkdir(nestedRoot, { recursive: true })

    await (async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.paths.commands).toBe('server/commands')
      await expect(discoverAppCommands(projectRoot, loaded.config)).resolves.toEqual([])
    })()

    const detachedRoot = await createTempDirectory()
    tempDirs.push(detachedRoot)
    const detachedNested = join(detachedRoot, 'nested/inside')
    await mkdir(detachedNested, { recursive: true })

    await expect(findProjectRoot(detachedNested)).resolves.toBe(resolve(detachedNested))
  })

  it('prefers a higher holo manifest over a nearer nested package.json', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'apps/example/package.json', JSON.stringify({
      name: 'example',
      private: true,
    }, null, 2))
    await mkdir(join(projectRoot, 'apps/example/server/models'), { recursive: true })

    await expect(findProjectRoot(join(projectRoot, 'apps/example/server/models'))).resolves.toBe(projectRoot)
  })

  it('loads named config exports instead of normalizing the module namespace', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
export const config = {
  paths: {
    commands: 'app/commands',
    models: 'app/models',
    jobs: 'app/jobs',
  },
}
`)
    await writeProjectFile(projectRoot, 'app/models/User.mjs', `
export default {
  definition: { kind: 'model', name: 'User', table: { tableName: 'users' }, prunable: true },
  async prune() { return 0 },
}
`)
    await writeProjectFile(projectRoot, 'app/jobs/send-email.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    await (async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.paths.commands).toBe('app/commands')
      expect(loaded.config.paths.models).toBe('app/models')
      expect(loaded.config.paths.jobs).toBe('app/jobs')
      expect(loaded.config.models).toEqual([])

      const registry = await prepareProjectDiscovery(projectRoot, loaded.config)
      expect(registry.jobs).toMatchObject([{
        name: 'send-email',
        sourcePath: 'app/jobs/send-email.mjs',
        connection: 'sync',
        queue: 'default',
      }])

      const prepared = await loadProjectConfig(projectRoot, { required: true })
      expect(prepared.config.models).toEqual(['app/models/User.mjs'])
    })()
  })

  it('covers runCli in-process with the Node bundler', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/courses/reindex.mjs', `
import * as fs from 'node:fs'
import { join } from 'node:path'

export default {
  description: 'Reindex course data.',
  usage: 'holo courses:reindex',
  async run(context) {
    fs.appendFileSync(join(context.projectRoot, 'ran.txt'), 'ok')
  },
}
`)

    await (async () => {
      const defaultIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli([], defaultIo.io))).resolves.toBe(0)
      expect(defaultIo.read().stdout).toContain('Internal commands:')

      const listedIo = createIo(projectRoot)
      await expect(findCommand([], 'missing')).toBeUndefined()
      await expect(import('../src/cli').then(module => module.runCli(['list'], listedIo.io))).resolves.toBe(0)
      const listedOutput = listedIo.read().stdout
      expect(listedOutput).toContain('Internal commands:')
      expect(listedOutput).toContain('courses:reindex')
      expect(listedOutput).toContain('Reindex course data.')

      const helpIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli(['make:model', '--help'], helpIo.io))).resolves.toBe(0)
      expect(helpIo.read().stdout).toContain('Create a model and optionally related database artifacts.')

      const commandIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli(['courses:reindex'], commandIo.io))).resolves.toBe(0)
      await expect(readFile(join(projectRoot, 'ran.txt'), 'utf8')).resolves.toBe('ok')

      await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME'),
  key: env('APP_KEY'),
})
`)
      process.env.APP_ENV = 'production'
      process.env.APP_NAME = 'In Process'
      process.env.APP_KEY = 'in-process-secret'

      const cacheIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli(['config:cache'], cacheIo.io))).resolves.toBe(0)
      expect(cacheIo.read().stdout).toContain('Config cached:')

      const clearIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli(['config:clear'], clearIo.io))).resolves.toBe(0)
      expect(clearIo.read().stdout).toContain('Config cache cleared:')
      delete process.env.APP_ENV
      delete process.env.APP_NAME
      delete process.env.APP_KEY

      const unknownIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli(['unknown:command'], unknownIo.io))).resolves.toBe(1)
      expect(unknownIo.read().stderr).toContain('Unknown command "unknown:command".')
    })()
  }, 60000)

  it('covers runCli duplicate command conflicts and string-thrown app command failures', async () => {
    const duplicateRoot = await createTempProject()
    tempDirs.push(duplicateRoot)
    await writeProjectFile(duplicateRoot, 'server/commands/list.mjs', `
export default {
  description: 'Conflicts with the internal list command.',
  async run() {},
}
`)

    const failingRoot = await createTempProject()
    tempDirs.push(failingRoot)
    await writeProjectFile(failingRoot, 'server/commands/explode.mjs', `
export default {
  description: 'Explodes on purpose.',
  async run() {
    throw 'boom'
  },
}
`)

    await (async () => {
      const duplicateIo = createIo(duplicateRoot)
      await expect(import('../src/cli').then(module => module.runCli(['list'], duplicateIo.io))).resolves.toBe(1)
      expect(duplicateIo.read().stderr).toContain('conflicts with internal command')

      const failingIo = createIo(failingRoot)
      await expect(import('../src/cli').then(module => module.runCli(['explode'], failingIo.io))).resolves.toBe(1)
      expect(failingIo.read().stderr).toContain('boom')
    })()
  })

  it('rejects duplicate app command names and aliases', async () => {
    const duplicateAliasRoot = await createTempProject()
    tempDirs.push(duplicateAliasRoot)
    await writeProjectFile(duplicateAliasRoot, 'server/commands/first.mjs', `
export default {
  description: 'First command.',
  aliases: ['shared'],
  async run() {},
}
`)
    await writeProjectFile(duplicateAliasRoot, 'server/commands/second.mjs', `
export default {
  description: 'Second command.',
  aliases: ['shared'],
  async run() {},
}
`)

    const duplicateNameRoot = await createTempProject()
    tempDirs.push(duplicateNameRoot)
    await writeProjectFile(duplicateNameRoot, 'server/commands/alpha.mjs', `
export default {
  name: 'shared:name',
  description: 'Alpha command.',
  async run() {},
}
`)
    await writeProjectFile(duplicateNameRoot, 'server/commands/beta.mjs', `
export default {
  name: 'shared:name',
  description: 'Beta command.',
  async run() {},
}
`)

    await (async () => {
      const duplicateAliasIo = createIo(duplicateAliasRoot)
      await expect(import('../src/cli').then(module => module.runCli(['shared'], duplicateAliasIo.io))).resolves.toBe(1)
      expect(duplicateAliasIo.read().stderr).toContain('duplicate command token')
      expect(duplicateAliasIo.read().stderr).toContain('shared')

      const duplicateNameIo = createIo(duplicateNameRoot)
      await expect(import('../src/cli').then(module => module.runCli(['shared:name'], duplicateNameIo.io))).resolves.toBe(1)
      expect(duplicateNameIo.read().stderr).toContain('duplicate command')
      expect(duplicateNameIo.read().stderr).toContain('shared:name')
    })()
  })

  it('covers CLI parsing and registry helpers in-process', async () => {
    const command = defineCommand({
      aliases: ['sample'],
      description: 'Example command.',
      usage: 'holo example',
      async run() {},
    })
    const appDefinition = createAppCommandDefinition({
      sourcePath: 'server/commands/example.ts',
      name: 'example',
      aliases: ['sample'],
      description: 'Example command.',
      usage: 'holo example',
      async load() {
        return command
      },
    })
    const io = createIo('/tmp/project')

    expect(Object.isFrozen(command)).toBe(true)
    expect(parseTokens(['name', '--step', '2', '--quietly', '-f'])).toEqual({
      args: ['name'],
      flags: {
        step: '2',
        quietly: true,
        f: true,
      },
    })
    expect(parseTokens(['--only=roles', '--only', 'users', '--only', 'teachers', '-o', 'admins', '-abc', '--', '--literal'])).toEqual({
      args: ['--literal'],
      flags: {
        only: ['roles', 'users', 'teachers'],
        o: 'admins',
        a: true,
        b: true,
        c: true,
      },
    })
    expect(parseTokens(['--step', '-1'])).toEqual({
      args: [],
      flags: {
        step: '-1',
      },
    })
    expect(parseTokens(['-s', '-1'])).toEqual({
      args: [],
      flags: {
        s: '-1',
      },
    })
    expect(resolveStringFlag({ only: ['roles', 'users'] }, 'only')).toBe('users')
    expect(resolveStringFlag({ o: 'roles' }, 'only', 'o')).toBe('roles')
    expect(resolveStringFlag({ step: 2 }, 'step')).toBeUndefined()
    expect(resolveBooleanFlag({ force: 'true' }, 'force')).toBe(true)
    expect(resolveBooleanFlag({ force: ['false', 'true'] }, 'force')).toBe(true)
    expect(resolveBooleanFlag({ f: 'false' }, 'force', 'f')).toBe(false)
    expect(parseNumberFlag({ step: '3' }, 'step')).toBe(3)
    expect(() => parseNumberFlag({ step: '-1' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    expect(parseNumberFlag({}, 'step')).toBeUndefined()
    expect(() => parseNumberFlag({ step: 'abc' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    expect(() => parseNumberFlag({ step: '1abc' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    expect(() => parseNumberFlag({ step: '9'.repeat(400) }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    expect(splitCsv('roles, users')).toEqual(['roles', 'users'])
    expect(splitCsv(undefined)).toBeUndefined()
    expect(isInteractive(io.io, {})).toBe(false)
    expect(isInteractive(createIo('/tmp/project', { tty: true }).io, {})).toBe(true)
    expect(isInteractive(createIo('/tmp/project', { tty: true }).io, { 'no-interactive': true })).toBe(false)
    expect(findCommand([appDefinition], 'sample')).toBe(appDefinition)
    expect(collectMultiStringFlag({ only: ['users', 'roles'] }, 'only')).toEqual(['users', 'roles'])
    expect(collectMultiStringFlag({ only: 'users' }, 'only')).toEqual(['users'])
    expect(collectMultiStringFlag({ o: 'users' }, 'only', 'o')).toEqual(['users'])
    expect(collectMultiStringFlag({ only: '   ' }, 'only')).toBeUndefined()
    expect(createRuntimeInvocation('/tmp/holo-runtime-worker.mjs')).toEqual({
      command: process.execPath,
      args: ['/tmp/holo-runtime-worker.mjs'],
    })
    expect(createRuntimeInvocation('/tmp/holo-runtime-worker.ts')).toEqual({
      command: process.execPath,
      args: ['--experimental-strip-types', '/tmp/holo-runtime-worker.ts'],
    })
    const largeRuntimeOutputSize = 1024 * 1024 + 1024
    const largeRuntimeOutput = await runRuntimeInvocation('node', [
      '--eval',
      `process.stdout.write('o'.repeat(${largeRuntimeOutputSize})); process.stderr.write('e'.repeat(${largeRuntimeOutputSize}))`,
    ], {
      cwd: process.cwd(),
      env: process.env,
    })
    expect(largeRuntimeOutput.status).toBe(0)
    expect(largeRuntimeOutput.stdout).toHaveLength(largeRuntimeOutputSize)
    expect(largeRuntimeOutput.stderr).toHaveLength(largeRuntimeOutputSize)
    const missingRuntimeOutput = await runRuntimeInvocation('__holo_missing_runtime_command__', [], {
      cwd: process.cwd(),
      env: process.env,
    })
    expect(missingRuntimeOutput.status).not.toBe(0)
    expect(missingRuntimeOutput.error).toBeInstanceOf(Error)
    const builtRuntimeWorker = createRuntimeInvocation(fileURLToPath(new URL('../dist/runtime-worker.mjs', import.meta.url)))
    const oversizedRuntimePayload = await runRuntimeInvocation(builtRuntimeWorker.command, builtRuntimeWorker.args, {
      cwd: process.cwd(),
      env: process.env,
      input: JSON.stringify({ kind: 'probe', runtimeConfig: { db: { default: 'sqlite', connections: {} } }, padding: 'x'.repeat(256 * 1024) }),
    })
    expect(oversizedRuntimePayload.stderr).not.toContain('Runtime payload is missing database configuration.')
    expect(oversizedRuntimePayload.stderr).toContain('Driver "sqlite" is not registered')
    expect(inferRuntimeMigrationName('file:///tmp/2026_01_01_000001_create_sessions_table.js')).toBe('2026_01_01_000001_create_sessions_table')
    expect(() => inferRuntimeMigrationName('file:///tmp/create_sessions_table.js')).toThrow(
      'Registered migration "file:///tmp/create_sessions_table.js" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.',
    )
    expect(normalizeRuntimeMigration(
      'file:///tmp/2026_01_01_000001_create_sessions_table.js',
      { up() {} },
    )).toMatchObject({ name: '2026_01_01_000001_create_sessions_table' })
    expect(normalizeRuntimeMigration(
      'file:///tmp/ignored.js',
      { name: 'custom_name', up() {} },
    )).toMatchObject({ name: 'custom_name' })
    expect(getRuntimeFailureMessage('prune', {
      status: null,
      error: { code: 'ENOENT' },
      stdout: undefined,
      stderr: undefined,
    })).toContain('Failed to launch runtime command "prune"')
    expect(getRuntimeFailureMessage('seed', {
      status: 1,
      stdout: '',
      stderr: 'seed failed\n',
    })).toBe('seed failed')
    expect(getRuntimeFailureMessage('seed', {
      status: 1,
      stdout: 'seed output\n',
      stderr: '',
    })).toBe('seed output')
    expect(getRuntimeFailureMessage('migrate', {
      status: 1,
      stdout: '',
      stderr: [
        'file:///app/.holo-js/runtime/index.mjs:12',
        '    throw new Error(\'Unable to open SQLite database "./missing/database.sqlite": unable to open database file\')',
        '          ^',
        '',
        'Error: Unable to open SQLite database "./missing/database.sqlite": unable to open database file',
        '    at initialize (file:///app/.holo-js/runtime/index.mjs:12:11)',
      ].join('\n'),
    })).toBe('Unable to open SQLite database "./missing/database.sqlite": unable to open database file')
    expect(getRuntimeFailureMessage('seed', {
      status: 1,
      stdout: undefined,
      stderr: undefined,
      error: undefined,
    })).toBe('Runtime command "seed" failed.')

    printCommandList(io.io, [
      { ...appDefinition, source: 'internal', usage: 'holo list' },
      appDefinition,
    ])
    printCommandHelp(io.io, appDefinition)

    const listed = io.read().stdout
    expect(listed).toContain('Internal commands:')
    expect(listed).toContain('App commands:')
    expect(listed).toContain('  example                         Example command.')
  })

  it('covers env, file, and internal command preparation helpers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const notePath = join(projectRoot, 'note.txt')
    await writeTextFile(notePath, 'ready')

    vi.stubEnv('DB_DRIVER', 'postgres')
    vi.stubEnv('DB_SSL', 'true')
    vi.stubEnv('DB_LOGGING', 'false')
    expect(parseBooleanEnv(undefined)).toBeUndefined()
    expect(parseBooleanEnv('true')).toBe(true)
    expect(parseBooleanEnv('false')).toBe(false)
    expect(parseBooleanEnv('wat')).toBeUndefined()
    expect(getRegistryMigrationSlug('2026_01_01_000000_create_users_table')).toBe('create_users_table')
    expect(() => getRegistryMigrationSlug('2026_01_01_000000_!!!')).toThrow()
    expect(hasRegisteredMigrationSlug({
      migrations: [
        { name: '2026_01_01_000000_create_users_table' },
        { name: '2026_01_01_000000_!!!' },
      ],
    } as never, 'create_users_table')).toBe(true)
    expect(hasRegisteredMigrationSlug({
      migrations: [
        { name: '2026_01_01_000000_!!!' },
      ],
    } as never, 'create_users_table')).toBe(false)
    expect(hasRegisteredCreateTableMigration({
      migrations: [
        { name: '2026_01_01_000000_create_users_table' },
        { name: '2026_01_01_000001_add_status_to_users_table' },
        { name: '2026_01_01_000002_create_table' },
        { name: '2026_01_01_000003_!!!' },
      ],
    } as never, 'users')).toBe(true)
    expect(hasRegisteredCreateTableMigration({
      migrations: [
        { name: '2026_01_01_000001_add_status_to_users_table' },
        { name: '2026_01_01_000002_create_table' },
        { name: '2026_01_01_000003_!!!' },
      ],
    } as never, 'users')).toBe(false)
    expect(resolvePackageManagerInstallCommand('pnpm')).toBe('pnpm install')
    expect(resolvePackageManagerDevCommand('pnpm')).toBe('pnpm dev')
    expect(resolvePackageManagerInstallCommand('yarn')).toBe('yarn install')
    expect(resolvePackageManagerDevCommand('yarn')).toBe('yarn dev')
    expect(projectInternals.resolveNamedExport('nope', (_value): _value is { ok: true } => false)).toBeUndefined()
    expect(projectInternals.resolveNamedExportEntry('nope', (_value): _value is { ok: true } => false)).toBeUndefined()
    expect(createEnvRuntimeConfig()).toMatchObject({
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: 'postgres',
            ssl: true,
            logging: false,
          },
        },
      },
    })
    expect(mergeRuntimeDatabaseConfig(undefined, createEnvRuntimeConfig())).toEqual(
      createEnvRuntimeConfig().db,
    )
    expect(mergeRuntimeDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
        },
      },
    }, {
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: undefined,
            url: undefined,
            host: undefined,
            port: undefined,
            username: undefined,
            password: undefined,
            database: undefined,
            schema: undefined,
            ssl: undefined,
            logging: undefined,
          },
        },
      },
    })).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
        },
      },
    })
    expect(mergeRuntimeDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: 'postgresql://manifest',
      },
    }, {
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: 'postgres',
            url: 'postgresql://env',
            host: undefined,
            port: '5432',
            username: 'env-user',
            password: undefined,
            database: undefined,
            schema: undefined,
            ssl: undefined,
            logging: true,
          },
        },
      },
    })).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          url: 'postgresql://env',
          driver: 'postgres',
          host: undefined,
          port: '5432',
          username: 'env-user',
          password: undefined,
          database: undefined,
          schema: undefined,
          ssl: undefined,
          logging: true,
        },
      },
    })
    expect(mergeRuntimeDatabaseConfig({}, {
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: 'sqlite',
            url: './env.sqlite',
            host: undefined,
            port: undefined,
            username: undefined,
            password: undefined,
            database: undefined,
            schema: undefined,
            ssl: undefined,
            logging: true,
          },
        },
      },
    })).toEqual({
      defaultConnection: 'default',
      connections: {
        default: {
          driver: 'sqlite',
          url: './env.sqlite',
          host: undefined,
          port: undefined,
          username: undefined,
          password: undefined,
          database: undefined,
          schema: undefined,
          ssl: undefined,
          logging: true,
        },
      },
    })
    expect(mergeRuntimeDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
        },
      },
    }, {
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: undefined,
            url: undefined,
            host: undefined,
            port: undefined,
            username: undefined,
            password: 'secret',
            database: undefined,
            schema: undefined,
            ssl: undefined,
            logging: undefined,
          },
        },
      },
    })).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
          password: 'secret',
        },
      },
    })
    expect(mergeRuntimeDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
        },
      },
    }, {
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: 'sqlite',
            url: './env.sqlite',
            host: undefined,
            port: undefined,
            username: undefined,
            password: undefined,
            database: undefined,
            schema: undefined,
            ssl: undefined,
            logging: false,
          },
        },
      },
    })).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './env.sqlite',
          host: undefined,
          port: undefined,
          username: undefined,
          password: undefined,
          database: undefined,
          schema: undefined,
          ssl: undefined,
          logging: false,
        },
      },
    })
    expect(resolveConfigModuleUrl()).toContain('/config/dist/index.mjs')
    expect(resolveConfigModuleUrl(specifier => `mock:${specifier}`)).toBe('mock:@holo-js/config')
    expect(resolveConfigModuleUrl(null as never)).toContain('/node_modules/@holo-js/config/dist/index.mjs')
    expect(resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.ts')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    expect(resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.mts')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    expect(resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.js')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    expect(resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.mjs')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    await expect(resolvePackageManagerInstallInvocation(projectRoot)).resolves.toEqual({
      command: 'bun',
      args: ['install'],
    })
    await expect(fileExists(notePath)).resolves.toBe(true)
    await expect(fileExists(join(projectRoot, 'missing.txt'))).resolves.toBe(false)
    await expect(hasProjectDependency(join(projectRoot, 'missing-project'), '@holo-js/queue')).resolves.toBe(false)
    await writeFile(join(projectRoot, 'package.json'), '{ invalid json', 'utf8')
    await expect(hasProjectDependency(projectRoot, '@holo-js/queue')).resolves.toBe(false)
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      dependencies: {
        '@holo-js/queue': outdatedHoloPackageRange,
      },
    }), 'utf8')
    await expect(hasProjectDependency(projectRoot, '@holo-js/queue')).resolves.toBe(true)
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      devDependencies: {
        '@holo-js/queue': outdatedHoloPackageRange,
      },
    }), 'utf8')
    await expect(hasProjectDependency(projectRoot, '@holo-js/queue')).resolves.toBe(true)
    await expect(ensureAbsent(join(projectRoot, 'missing.txt'))).resolves.toBeUndefined()
    await expect(ensureAbsent(notePath)).rejects.toThrow('Refusing to overwrite existing file')

    const migrationsDir = join(projectRoot, 'server/db/migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20000101000000_create_users_table.ts'), '')
    const template = await nextMigrationTemplate('create_users_table', migrationsDir)
    expect(template.fileName).toMatch(/create_users_table/)

    const collisionStart = Date.now()
    const collisions = await Promise.all(Array.from({ length: 30 }, async (_, seconds) => {
      const candidate = generateMigrationTemplate('create_posts_table', { date: new Date(collisionStart + seconds * 1000) })
      await writeFile(join(migrationsDir, candidate.fileName), '')
      return candidate.fileName
    }))
    const collisionTemplate = await nextMigrationTemplate('create_posts_table', migrationsDir)
    expect(collisions).not.toContain(collisionTemplate.fileName)

    const clearIo = createIo(projectRoot)
    await writeProjectFile(projectRoot, '.holo-js/generated/config-cache.json', '{}')
    await runCli(['config:clear'], clearIo.io)
    await expect(fileExists(join(projectRoot, '.holo-js/generated/config-cache.json'))).resolves.toBe(false)
    expect(clearIo.read().stdout).toContain('Config cache cleared:')
    await runCli(['config:clear'], clearIo.io)
    expect(clearIo.read().stdout).toContain('Config cache was already clear:')
  })

  it('runs generator internals in-process', async () => {
    await import('@holo-js/queue/config')
    const modelProjectRoot = await createTempProject()
    tempDirs.push(modelProjectRoot)
    await linkWorkspaceDb(modelProjectRoot)

    const modelIo = createIo(modelProjectRoot)
    await (async () => {
      await runMakeModel(modelIo.io, modelProjectRoot, {
        args: ['courses/Course'],
        flags: {
          migration: true,
          observer: true,
          seeder: true,
          factory: true,
        },
      })
    })()
    expect(modelIo.read().stdout).toContain('Created model: server/models/courses/Course.ts')

    await expect((async () => {
      await runMakeModel(modelIo.io, modelProjectRoot, {
        args: ['courses/Course'],
        flags: {
          migration: true,
          observer: true,
          seeder: true,
          factory: true,
        },
      })
    })()).rejects.toThrow('Model with the same name already exists')

    const plainModelProjectRoot = await createTempProject()
    tempDirs.push(plainModelProjectRoot)
    await linkWorkspaceDb(plainModelProjectRoot)
    const plainModelIo = createIo(plainModelProjectRoot)
    await (async () => {
      await runMakeModel(plainModelIo.io, plainModelProjectRoot, {
        args: ['Lesson'],
        flags: {
          migration: false,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })()
    await expect(readFile(join(plainModelProjectRoot, 'server/models/Lesson.ts'), 'utf8')).resolves.not.toContain('observers:')

    const sharedTableProjectRoot = await createTempProject()
    tempDirs.push(sharedTableProjectRoot)
    await linkWorkspaceDb(sharedTableProjectRoot)
    const sharedTableIo = createIo(sharedTableProjectRoot)
    await (async () => {
      await runMakeModel(sharedTableIo.io, sharedTableProjectRoot, {
        args: ['User'],
        flags: {
          migration: true,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })()
    await expect((async () => {
      await runMakeModel(sharedTableIo.io, sharedTableProjectRoot, {
        args: ['Admin'],
        flags: {
          table: 'users',
          migration: false,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })()).rejects.toThrow('Discovered duplicate model "User"')
    await expect((async () => {
      await runMakeModel(sharedTableIo.io, sharedTableProjectRoot, {
        args: ['Person'],
        flags: {
          table: 'users',
          migration: true,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })()).rejects.toThrow('A migration for table "users" already exists.')

    const duplicateMigrationModelRoot = await createTempProject()
    tempDirs.push(duplicateMigrationModelRoot)
    await linkWorkspaceDb(duplicateMigrationModelRoot)
    await writeProjectFile(
      duplicateMigrationModelRoot,
      'server/db/migrations/2026_01_01_000000_create_lessons_table.ts',
      `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up() {},
  async down() {},
})
`,
    )
    await expect((async () => {
      await runMakeModel(createIo(duplicateMigrationModelRoot).io, duplicateMigrationModelRoot, {
        args: ['Lesson'],
        flags: {
          migration: true,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })()).rejects.toThrow('A migration for table "lessons" already exists.')

    const modelCommandRoot = await createTempProject()
    tempDirs.push(modelCommandRoot)
    await linkWorkspaceDb(modelCommandRoot)
    const modelCommandIo = createIo(modelCommandRoot)
    const modelCommandContext = {
      ...modelCommandIo.io,
      projectRoot: modelCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const modelCommands = createInternalCommands(modelCommandContext)
    const makeModel = modelCommands.find(command => command.name === 'make:model')
    await expect((async () => makeModel?.run({
      projectRoot: modelCommandRoot,
      cwd: modelCommandRoot,
      args: ['Course'],
      flags: {
        table: undefined,
        migration: false,
        observer: false,
        seeder: false,
        factory: false,
      },
      loadProject: modelCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    expect(modelCommandIo.read().stdout).toContain('Created model: server/models/Course.ts')

    const migrationProjectRoot = await createTempProject()
    tempDirs.push(migrationProjectRoot)
    await linkWorkspaceDb(migrationProjectRoot)
    const migrationIo = createIo(migrationProjectRoot)
    await (async () => runMakeMigration(migrationIo.io, migrationProjectRoot, {
      args: ['create_roles_table'],
      flags: {},
    }))()
    expect(migrationIo.read().stdout).toContain('Created migration: server/db/migrations/')

    await expect((async () => runMakeMigration(migrationIo.io, migrationProjectRoot, {
      args: ['create_roles_table'],
      flags: {},
    }))()).rejects.toThrow('A migration named "create_roles_table" already exists')

    const createMigrationProjectRoot = await createTempProject()
    tempDirs.push(createMigrationProjectRoot)
    await linkWorkspaceDb(createMigrationProjectRoot)
    const createMigrationIo = createIo(createMigrationProjectRoot)
    await (async () => runMakeMigration(createMigrationIo.io, createMigrationProjectRoot, {
      args: ['create_audit_logs_table'],
      flags: { create: 'audit_logs' },
    }))()
    expect(createMigrationIo.read().stdout).toContain('Created migration: server/db/migrations/')
    await expect((async () => runMakeMigration(createMigrationIo.io, createMigrationProjectRoot, {
      args: ['create_audit_logs_table'],
      flags: { create: 'audit_logs' },
    }))()).rejects.toThrow('A migration for table "audit_logs" already exists')
    const createMigrationFile = (await readdir(join(createMigrationProjectRoot, 'server/db/migrations')))[0]
    if (!createMigrationFile) {
      throw new Error('Expected generated create migration file.')
    }
    const createMigrationContents = await readFile(join(createMigrationProjectRoot, 'server/db/migrations', createMigrationFile), 'utf8')
    expect(createMigrationContents).toContain('await schema.createTable(\'audit_logs\', (table) => {')

    const createMigrationScanRoot = await createTempProject()
    tempDirs.push(createMigrationScanRoot)
    await linkWorkspaceDb(createMigrationScanRoot)
    await writeProjectFile(
      createMigrationScanRoot,
      'server/db/migrations/2026_01_01_000000_add_status_to_users_table.ts',
      `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up() {},
  async down() {},
})
`,
    )
    await writeProjectFile(
      createMigrationScanRoot,
      'server/db/migrations/2026_01_01_000001_create_table.ts',
      `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up() {},
  async down() {},
})
`,
    )
    const createMigrationScanIo = createIo(createMigrationScanRoot)
    await (async () => runMakeMigration(createMigrationScanIo.io, createMigrationScanRoot, {
      args: ['create_projects_table'],
      flags: { create: 'projects' },
    }))()
    expect(createMigrationScanIo.read().stdout).toContain('Created migration: server/db/migrations/')

    const alterMigrationProjectRoot = await createTempProject()
    tempDirs.push(alterMigrationProjectRoot)
    await linkWorkspaceDb(alterMigrationProjectRoot)
    const alterMigrationIo = createIo(alterMigrationProjectRoot)
    await (async () => runMakeMigration(alterMigrationIo.io, alterMigrationProjectRoot, {
      args: ['add_status_to_users_table'],
      flags: { table: 'users' },
    }))()
    expect(alterMigrationIo.read().stdout).toContain('Created migration: server/db/migrations/')
    await expect((async () => runMakeMigration(alterMigrationIo.io, alterMigrationProjectRoot, {
      args: ['add_status_to_users_table'],
      flags: { table: 'users' },
    }))()).rejects.toThrow('A migration named "add_status_to_users_table" already exists')
    const alterMigrationFile = (await readdir(join(alterMigrationProjectRoot, 'server/db/migrations')))[0]
    if (!alterMigrationFile) {
      throw new Error('Expected generated alter migration file.')
    }
    const alterMigrationContents = await readFile(join(alterMigrationProjectRoot, 'server/db/migrations', alterMigrationFile), 'utf8')
    expect(alterMigrationContents).toContain('await schema.table(\'users\', (table) => {')

    const seederProjectRoot = await createTempProject()
    tempDirs.push(seederProjectRoot)
    await linkWorkspaceDb(seederProjectRoot)
    const seederIo = createIo(seederProjectRoot)
    await (async () => runMakeSeeder(seederIo.io, seederProjectRoot, {
      args: ['RoleSeeder'],
      flags: {},
    }))()
    expect(seederIo.read().stdout).toContain('Created seeder: server/db/seeders/RoleSeeder.ts')

    const markdownMailProjectRoot = await createTempProject()
    tempDirs.push(markdownMailProjectRoot)
    const markdownMailIo = createIo(markdownMailProjectRoot)
    await (async () => runMakeMail(markdownMailIo.io, markdownMailProjectRoot, {
      args: ['auth/verify-email'],
      flags: { type: 'markdown' },
    }))()
    expect(markdownMailIo.read().stdout).toContain('Created mail: server/mail/auth/verify-email.ts')
    await expect(readFile(join(markdownMailProjectRoot, 'server/mail/auth/verify-email.ts'), 'utf8')).resolves.toContain('defineMail')
    await expect((async () => runMakeMail(markdownMailIo.io, markdownMailProjectRoot, {
      args: ['auth/verify-email'],
      flags: { type: 'markdown' },
    }))()).rejects.toThrow('Refusing to overwrite existing file')

    const viewMailProjectRoot = await createTempProject()
    tempDirs.push(viewMailProjectRoot)
    const viewMailIo = createIo(viewMailProjectRoot)
    await expect((async () => runMakeMail(viewMailIo.io, viewMailProjectRoot, {
      args: ['billing/invoice-paid'],
      flags: { type: 'view' },
    }))()).rejects.toThrow('View-backed mail scaffolding requires a renderView runtime binding')
    await expect(stat(join(viewMailProjectRoot, 'server/mail/billing/invoice-paid.ts'))).rejects.toThrow()
    await expect(stat(join(viewMailProjectRoot, 'server/mail/billing/invoice-paid.view.ts'))).rejects.toThrow()
    expect(renderNuxtMailViewTemplate('ExampleMailInput', './example')).toContain('defineProps<ExampleMailInput>()')
    expect(renderSvelteMailViewTemplate('ExampleMailInput', './example')).toContain('export let to: ExampleMailInput[\'to\']')
    expect(renderGenericMailViewTemplate('ExampleMail', 'ExampleMailInput', './example')).toContain('ExampleMailInput')

    const jobProjectRoot = await createTempProject()
    tempDirs.push(jobProjectRoot)
    const jobIo = createIo(jobProjectRoot)
    await (async () => runMakeJob(jobIo.io, jobProjectRoot, {
      args: ['media/GenerateConversions'],
      flags: {},
    }))()
    expect(jobIo.read().stdout).toContain('Created job: server/jobs/media/generate-conversions.ts')
    await expect(readFile(join(jobProjectRoot, 'server/jobs/media/generate-conversions.ts'), 'utf8')).resolves.toContain('defineJob')
    await expect((async () => runMakeJob(jobIo.io, jobProjectRoot, {
      args: ['media/generate-conversions'],
      flags: {},
    }))()).rejects.toThrow('Job with the same name already exists: media.generate-conversions.')
    await (async () => runMakeJob(jobIo.io, jobProjectRoot, {
      args: ['SendDigest'],
      flags: {},
    }))()
    expect(jobIo.read().stdout).toContain('Created job: server/jobs/send-digest.ts')
    await expect((async () => runMakeJob(jobIo.io, jobProjectRoot, {
      args: [],
      flags: {},
    }))()).rejects.toThrow('A name is required.')

    const eventProjectRoot = await createTempProject()
    tempDirs.push(eventProjectRoot)
    const eventIo = createIo(eventProjectRoot)
    await (async () => runMakeEvent(eventIo.io, eventProjectRoot, {
      args: ['user/registered'],
      flags: {},
    }))()
    expect(eventIo.read().stdout).toContain('Created event: server/events/user/registered.ts')
    await expect(readFile(join(eventProjectRoot, 'server/events/user/registered.ts'), 'utf8')).resolves.toContain('defineEvent')
    await expect((async () => runMakeEvent(eventIo.io, eventProjectRoot, {
      args: ['user/registered'],
      flags: {},
    }))()).rejects.toThrow('Event with the same name already exists: user.registered.')
    await expect((async () => runMakeEvent(eventIo.io, eventProjectRoot, {
      args: [],
      flags: {},
    }))()).rejects.toThrow('A name is required.')
    await (async () => runMakeEvent(eventIo.io, eventProjectRoot, {
      args: ['OrderPlaced'],
      flags: {},
    }))()
    expect(eventIo.read().stdout).toContain('Created event: server/events/order-placed.ts')

    const broadcastProjectRoot = await createTempProject()
    tempDirs.push(broadcastProjectRoot)
    await linkWorkspaceBroadcast(broadcastProjectRoot)
    const broadcastIo = createIo(broadcastProjectRoot)
    await (async () => runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: ['orders/shipment-updated'],
      flags: {},
    }))()
    expect(broadcastIo.read().stdout).toContain('Created broadcast: server/broadcast/orders/shipment-updated.ts')
    await expect(readFile(join(broadcastProjectRoot, 'server/broadcast/orders/shipment-updated.ts'), 'utf8')).resolves.toContain('defineBroadcast')
    await expect((async () => runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: ['orders/shipment-updated'],
      flags: {},
    }))()).rejects.toThrow('Broadcast with the same name already exists: orders.shipment-updated.')
    await (async () => runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: ['ShipmentUpdated'],
      flags: {},
    }))()
    expect(broadcastIo.read().stdout).toContain('Created broadcast: server/broadcast/shipment-updated.ts')
    await expect((async () => runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: [],
      flags: {},
    }))()).rejects.toThrow('A name is required.')

    const channelProjectRoot = await createTempProject()
    tempDirs.push(channelProjectRoot)
    await linkWorkspaceBroadcast(channelProjectRoot)
    const channelIo = createIo(channelProjectRoot)
    await (async () => runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.{orderId}'],
      flags: {},
    }))()
    expect(channelIo.read().stdout).toContain('Created channel: server/channels/orders-order-id.ts')
    await expect(readFile(join(channelProjectRoot, 'server/channels/orders-order-id.ts'), 'utf8')).resolves.toContain('defineChannel')
    await (async () => runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.{id}'],
      flags: {},
    }))()
    await (async () => runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.id'],
      flags: {},
    }))()
    const generatedChannelFiles = await readdir(join(channelProjectRoot, 'server/channels'))
    expect(generatedChannelFiles).toHaveLength(3)
    await expect(Promise.all(generatedChannelFiles.map(async (fileName) => {
      return await readFile(join(channelProjectRoot, 'server/channels', fileName), 'utf8')
    }))).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining("defineChannel('orders.{orderId}'"),
      expect.stringContaining("defineChannel('orders.{id}'"),
      expect.stringContaining("defineChannel('orders.id'"),
    ]))
    await expect((async () => runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.{orderId}'],
      flags: {},
    }))()).rejects.toThrow('Channel with the same pattern already exists: orders.{orderId}.')
    await expect((async () => runMakeChannel(channelIo.io, channelProjectRoot, {
      args: [],
      flags: {},
    }))()).rejects.toThrow('A channel pattern is required.')
    expect(generatorInternals.toChannelTemplateFileStem('{}')).toBe('channel')
    expect(generatorInternals.toChannelTemplateFileStem('{orderId}')).not.toBe(generatorInternals.toChannelTemplateFileStem('{order-id}'))
    await expect((async () => runMakeChannel(channelIo.io, channelProjectRoot, {
      args: [''],
      flags: {},
    }))()).rejects.toThrow('A channel pattern is required.')

    const listenerProjectRoot = await createTempProject()
    tempDirs.push(listenerProjectRoot)
    await linkWorkspaceDb(listenerProjectRoot)
    const listenerIo = createIo(listenerProjectRoot)
    await writeProjectFile(listenerProjectRoot, 'server/events/user/registered.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await (async () => prepareProjectDiscovery(listenerProjectRoot))()
    await writeProjectFile(listenerProjectRoot, 'server/events/audit/activity.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'audit.activity' })
`)
    await (async () => prepareProjectDiscovery(listenerProjectRoot))()
    await (async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/send-welcome-email'],
      flags: { event: 'user.registered' },
    }))()
    expect(listenerIo.read().stdout).toContain('Created listener: server/listeners/user/send-welcome-email.ts')
    await expect(readFile(join(listenerProjectRoot, 'server/listeners/user/send-welcome-email.ts'), 'utf8')).resolves.toContain('defineListener')
    await expect((async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/send-welcome-email'],
      flags: { event: 'user.registered' },
    }))()).rejects.toThrow('Listener with the same id already exists: user.send-welcome-email.')
    await expect((async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/other'],
      flags: { event: 'missing.event' },
    }))()).rejects.toThrow('Unknown event: missing.event.')
    await expect((async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: [],
      flags: { event: 'user.registered' },
    }))()).rejects.toThrow('A name is required.')
    await expect((async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: [],
      flags: {},
    }))()).rejects.toThrow('A name is required.')
    await (async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/audit-user-events'],
      flags: { event: ['user.registered', 'audit.activity'] },
    }))()
    await expect(readFile(join(listenerProjectRoot, 'server/listeners/user/audit-user-events.ts'), 'utf8')).resolves.toContain(
      'listensTo: [RegisteredEvent1, ActivityEvent2]',
    )
    await writeProjectFile(listenerProjectRoot, 'server/events/audit/activity-named.ts', `
import { defineEvent } from '@holo-js/events'
export const ActivityRecorded = defineEvent({ name: 'audit.activity.named' })
`)
    await (async () => prepareProjectDiscovery(listenerProjectRoot))()
    await (async () => runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/audit-named-event'],
      flags: { event: 'audit.activity.named' },
    }))()
    await expect(readFile(join(listenerProjectRoot, 'server/listeners/user/audit-named-event.ts'), 'utf8')).resolves.toContain(
      'import { ActivityRecorded as ActivityNamedEvent1 } from \'../../events/audit/activity-named\'',
    )
    await expect(readFile(join(listenerProjectRoot, 'server/listeners/user/audit-named-event.ts'), 'utf8')).resolves.toContain(
      'listensTo: [ActivityNamedEvent1]',
    )

    const listenerFallbackProjectRoot = await createTempProject()
    tempDirs.push(listenerFallbackProjectRoot)
    await linkWorkspaceDb(listenerFallbackProjectRoot)
    const listenerFallbackIo = createIo(listenerFallbackProjectRoot)
    await writeProjectFile(listenerFallbackProjectRoot, 'server/events/user/registered.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await (async () => runMakeListener(listenerFallbackIo.io, listenerFallbackProjectRoot, {
      args: ['SendInline'],
      flags: { event: 'user.registered' },
    }))()
    expect(listenerFallbackIo.read().stdout).toContain('Created listener: server/listeners/send-inline.ts')

    const observerProjectRoot = await createTempProject()
    tempDirs.push(observerProjectRoot)
    await linkWorkspaceDb(observerProjectRoot)
    const observerIo = createIo(observerProjectRoot)
    await (async () => runMakeObserver(observerIo.io, observerProjectRoot, {
      args: ['RoleObserver'],
      flags: {},
    }))()
    expect(observerIo.read().stdout).toContain('Created observer: server/db/observers/RoleObserver.ts')

    const factoryProjectRoot = await createTempProject()
    tempDirs.push(factoryProjectRoot)
    await linkWorkspaceDb(factoryProjectRoot)
    const factoryIo = createIo(factoryProjectRoot)
    await (async () => runMakeFactory(factoryIo.io, factoryProjectRoot, {
      args: ['RoleFactory'],
      flags: {},
    }))()
    expect(factoryIo.read().stdout).toContain('Created factory: server/db/factories/RoleFactory.ts')

    const migrationCommandRoot = await createTempProject()
    tempDirs.push(migrationCommandRoot)
    await linkWorkspaceDb(migrationCommandRoot)
    const migrationCommandIo = createIo(migrationCommandRoot)
    const migrationCommandContext = {
      ...migrationCommandIo.io,
      projectRoot: migrationCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const migrationCommands = createInternalCommands(migrationCommandContext)
    const makeMigration = migrationCommands.find(command => command.name === 'make:migration')
    const preparedMigration = await makeMigration?.prepare?.({ args: ['create_lessons_table'], flags: {} }, migrationCommandContext as never)
    const preparedCreateMigration = await makeMigration?.prepare?.({ args: ['create_audits_table'], flags: { create: 'audits' } }, migrationCommandContext as never)
    const preparedAlterMigration = await makeMigration?.prepare?.({ args: ['add_status_to_lessons_table'], flags: { table: 'lessons' } }, migrationCommandContext as never)
    await expect((async () => makeMigration?.run({
      projectRoot: migrationCommandRoot,
      cwd: migrationCommandRoot,
      args: preparedMigration?.args ?? [],
      flags: preparedMigration?.flags ?? {},
      loadProject: migrationCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    expect(preparedCreateMigration?.flags).toMatchObject({ create: 'audits' })
    expect(preparedAlterMigration?.flags).toMatchObject({ table: 'lessons' })
    await expect(makeMigration?.prepare?.({
      args: ['bad'],
      flags: { create: 'users', table: 'users' },
    }, migrationCommandContext as never)).rejects.toThrow('Use either "--create" or "--table", not both.')
    await expect((async () => runMakeMigration(migrationCommandIo.io, migrationCommandRoot, {
      args: ['bad'],
      flags: { create: 'users', table: 'users' },
    }))()).rejects.toThrow('Use either "--create" or "--table", not both.')

    const seederCommandRoot = await createTempProject()
    tempDirs.push(seederCommandRoot)
    await linkWorkspaceDb(seederCommandRoot)
    const seederCommandIo = createIo(seederCommandRoot)
    const seederCommandContext = {
      ...seederCommandIo.io,
      projectRoot: seederCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const seederCommands = createInternalCommands(seederCommandContext)
    const makeSeeder = seederCommands.find(command => command.name === 'make:seeder')
    const preparedSeeder = await makeSeeder?.prepare?.({ args: ['LessonSeeder'], flags: {} }, seederCommandContext as never)
    await expect((async () => makeSeeder?.run({
      projectRoot: seederCommandRoot,
      cwd: seederCommandRoot,
      args: preparedSeeder?.args ?? [],
      flags: preparedSeeder?.flags ?? {},
      loadProject: seederCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()

    const jobCommandRoot = await createTempProject()
    tempDirs.push(jobCommandRoot)
    await linkWorkspaceBroadcast(jobCommandRoot)
    const jobCommandIo = createIo(jobCommandRoot)
    const jobCommandContext = {
      ...jobCommandIo.io,
      projectRoot: jobCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const jobCommands = createInternalCommands(jobCommandContext)
    const makeBroadcast = jobCommands.find(command => command.name === 'make:broadcast')
    const makeChannel = jobCommands.find(command => command.name === 'make:channel')
    const makeEvent = jobCommands.find(command => command.name === 'make:event')
    const makeJob = jobCommands.find(command => command.name === 'make:job')
    const makeListener = jobCommands.find(command => command.name === 'make:listener')
    const makeMail = jobCommands.find(command => command.name === 'make:mail')
    const preparedBroadcast = await makeBroadcast?.prepare?.({ args: ['orders/status-updated'], flags: {} }, jobCommandContext as never)
    const preparedChannel = await makeChannel?.prepare?.({ args: ['orders.{orderId}'], flags: {} }, jobCommandContext as never)
    const preparedEvent = await makeEvent?.prepare?.({ args: ['user/registered'], flags: {} }, jobCommandContext as never)
    const preparedJob = await makeJob?.prepare?.({ args: ['SendEmail'], flags: {} }, jobCommandContext as never)
    const preparedMarkdownMail = await makeMail?.prepare?.({ args: ['billing/receipt'], flags: { markdown: true } }, jobCommandContext as never)
    const preparedDefaultMail = await makeMail?.prepare?.({ args: ['welcome'], flags: {} }, jobCommandContext as never)
    const promptedMailIo = createIo(jobCommandRoot, {
      tty: true,
      input: '\n',
    })
    const promptedMailContext = {
      ...promptedMailIo.io,
      projectRoot: jobCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const promptedMakeMail = createInternalCommands(
      promptedMailContext,
    ).find(command => command.name === 'make:mail')
    const preparedPromptedMail = await promptedMakeMail?.prepare?.({ args: ['prompted-mail'], flags: {} }, promptedMailContext as never)
    const preparedListener = await makeListener?.prepare?.({
      args: ['SendWelcomeEmail'],
      flags: { event: ['user.registered', 'audit.activity'] },
    }, jobCommandContext as never)
    await expect((async () => makeEvent?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedEvent?.args ?? [],
      flags: preparedEvent?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    await expect((async () => makeJob?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedJob?.args ?? [],
      flags: preparedJob?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    await expect((async () => makeBroadcast?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedBroadcast?.args ?? [],
      flags: preparedBroadcast?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    await expect((async () => makeChannel?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedChannel?.args ?? [],
      flags: preparedChannel?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    await expect(preparedDefaultMail).toEqual({
      args: ['welcome'],
      flags: { type: 'markdown' },
    })
    await expect(preparedMarkdownMail).toEqual({
      args: ['billing/receipt'],
      flags: { type: 'markdown' },
    })
    await expect(preparedPromptedMail).toEqual({
      args: ['prompted-mail'],
      flags: { type: 'markdown' },
    })
    await expect(makeMail?.prepare?.({
      args: ['billing/invoice-paid'],
      flags: { view: true },
    }, jobCommandContext as never)).rejects.toThrow('View-backed mail scaffolding requires a renderView runtime binding')
    await expect((async () => makeMail?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedDefaultMail?.args ?? [],
      flags: preparedDefaultMail?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()
    const interactiveMailIo = createIo(jobCommandRoot, {
      tty: true,
      input: 'view\n',
    })
    const interactiveMailContext = {
      ...interactiveMailIo.io,
      projectRoot: jobCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    await expect(makeMail?.prepare?.({
      args: ['billing/interactive'],
      flags: {},
    }, interactiveMailContext as never)).resolves.toMatchObject({
      flags: {
        type: 'markdown',
      },
    })
    await expect(makeListener?.prepare?.({ args: ['SendWelcomeEmail'], flags: {} }, jobCommandContext as never)).rejects.toThrow(
      'Listener event name is required. Use "--event <event-name>".',
    )
    await expect(makeBroadcast?.prepare?.({
      args: [],
      flags: {},
    }, jobCommandContext as never)).rejects.toThrow('Missing required argument: Broadcast name.')
    await expect(makeChannel?.prepare?.({
      args: [],
      flags: {},
    }, jobCommandContext as never)).rejects.toThrow('Missing required argument: Channel pattern.')
    await expect(makeMail?.prepare?.({
      args: ['bad'],
      flags: { markdown: true, view: true },
    }, jobCommandContext as never)).rejects.toThrow('Use either "--markdown" or "--view", not both.')
    await expect((async () => runMakeListener(jobCommandIo.io, jobCommandRoot, {
      args: ['SendWelcomeEmail'],
      flags: { event: 'missing.event' },
    }))()).rejects.toThrow('Unknown event: missing.event.')
    await expect((async () => runMakeJob(jobCommandIo.io, jobCommandRoot, {
      args: [],
      flags: {},
    }))()).rejects.toThrow('A name is required.')
    await expect((async () => runMakeMail(jobCommandIo.io, jobCommandRoot, {
      args: [],
      flags: { type: 'markdown' },
    }))()).rejects.toThrow('A name is required.')
    await writeProjectFile(jobCommandRoot, 'server/events/audit/activity.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'audit.activity' })
`)
    await (async () => prepareProjectDiscovery(jobCommandRoot))()
    await expect((async () => makeListener?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedListener?.args ?? [],
      flags: preparedListener?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()

    const observerCommandRoot = await createTempProject()
    tempDirs.push(observerCommandRoot)
    await linkWorkspaceDb(observerCommandRoot)
    const observerCommandIo = createIo(observerCommandRoot)
    const observerCommandContext = {
      ...observerCommandIo.io,
      projectRoot: observerCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const observerCommands = createInternalCommands(observerCommandContext)
    const makeObserver = observerCommands.find(command => command.name === 'make:observer')
    const preparedObserver = await makeObserver?.prepare?.({ args: ['CourseObserver'], flags: {} }, observerCommandContext as never)
    await expect((async () => makeObserver?.run({
      projectRoot: observerCommandRoot,
      cwd: observerCommandRoot,
      args: preparedObserver?.args ?? [],
      flags: preparedObserver?.flags ?? {},
      loadProject: observerCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()

    const factoryCommandRoot = await createTempProject()
    tempDirs.push(factoryCommandRoot)
    await linkWorkspaceDb(factoryCommandRoot)
    const factoryCommandIo = createIo(factoryCommandRoot)
    const factoryCommandContext = {
      ...factoryCommandIo.io,
      projectRoot: factoryCommandRoot,
      registry: [] as Array<ReturnType<typeof createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const factoryCommands = createInternalCommands(factoryCommandContext)
    const makeFactory = factoryCommands.find(command => command.name === 'make:factory')
    const preparedFactory = await makeFactory?.prepare?.({ args: ['CourseFactory'], flags: {} }, factoryCommandContext as never)
    await expect((async () => makeFactory?.run({
      projectRoot: factoryCommandRoot,
      cwd: factoryCommandRoot,
      args: preparedFactory?.args ?? [],
      flags: preparedFactory?.flags ?? {},
      loadProject: factoryCommandContext.loadProject,
    } as never))()).resolves.toBeUndefined()

    expect(migrationCommandIo.read().stdout).toContain('Created migration: server/db/migrations/')
    expect(seederCommandIo.read().stdout).toContain('Created seeder: server/db/seeders/LessonSeeder.ts')
    expect(jobCommandIo.read().stdout).toContain('Created mail: server/mail/welcome.ts')
    expect(observerCommandIo.read().stdout).toContain('Created observer: server/db/observers/CourseObserver.ts')
    expect(factoryCommandIo.read().stdout).toContain('Created factory: server/db/factories/CourseFactory.ts')
  }, 90000)






  it('publishes editable auth notification files without overwriting existing files', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'auth-notification-fixture',
      private: true,
      dependencies: {
        '@holo-js/auth': expectedHoloPackageRange,
        '@holo-js/notifications': expectedHoloPackageRange,
      },
    }, null, 2))

    const first = await projectInternals.publishAuthNotificationsIntoProject(projectRoot)
    const emailVerificationPath = join(projectRoot, 'server/notifications/auth/email-verification.ts')
    const passwordResetPath = join(projectRoot, 'server/notifications/auth/password-reset.ts')
    expect(first.createdFiles).toEqual([
      emailVerificationPath,
      passwordResetPath,
    ])
    expect(first.skippedFiles).toEqual([])
    expect(first.hasMailDependency).toBe(false)
    await expect(readFile(emailVerificationPath, 'utf8'))
      .resolves.toContain('interface EmailVerificationNotification')
    await expect(readFile(passwordResetPath, 'utf8'))
      .resolves.toContain('interface PasswordResetNotification')
    await expect(readFile(emailVerificationPath, 'utf8'))
      .resolves.toContain('auth.email-verification')
    await expect(readFile(passwordResetPath, 'utf8'))
      .resolves.toContain('auth.password-reset')

    const second = await projectInternals.publishAuthNotificationsIntoProject(projectRoot)
    expect(second.createdFiles).toEqual([])
    expect(second.skippedFiles).toEqual([
      emailVerificationPath,
      passwordResetPath,
    ])
  }, 30000)




  it('covers command and template helper utilities', () => {
    const command = defineCommand({
      description: 'Example command.',
      async run() {},
    })

    expect(Object.isFrozen(command)).toBe(true)
    expect(splitRequestedName('courses/Course')).toEqual({
      directory: 'courses',
      rawBaseName: 'Course',
    })
    expect(() => splitRequestedName('')).toThrow('A name is required.')
    expect(() => splitRequestedName('../Course')).toThrow('Names must stay within the project root.')
    expect(() => splitRequestedName('courses/../../Course')).toThrow('Names must stay within the project root.')
    expect(toPascalCase('course-item')).toBe('CourseItem')
    expect(toSnakeCase('CourseItem')).toBe('course_item')
    expect(renderBroadcastTemplate('orders.shipment-updated')).toContain("channel('orders.shipment-updated')")
    expect(renderBroadcastTemplate('orders.shipment-updated')).not.toContain('public.feed')
    expect(renderChannelTemplate('orders.{orderId}')).toContain('return false')
    expect(pluralize('category')).toBe('categories')
    expect(pluralize('class')).toBe('classes')
    expect(pluralize('course')).toBe('courses')
    expect(pluralize('person')).toBe('people')
    expect(pluralize('child')).toBe('children')
    expect(ensureSuffix('Course', 'Seeder')).toBe('CourseSeeder')
    expect(relativeImportPath('/tmp/app/server/models/Course.ts', '/tmp/app/server/models/Session.ts')).toBe('./Session')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).not.toContain('observers:')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).toContain('import { defineModel } from \'@holo-js/db\'')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).toContain('export default defineModel("courses", {')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).toContain('fillable: []')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).not.toContain('holoModelPendingSchema')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).not.toContain('holoGeneratedTables')
    expect(renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: '../../.holo-js/generated/schema.generated',
    })).not.toContain('table => table')
    expect(renderViewMailTemplate('WelcomeMail', 'WelcomeMailInput', 'mail.welcome')).toContain('view: \'mail.welcome\'')
    expect(renderViewMailTemplate('WelcomeMail', 'WelcomeMailInput', 'mail.welcome')).toContain('props: input')
    expect(renderNextMailViewTemplate('WelcomeMail', 'WelcomeMailInput', './welcome')).toContain('import type { WelcomeMailInput } from \'./welcome\'')
    expect(renderNextMailViewTemplate('WelcomeMail', 'WelcomeMailInput', './welcome')).toContain('<p>This message is addressed to {input.to}.</p>')
    expect(resolveNameInfo('courses/CourseObserver', { suffix: 'Observer' })).toMatchObject({
      directory: 'courses',
      baseName: 'CourseObserver',
      baseStem: 'Course',
      snakeStem: 'course',
      tableName: 'courses',
    })
    expect(resolveNameInfo('Person')).toMatchObject({
      baseName: 'Person',
      snakeStem: 'person',
      tableName: 'people',
    })
    expect(resolveNameInfo('Child')).toMatchObject({
      baseName: 'Child',
      snakeStem: 'child',
      tableName: 'children',
    })
    expect(`create_${resolveNameInfo('Person').tableName}_table`).toBe('create_people_table')
    expect(`create_${resolveNameInfo('Child').tableName}_table`).toBe('create_children_table')
  })

  it('covers project registration helpers', () => {
    const base = defaultProjectConfig()
    expect(base.paths.generatedSchema).toBe('.holo-js/generated/schema.generated.ts')
    expect(base.paths.models).toBe('server/models')
    expect(base.paths.commands).toBe('server/commands')
    expect(base.paths.jobs).toBe('server/jobs')

    const registered = upsertProjectRegistration(base, 'models', 'server/models/User.ts')
    const duplicate = upsertProjectRegistration(registered, 'models', 'server/models/User.ts')
    const withDatabase = upsertProjectRegistration({
      ...base,
      database: {
        connections: {
          default: {
            driver: 'sqlite',
            url: './data.sqlite',
          },
        },
      },
    }, 'seeders', 'server/db/seeders/UserSeeder.ts')

    expect(registered.models).toEqual(['server/models/User.ts'])
    expect(duplicate.models).toEqual(['server/models/User.ts'])
    expect(withDatabase.database).toBeDefined()
  })

  it('covers package manager resolution, prepare/build lifecycle helpers, and generated registries', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'pnpm@9.0.0',
    }, null, 2))
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)
    await writeProjectFile(projectRoot, 'server/jobs/send-email.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/jobs/reports/daily.ts', `
import { defineJob } from '@holo-js/queue'

export const dailyJob = defineJob({
  async handle() {},
})

export const helperJob = defineJob({
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'config/services.ts', `
import { defineConfig } from '@holo-js/config'

export default defineConfig({
  mailgun: {
    secret: 'secret',
  },
})
`)

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()
    const registry = await (async () => loadGeneratedProjectRegistry(projectRoot))()
    expect(registry?.commands).toMatchObject([{ name: 'hello' }])
    await expect(readFile(join(projectRoot, '.holo-js/generated/.gitignore'), 'utf8')).resolves.toContain('!.gitignore')
    await expect(readTextFile(join(projectRoot, '.holo-js/generated', 'config-cache.json'))).resolves.toBeUndefined()
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'config.d.ts'), 'utf8')).resolves.toContain('interface HoloConfigRegistry')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'config.d.ts'), 'utf8')).resolves.toContain('"services": typeof')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.toContain('interface HoloQueueJobRegistry')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.toContain('import type * as holoQueueJobModule0 from')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.toContain('ExportedQueueJobDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.toContain('QueueJobDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.toContain('"reports.daily": ExportedQueueJobDefinition<typeof holoQueueJobModule0["dailyJob"]>')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.toContain('"send-email": QueueJobDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated', 'queue.d.ts'), 'utf8')).resolves.not.toContain('server/jobs/send-email')

    const pnpmResolution = await resolvePackageManagerCommand(projectRoot, 'build')
    expect(pnpmResolution).toEqual({ command: 'pnpm', args: ['run', 'build'] })

    const yarnRoot = await createTempDirectory()
    tempDirs.push(yarnRoot)
    await writeProjectFile(yarnRoot, 'package.json', JSON.stringify({ name: 'fixture', private: true }, null, 2))
    await writeProjectFile(yarnRoot, 'yarn.lock', '')
    await expect(resolvePackageManagerCommand(yarnRoot, 'dev')).resolves.toEqual({
      command: 'yarn',
      args: ['run', 'dev'],
    })

    const npmRoot = await createTempDirectory()
    tempDirs.push(npmRoot)
    await writeProjectFile(npmRoot, 'package.json', '{ invalid json')
    await writeProjectFile(npmRoot, 'package-lock.json', '')
    await expect(resolvePackageManagerCommand(npmRoot, 'dev')).resolves.toEqual({
      command: 'npm',
      args: ['run', 'dev'],
    })

    const defaultRoot = await createTempDirectory()
    tempDirs.push(defaultRoot)
    await expect(resolvePackageManagerCommand(defaultRoot, 'dev')).resolves.toEqual({
      command: 'bun',
      args: ['run', 'dev'],
    })

    const bunLockRoot = await createTempDirectory()
    tempDirs.push(bunLockRoot)
    await writeProjectFile(bunLockRoot, 'bun.lock', '')
    await expect(resolvePackageManagerCommand(bunLockRoot, 'dev')).resolves.toEqual({
      command: 'bun',
      args: ['run', 'dev'],
    })

    const pnpmLockRoot = await createTempDirectory()
    tempDirs.push(pnpmLockRoot)
    await writeProjectFile(pnpmLockRoot, 'pnpm-lock.yaml', '')
    await expect(resolvePackageManagerCommand(pnpmLockRoot, 'dev')).resolves.toEqual({
      command: 'pnpm',
      args: ['run', 'dev'],
    })

  })

  it.each(['next', 'sveltekit'] as const)('prepares managed realtime artifacts when scaffolding %s before dependencies are installed', async (framework) => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await projectInternals.scaffoldProject(projectRoot, {
      projectName: 'Realtime App',
      framework,
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['realtime'],
    })
    expect(JSON.parse(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8'))).toEqual({ framework })
    expect((await stat(join(projectRoot, '.holo-js/framework/run.mjs'))).isFile()).toBe(true)
    const realtimePath = framework === 'next'
      ? '.holo-js/generated/next/realtime-query-route.ts'
      : '.holo-js/generated/hooks.server.ts'
    expect(await readFile(join(projectRoot, realtimePath), 'utf8')).toContain('handleRealtimeQueryRequest')
  }, 60_000)

  it.each(['prepare', 'schema', 'discovery'] as const)('regenerates framework artifacts on first %s preparation', async (entry) => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/core': '^0.2.2',
        '@holo-js/db': '^0.2.2',
        next: '^16.0.0',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({})
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({})
`)

    await writeProjectFile(projectRoot, 'app/storage/[[...path]]/route.ts', `export { GET, HEAD } from '../../../.holo-js/generated/next/storage-route'\n`)

    if (entry === 'prepare') await runProjectPrepare(projectRoot, undefined, { syncFramework: false })
    else if (entry === 'schema') await prepareProjectSchema(projectRoot)
    else await prepareProjectDiscovery(projectRoot, (await loadProjectConfig(projectRoot)).config)

    expect((await stat(join(projectRoot, '.holo-js/generated/next/storage-route.ts'))).isFile()).toBe(true)
    expect(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8')).toContain('"framework": "next"')
    expect(await readFile(join(projectRoot, '.holo-js/framework/run.mjs'), 'utf8')).toContain('const commandName = "next"')
  }, 60_000)

  it('refreshes installed Next realtime routes through discovery without rewriting unchanged artifacts', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'realtime-preparation-fixture',
      private: true,
      dependencies: { next: '^16.0.0' },
    }))
    await writeProjectFile(projectRoot, 'server/realtime/posts.ts', 'export const posts = {}\n')
    const installed = await installRealtimeIntoProject(projectRoot)
    expect(installed.createdFrameworkSetup).toBe(true)
    const definitionsPath = join(projectRoot, '.holo-js/generated/next/realtime-definitions.ts')
    expect(await readFile(definitionsPath, 'utf8')).toContain('server/realtime/posts')
    await rm(join(projectRoot, 'server/realtime/posts.ts'))
    await writeProjectFile(projectRoot, 'server/realtime/messages.ts', 'export const messages = {}\n')
    const config = (await loadProjectConfig(projectRoot)).config
    await prepareProjectDiscovery(projectRoot, config)
    const refreshed = await readFile(definitionsPath, 'utf8')
    expect(refreshed).toContain('server/realtime/messages')
    expect(refreshed).not.toContain('server/realtime/posts')
    const definitionStat = await stat(definitionsPath)
    const runnerPath = join(projectRoot, '.holo-js/framework/run.mjs')
    const runnerStat = await stat(runnerPath)
    await prepareProjectDiscovery(projectRoot, config)
    expect((await stat(definitionsPath)).mtimeMs).toBe(definitionStat.mtimeMs)
    expect((await stat(runnerPath)).mtimeMs).toBe(runnerStat.mtimeMs)
    await rm(join(projectRoot, '.holo-js/generated/next/realtime-mutation-route.ts'))
    expect((await installRealtimeIntoProject(projectRoot)).createdFrameworkSetup).toBe(true)
    expect((await installRealtimeIntoProject(projectRoot)).createdFrameworkSetup).toBe(false)
  }, 60_000)

  it('refreshes framework selection when dependencies replace a saved framework', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'next' }))
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'framework-replacement-fixture',
      private: true,
      dependencies: { '@sveltejs/kit': '^2.0.0' },
    }))
    await runProjectPrepare(projectRoot, undefined, { syncFramework: false })
    expect(JSON.parse(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8'))).toEqual({ framework: 'sveltekit' })
    expect(await readFile(join(projectRoot, '.holo-js/framework/run.mjs'), 'utf8')).toContain('const commandName = "vite"')
    expect(await readFile(join(projectRoot, '.holo-js/generated/hooks.server.ts'), 'utf8')).toContain('createSvelteKitHoloHooks')
  }, 60_000)

  it('falls back to package dependencies when framework metadata is stale during prepare', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/core': '^0.2.2',
        '@holo-js/db': '^0.2.2',
        next: '^16.0.0',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({})
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({})
`)
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({
      framework: 'removed-framework',
    }, null, 2))
    await writeProjectFile(projectRoot, '.holo-js/framework/run.mjs', 'export const stale = true\n')

    await runProjectPrepare(projectRoot, undefined, { syncFramework: false })

    expect(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8')).toContain('"framework": "next"')
    expect(await readFile(join(projectRoot, '.holo-js/framework/run.mjs'), 'utf8')).toContain('const commandName = "next"')
  }, 60_000)

  it.each(['unchanged', 'preparer-changes-discovery', 'installation-changes-discovery'] as const)(
    'keeps framework preparation consistent with %s', async (scenario) => {
      const projectRoot = await createTempProject()
      tempDirs.push(projectRoot)
      await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
        name: 'plugin-framework-sync-fixture',
        private: true,
        packageManager: 'npm@10.0.0',
        dependencies: {
          '@holo-js/core': '^0.2.2',
          '@holo-js/db': expectedHoloPackageRange,
          'demo-framework': '^1.0.0',
        },
      }, null, 2))
      await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
    plugins: ['holo-plugin-demo-framework'],
})
`)
      await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig(${scenario === 'installation-changes-discovery' ? JSON.stringify({ connections: { default: { driver: 'postgres', url: 'postgres://localhost/app' } } }) : '{}'})
`)

      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-demo-framework')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-demo-framework',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      const syncCommand = [
        'node',
        '-e',
        'require("node:fs").appendFileSync(".holo-js/plugin-framework-sync.txt", "demo-framework\\n")',
      ]
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
    id: 'framework-fixture-plugin',
    contributes: {
      project: { prepare: './prepare.mjs' },
      framework: {
        id: 'demo-framework',
        displayName: 'Demo Framework',
        detectPackages: ['demo-framework'],
        adapterPackage: '@holo-js/adapter-next',
        scaffold: {
          dependencies: {
            'demo-framework': '^1.0.0',
            '@holo-js/adapter-next': '^1.0.0',
          },
          devDependencies: {},
          scripts: {},
          lintScript: 'eslint . --fix',
          typecheckScript: 'tsc -p tsconfig.json --noEmit',
          defaultUrl: 'http://localhost:4000',
          tsconfig: 'next',
        },
        runner: {
          commandName: 'demo-framework',
          buildArgs: ['build'],
          start: ['start'],
          startUsesFrameworkBinary: true,
          preloadNextRuntime: false,
          suppressSvelteKitOutput: false,
          nextDevServerConflictHandling: false,
        },
        sync: {
          commands: {
            npm: ${JSON.stringify(syncCommand)},
            pnpm: ${JSON.stringify(syncCommand)},
            yarn: ${JSON.stringify(syncCommand)},
            bun: ${JSON.stringify(syncCommand)},
          },
          errorLabel: 'demo framework sync',
        },
        capabilities: {
          managedBroadcastAuthRoute: false,
        },
      },
    },
}
`)

      const mutation = `
const pluginPath = projectRoot + '/node_modules/holo-plugin-demo-framework/plugin.mjs'
fs.writeFileSync(pluginPath, fs.readFileSync(pluginPath, 'utf8').replaceAll('demo-framework', 'changed-framework'))
const manifest = JSON.parse(fs.readFileSync(projectRoot + '/package.json', 'utf8'))
delete manifest.dependencies['demo-framework']
manifest.dependencies['changed-framework'] = '^1.0.0'
fs.writeFileSync(projectRoot + '/package.json', JSON.stringify(manifest))
`
      await writeFile(join(pluginRoot, 'prepare.mjs'), `
import fs from 'node:fs'
export default {
    apiVersion: 1,
    prepare(context) {
      const projectRoot = context.projectRoot
      ${scenario === 'preparer-changes-discovery' ? mutation : ''}
      return {
        kind: 'prepared',
        generatedArtifacts: [{ path: 'framework-context.json', contents: JSON.stringify({ framework: context.framework?.id, run: context.run }) }],
        managedArtifacts: [],
        diagnostics: [],
      }
    },
}
`)
      if (scenario === 'installation-changes-discovery') {
        const packagesRoot = await createTempDirectory()
        tempDirs.push(packagesRoot)
        const installedPluginRoot = join(packagesRoot, 'holo-plugin-demo-framework')
        await cp(pluginRoot, installedPluginRoot, { recursive: true })
        const frameworkRoot = join(packagesRoot, 'demo-framework')
        await mkdir(frameworkRoot)
        await writeFile(join(frameworkRoot, 'package.json'), JSON.stringify({ name: 'demo-framework', version: '1.0.0' }))
        const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
        manifest.dependencies['@holo-js/core'] = expectedHoloPackageRange
        manifest.dependencies['demo-framework'] = `file:${frameworkRoot}`
        manifest.dependencies['holo-plugin-demo-framework'] = `file:${installedPluginRoot}`
        await writeFile(join(projectRoot, 'package.json'), JSON.stringify(manifest))
        await writeFile(join(projectRoot, 'install-hook.cjs'), `
const fs = require('node:fs')
const projectRoot = process.cwd()
${mutation.replace("manifest.dependencies['changed-framework'] = '^1.0.0'", `manifest.dependencies['changed-framework'] = ${JSON.stringify(`file:${frameworkRoot}`)}`)}
`)
        await runProjectPrepare(projectRoot, createIo(projectRoot).io)
      } else {
        await runProjectPrepare(projectRoot)
      }

      const expectedFramework = scenario === 'installation-changes-discovery' ? 'changed-framework' : 'demo-framework'
      expect(JSON.parse(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8'))).toEqual({ framework: expectedFramework })
      expect(await readFile(join(projectRoot, '.holo-js/framework/run.mjs'), 'utf8')).toContain(`const commandName = "${expectedFramework}"`)
      expect(JSON.parse(await readFile(join(projectRoot, '.holo-js/generated/framework-fixture-plugin/framework-context.json'), 'utf8'))).toEqual({
        framework: expectedFramework,
        run: { kind: 'full', command: 'prepare', reason: scenario === 'installation-changes-discovery' ? 'dependencies-changed' : 'explicit' },
      })
      await expect(readFile(join(projectRoot, '.holo-js/plugin-framework-sync.txt'), 'utf8')).resolves.toBe(
        scenario === 'installation-changes-discovery' ? 'demo-framework\nchanged-framework\n' : 'demo-framework\n',
      )
      if (scenario === 'preparer-changes-discovery') {
        await runProjectPrepare(projectRoot)
        expect(JSON.parse(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8'))).toEqual({ framework: 'changed-framework' })
        expect(JSON.parse(await readFile(join(projectRoot, '.holo-js/generated/framework-fixture-plugin/framework-context.json'), 'utf8'))).toMatchObject({ framework: 'changed-framework' })
        await expect(readFile(join(projectRoot, '.holo-js/plugin-framework-sync.txt'), 'utf8')).resolves.toBe('demo-framework\nchanged-framework\n')
      }
    }, 60_000,
  )

  it('uses plugin sync commands when plugin framework descriptors override built-in frameworks', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'plugin-framework-override-sync-fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        '@holo-js/core': '^0.2.2',
        '@holo-js/db': '^0.2.2',
        nuxt: '^3.0.0',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  plugins: ['holo-plugin-nuxt-override'],
})
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({})
`)
    await mkdir(join(projectRoot, 'node_modules/.bin'), { recursive: true })
    await symlink(join(workspaceRoot, 'apps/blog-nuxt/node_modules/.bin/nuxt'), join(projectRoot, 'node_modules/.bin/nuxt'))
    await symlink(join(workspaceRoot, 'apps/blog-nuxt/node_modules/nuxt'), join(projectRoot, 'node_modules/nuxt'))
    await symlink(join(workspaceRoot, 'node_modules/@nuxt'), join(projectRoot, 'node_modules/@nuxt'))

    const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-nuxt-override')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'holo-plugin-nuxt-override',
      type: 'module',
      holo: {
        plugin: './plugin.mjs',
      },
    }, null, 2))
    const syncCommand = [
      'node',
      '-e',
      'require("node:fs").writeFileSync(".holo-js/plugin-nuxt-sync.txt", "plugin\\n")',
    ]
    await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'nuxt-override-plugin',
  contributes: {
    framework: {
      id: 'nuxt',
      displayName: 'Nuxt Override',
      detectPackages: ['nuxt'],
      adapterPackage: '@holo-js/adapter-nuxt',
      fluxPackage: '@holo-js/flux-vue',
      scaffold: {
        dependencies: {
          nuxt: '^3.0.0',
          vue: '^3.0.0',
          'vue-router': '^4.0.0',
          '@holo-js/adapter-nuxt': '^1.0.0',
        },
        devDependencies: {},
        scripts: {},
        lintScript: 'eslint . --fix',
        typecheckScript: 'nuxt typecheck',
        defaultUrl: 'http://localhost:3000',
        tsconfig: 'nuxt',
        vscodeVueHybridMode: true,
      },
      runner: {
        commandName: 'nuxt',
        buildArgs: ['build'],
        start: ['.output/server/index.mjs'],
        startUsesFrameworkBinary: false,
        preloadNextRuntime: false,
        suppressSvelteKitOutput: false,
        nextDevServerConflictHandling: false,
      },
      sync: {
        commands: {
          npm: ${JSON.stringify(syncCommand)},
          pnpm: ${JSON.stringify(syncCommand)},
          yarn: ${JSON.stringify(syncCommand)},
          bun: ${JSON.stringify(syncCommand)},
        },
        errorLabel: 'nuxt override sync',
      },
      capabilities: {
        managedBroadcastAuthRoute: false,
      },
    },
  },
}
`)

    await runProjectPrepare(projectRoot, undefined)

    await expect(readFile(join(projectRoot, '.holo-js/plugin-nuxt-sync.txt'), 'utf8')).resolves.toBe('plugin\n')
    await expect(stat(join(projectRoot, '.nuxt/tsconfig.json'))).rejects.toThrow()
  }, 60_000)

  it('runs built-in sync commands when a plugin framework override has no sync definition', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'plugin-framework-override-without-sync-fixture',
      private: true,
      packageManager: 'npm@10.0.0',
      dependencies: {
        '@holo-js/core': '^0.2.2',
        '@holo-js/db': '^0.2.2',
        nuxt: '^3.0.0',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  plugins: ['holo-plugin-nuxt-no-sync-override'],
})
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({})
`)
    await mkdir(join(projectRoot, 'node_modules/.bin'), { recursive: true })
    await symlink(join(workspaceRoot, 'apps/blog-nuxt/node_modules/.bin/nuxt'), join(projectRoot, 'node_modules/.bin/nuxt'))
    await symlink(join(workspaceRoot, 'apps/blog-nuxt/node_modules/nuxt'), join(projectRoot, 'node_modules/nuxt'))
    await symlink(join(workspaceRoot, 'node_modules/@nuxt'), join(projectRoot, 'node_modules/@nuxt'))

    const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-nuxt-no-sync-override')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'holo-plugin-nuxt-no-sync-override',
      type: 'module',
      holo: {
        plugin: './plugin.mjs',
      },
    }, null, 2))
    await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'nuxt-no-sync-override-plugin',
  contributes: {
    framework: {
      id: 'nuxt',
      displayName: 'Nuxt No Sync Override',
      detectPackages: ['nuxt'],
      adapterPackage: '@holo-js/adapter-nuxt',
      fluxPackage: '@holo-js/flux-vue',
      scaffold: {
        dependencies: {
          nuxt: '^3.0.0',
          vue: '^3.0.0',
          'vue-router': '^4.0.0',
          '@holo-js/adapter-nuxt': '^1.0.0',
        },
        devDependencies: {},
        scripts: {},
        lintScript: 'eslint . --fix',
        typecheckScript: 'nuxt typecheck',
        defaultUrl: 'http://localhost:3000',
        tsconfig: 'nuxt',
        vscodeVueHybridMode: true,
      },
      runner: {
        commandName: 'nuxt',
        buildArgs: ['build'],
        start: ['.output/server/index.mjs'],
        startUsesFrameworkBinary: false,
        preloadNextRuntime: false,
        suppressSvelteKitOutput: false,
        nextDevServerConflictHandling: false,
      },
      capabilities: {
        managedBroadcastAuthRoute: false,
      },
    },
  },
}
`)

    await runProjectPrepare(projectRoot, undefined)

    expect((await stat(join(projectRoot, '.nuxt/tsconfig.json'))).isFile()).toBe(true)
  }, 60_000)

  it('generates queue, broadcast, and authorization type artifacts during prepare', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await linkWorkspaceBroadcast(projectRoot)
    await linkWorkspaceAuthorization(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/send-email.ts', `
import { defineJob } from '@holo-js/queue'

export const sendEmailJob = defineJob({
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/broadcast/orders/updated.ts', `
import { channel, defineBroadcast } from '@holo-js/broadcast'

export const orderUpdated = defineBroadcast({
  channels: [channel('orders.{orderId}', { orderId: 1 })],
  payload: {},
})
`)
    await writeProjectFile(projectRoot, 'server/channels/orders.ts', `
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize() {
    return true
  },
})
`)
    await writeProjectFile(projectRoot, 'server/policies/PostPolicy.ts', `
import { definePolicy } from '@holo-js/authorization'

class Post {}

export const postPolicy = definePolicy('posts', Post, {
  view() {
    return true
  },
})
`)
    await writeProjectFile(projectRoot, 'server/abilities/exportReports.ts', `
import { defineAbility } from '@holo-js/authorization'

export default defineAbility('reports.export', () => true)
`)

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    await expect(readFile(join(projectRoot, '.holo-js/generated/queue.d.ts'), 'utf8')).resolves.toContain('"send-email": ExportedQueueJobDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.updated": ExportedBroadcastDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.{orderId}": ExportedChannelDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('"posts": {')
    await expect(readFile(join(projectRoot, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('"reports.export": {')
  }, 30000)

  it('preserves manifest connection fields when env overrides are partial', () => {
    expect(mergeRuntimeDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
        },
      },
    }, {
      db: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: undefined,
            url: undefined,
            host: undefined,
            port: undefined,
            username: undefined,
            password: 'secret',
            database: undefined,
            schema: undefined,
            ssl: undefined,
            logging: undefined,
          },
        },
      },
    })).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'sqlite',
          url: './manifest.sqlite',
          password: 'secret',
        },
      },
    })
  })

  it('does not touch generated ownership or registry files when prepare output is unchanged', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const generatedTsconfigPath = join(projectRoot, '.holo-js/generated/tsconfig.json')
    const generatedRegistryPath = join(projectRoot, '.holo-js/generated/registry.json')
    const firstRegistryStat = await stat(generatedRegistryPath)
    const firstRegistry = JSON.parse(await readFile(generatedRegistryPath, 'utf8')) as { generatedAt: string }

    const pastTime = new Date(Date.now() - 60_000)
    await utimes(generatedTsconfigPath, pastTime, pastTime)
    const backdatedTsconfigMtime = (await stat(generatedTsconfigPath)).mtimeMs

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const secondTsconfigStat = await stat(generatedTsconfigPath)
    const secondRegistryStat = await stat(generatedRegistryPath)
    const secondRegistry = JSON.parse(await readFile(generatedRegistryPath, 'utf8')) as { generatedAt: string }

    expect(secondTsconfigStat.mtimeMs).toBe(backdatedTsconfigMtime)
    expect(secondRegistryStat.mtimeMs).toBeGreaterThanOrEqual(firstRegistryStat.mtimeMs)
    expect(typeof firstRegistry.generatedAt).toBe('string')
    expect(typeof secondRegistry.generatedAt).toBe('string')
    await expect(readTextFile(join(projectRoot, '.holo-js/generated/config-cache.json'))).resolves.toBeUndefined()
  })

  it('skips model files whose generated schema has not been materialized yet', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/admins/User.mjs', `
throw new Error('Model "users" is not present in the generated schema registry. Run "holo migrate" to refresh the internal generated schema metadata.')
`)

    const registry = await (async () => prepareProjectDiscovery(projectRoot))()

    expect(registry.models).toEqual([])
  })

  it('skips scaffolded model modules that explicitly mark themselves pending generated schema', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/Course.mjs', `
export const holoModelPendingSchema = true
export default undefined
`)

    const registry = await (async () => prepareProjectDiscovery(projectRoot))()

    expect(registry.models).toEqual([])
  })

  it('registers an inactive generated model after prepare sees the materialized schema', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const generatedSchemaPath = await ensureGeneratedSchemaPlaceholder(projectRoot, defaultProjectConfig())
    await writeProjectFile(projectRoot, 'server/models/Course.ts', renderModelTemplate({
      tableName: 'courses',
      generatedSchemaImportPath: relativeImportPath(join(projectRoot, 'server/models/Course.ts'), generatedSchemaPath),
    }))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    await (async () => {
      const registry = await loadGeneratedProjectRegistry(projectRoot)

      expect(registry).toBeDefined()
      if (!registry) {
        throw new Error('Expected generated project registry to exist after prepare.')
      }

      expect(Array.isArray(registry.models)).toBe(true)
      expect(registry.models).toEqual(expect.not.arrayContaining([
        'server/models/Course.ts',
      ]))
    })()

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const courses = defineGeneratedTable('courses', {
  id: column.id(),
  title: column.string(),
})

export const tables = {
  courses,
} as const

registerGeneratedTables(tables)
`)

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const schemaExists = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
    expect(schemaExists).toContain('defineGeneratedTable')

    const registryJson = await readFile(join(projectRoot, '.holo-js/generated/registry.json'), 'utf8')
    expect(registryJson).toContain('server/models/Course.ts')
  })

  it('ignores unsupported and nested config entries when generating typed config metadata', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, 'config/services.ts', `
import { defineConfig } from '@holo-js/config'

export default defineConfig({
  services: {
    mailgun: {
      secret: 'secret',
    },
  },
})
`)
    await writeProjectFile(projectRoot, 'config/ignored.json', '{"bad":true}')
    await writeProjectFile(projectRoot, 'config/services.mjs', 'export default { stale: true }')
    await mkdir(join(projectRoot, 'config/nested'), { recursive: true })
    await writeProjectFile(projectRoot, 'config/nested/hidden.ts', 'export default { hidden: true }')

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const generatedTypes = await readFile(join(projectRoot, '.holo-js/generated/config.d.ts'), 'utf8')
    expect(generatedTypes).toContain('"services": typeof')
    expect(generatedTypes).not.toContain('ignored')
    expect(generatedTypes).not.toContain('hidden')
    expect(projectInternals.getConfigExtensionPriority('config.custom')).toBe(Number.MAX_SAFE_INTEGER)

    const nextTsconfig = JSON.parse(projectInternals.renderScaffoldTsconfig({ framework: 'next' }))
    const nuxtTsconfig = JSON.parse(projectInternals.renderScaffoldTsconfig({ framework: 'nuxt' }))
    expect(nextTsconfig.compilerOptions.jsx).toBe('preserve')
    expect(nuxtTsconfig.compilerOptions).toBeUndefined()
  })

  it('does not re-declare built-in redis or security config sections in generated config types', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/redis.ts', `
export default {
  default: 'cache',
  connections: {
    cache: {
      host: 'redis.internal',
      port: 6381,
      db: 4,
    },
  },
}
`)
    await writeProjectFile(projectRoot, 'config/security.ts', `
export default {
  csrf: {
    enabled: true,
  },
}
`)
    await writeProjectFile(projectRoot, 'config/services.ts', `
import { defineConfig } from '@holo-js/config'

export default defineConfig({
  services: {
    mailgun: {
      secret: 'secret',
    },
  },
})
`)

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const generatedTypes = await readFile(join(projectRoot, '.holo-js/generated/config.d.ts'), 'utf8')
    expect(generatedTypes).toContain('"services": typeof')
    expect(generatedTypes).not.toContain('"redis": typeof')
    expect(generatedTypes).not.toContain('"security": typeof')
  })

  it('writes a Nuxt-aware generated tsconfig during prepare', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkNativeFramework(projectRoot, 'nuxt')
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'nuxt' }, null, 2))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const generatedTsconfig = JSON.parse(
      await readFile(join(projectRoot, '.holo-js/generated/tsconfig.json'), 'utf8'),
    ) as { extends: string }

    expect(generatedTsconfig.extends).toBe('../../tsconfig.json')
    const emptyModelTypes = await readFile(join(projectRoot, '.holo-js/generated/model-registry.d.ts'), 'utf8')
    expect(emptyModelTypes).toContain('schema.generated')
    expect(emptyModelTypes).not.toContain('ModelReference')
  }, 30000)

  it('regenerates Next managed route modules during prepare', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'next' }, null, 2))
    await writeProjectFile(projectRoot, 'app/api/auth/user/route.ts', 'import auth, { check, isAuthError, provider, user } from \'@holo-js/auth\'\n')
    await writeProjectFile(projectRoot, 'app/storage/[[...path]]/route.ts', 'export { GET } from \'../../../.holo-js/generated/next/storage-route\'\n')
    await writeProjectFile(projectRoot, 'app/broadcasting/auth/route.ts', 'export { POST } from \'../../../.holo-js/generated/next/broadcast-auth-route\'\n')
    await writeProjectFile(projectRoot, 'app/broadcasting/config/route.ts', 'export { GET } from \'../../../.holo-js/generated/next/broadcast-config-route\'\n')
    await writeProjectFile(projectRoot, 'app/api/auth/clerk/login/route.ts', 'export { GET } from \'../../../../../.holo-js/generated/next/auth-clerk-login-route\'\n')

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    await expect(stat(join(projectRoot, '.holo-js/generated/next/health-route.ts'))).rejects.toThrow()
    const generatedStorageRoute = await readFile(join(projectRoot, '.holo-js/generated/next/storage-route.ts'), 'utf8')
    expect(generatedStorageRoute).toContain('createPublicStorageResponse')
    expect(generatedStorageRoute).toContain('function isNormalizedStorageConfig')
    expect(generatedStorageRoute).toContain('Storage routes require normalized storage configuration')
    expect(await readFile(join(projectRoot, '.holo-js/generated/channel-importer.ts'), 'utf8')).toContain('importBroadcastChannelModule')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).toContain('channelAuth')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).toContain('importBroadcastChannelModule')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/broadcast-config-route.ts'), 'utf8')).toContain('renderBroadcastClientConfigResponse')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/auth-clerk-login-route.ts'), 'utf8')).toContain('loginWithClerk')
  }, 90000)

  it('manages SvelteKit hook entrypoints during prepare and preserves user hook extensions separately', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkNativeFramework(projectRoot, 'sveltekit')
    await linkWorkspaceDb(projectRoot)
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }, null, 2))
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'svelte-managed-hooks-fixture',
      private: true,
      dependencies: {
        '@holo-js/auth': expectedHoloPackageRange,
        '@holo-js/auth-clerk': expectedHoloPackageRange,
        '@holo-js/broadcast': expectedHoloPackageRange,
        '@holo-js/storage': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'src/hooks.ts', 'export const reroute = ({ url }) => url.pathname\n')
    await writeProjectFile(projectRoot, 'src/hooks.server.ts', 'export const handleFetch = async ({ request, fetch }) => fetch(request)\n')
    // Simulate a legacy .user.ts file that should be migrated and deleted.
    await writeProjectFile(projectRoot, 'src/hooks.user.ts', 'export const reroute = ({ url }) => url.pathname\n')
    await writeProjectFile(projectRoot, 'src/hooks.server.user.ts', 'export const handleFetch = async ({ request, fetch }) => fetch(request)\n')
    await writeProjectFile(projectRoot, 'src/lib/server/holo.ts', [
      'import { createSvelteKitHoloHelpers } from \'@holo-js/adapter-sveltekit\'',
      '',
      'export const holo = createSvelteKitHoloHelpers()',
      '',
    ].join('\n'))
    await writeProjectFile(projectRoot, 'src/routes/api/holo/+server.ts', [
      'import { json } from \'@sveltejs/kit\'',
      'import { holo } from \'$lib/server/holo\'',
      '',
      'export async function GET() {',
      '  const app = await holo.getApp()',
      '  return json({',
      '    models: app.registry?.models.length ?? 0,',
      '    commands: app.registry?.commands.length ?? 0,',
      '  })',
      '}',
      '',
    ].join('\n'))
    await writeProjectFile(projectRoot, 'src/routes/broadcasting/auth/+server.ts', [
      'import { renderBroadcastAuthResponse } from \'@holo-js/broadcast/auth\'',
      'import { holo } from \'$lib/server/holo\'',
      '',
      'export async function POST({ request }: { request: Request }) {',
      '  const app = await holo.getApp()',
      '  return await renderBroadcastAuthResponse(request, {',
      '    channelAuth: {',
      '      registry: {',
      '        projectRoot: app.projectRoot,',
      '        channels: app.registry?.channels ?? [],',
      '      },',
      '    },',
      '  })',
      '}',
      '',
    ].join('\n'))
    // Simulate an existing svelte.config.js without the hooks override.
    await writeProjectFile(projectRoot, 'svelte.config.js', [
      'import adapter from \'@sveltejs/adapter-node\'',
      '',
      'const config = {',
      '  kit: {',
      '    adapter: adapter(),',
      '  },',
      '}',
      '',
      'export default config',
      '',
    ].join('\n'))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    // User-owned files remain at the standard SvelteKit paths
    expect(await readFile(join(projectRoot, 'src/hooks.ts'), 'utf8')).toContain('export const reroute')
    expect(await readFile(join(projectRoot, 'src/hooks.server.ts'), 'utf8')).toContain('export const handleFetch')

    // Holo-managed hooks are generated into .holo-js/generated/
    expect(await readFile(join(projectRoot, '.holo-js/generated/hooks.ts'), 'utf8')).toContain('// Generated by holo prepare. Do not edit.')
    expect(await readFile(join(projectRoot, '.holo-js/generated/hooks.ts'), 'utf8')).toContain('holoSvelteKitTransport')
    expect(await readFile(join(projectRoot, '.holo-js/generated/hooks.server.ts'), 'utf8')).toContain('sequence(holoHandle, serverHooks.handle)')

    // Generated hooks import and re-export user hooks
    const generatedHooks = await readFile(join(projectRoot, '.holo-js/generated/hooks.ts'), 'utf8')
    expect(generatedHooks).toContain("from '../../src/hooks'")
    expect(generatedHooks).toContain('reroute')
    expect(generatedHooks).toContain('process.env.STORAGE_ROUTE_PREFIX')
    expect(generatedHooks).toContain('return suffix ? `/storage${suffix}` : \'/storage\'')

    const generatedServerHooks = await readFile(join(projectRoot, '.holo-js/generated/hooks.server.ts'), 'utf8')
    expect(generatedServerHooks).toContain("from '../../src/hooks.server'")
    expect(generatedServerHooks).toContain('handleFetch')
    expect(generatedServerHooks).toContain('error as svelteKitError')
    expect(generatedServerHooks).toContain('cause.name !== \'AuthorizationError\'')
    expect(generatedServerHooks).toContain('svelteKitError(cause.decision.status, cause.message)')
    expect(generatedServerHooks).not.toContain('event.url.pathname =')

    // Legacy .user.ts files are deleted, not left as empty artifacts.
    await expect(stat(join(projectRoot, 'src/hooks.user.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'src/hooks.server.user.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'src/lib/server/holo.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'src/routes/api/holo/+server.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'src/routes/broadcasting/auth/+server.ts'))).rejects.toThrow()
    expect(await readFile(join(projectRoot, '.holo-js/generated/sveltekit/holo.ts'), 'utf8')).toContain('createSvelteKitHoloHelpers')
    expect(generatedServerHooks).not.toContain('handleHoloHealthRoute')
    expect(generatedServerHooks).toContain('handleHoloBroadcastAuthRoute')
    expect(generatedServerHooks).toContain('handleHoloCurrentAuthRoute')
    expect(generatedServerHooks).toContain('handleHoloStorageRoute')
    expect(generatedServerHooks).toContain('function hasHoloStorageConfig')
    expect(generatedServerHooks).toContain('Storage routes require normalized storage configuration')
    expect(generatedServerHooks).toContain('handleHoloClerkCallbackRoute')
    expect(generatedServerHooks).toContain('channelAuth')

    // Existing svelte.config.js is patched with the hooks override.
    const svelteConfig = await readFile(join(projectRoot, 'svelte.config.js'), 'utf8')
    expect(svelteConfig).toContain('withHoloSvelteKit')
    expect(svelteConfig).toContain('@holo-js/adapter-sveltekit/config')
    expect(svelteConfig).not.toContain('.holo-js/generated/hooks.server')
    expect(svelteConfig).not.toContain('.holo-js/generated/hooks')
  }, 90000)

  it('preserves legacy SvelteKit hook extension files when no migration occurs', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkNativeFramework(projectRoot, 'sveltekit')
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }, null, 2))
    await writeProjectFile(projectRoot, 'src/hooks.ts', 'export const reroute = ({ url }) => url.pathname\n')
    await writeProjectFile(projectRoot, 'src/hooks.server.ts', 'export const handleFetch = async ({ request, fetch }) => fetch(request)\n')
    await writeProjectFile(projectRoot, 'src/hooks.user.ts', 'export const transport = {}\n')
    await writeProjectFile(projectRoot, 'src/hooks.server.user.ts', 'export const handle = async ({ event, resolve }) => resolve(event)\n')
    await writeProjectFile(projectRoot, 'svelte.config.js', [
      'import adapter from \'@sveltejs/adapter-node\'',
      '',
      'const config = {',
      '  kit: {',
      '    adapter: adapter(),',
      '  },',
      '}',
      '',
      'export default config',
      '',
    ].join('\n'))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    await expect(readFile(join(projectRoot, 'src/hooks.user.ts'), 'utf8')).resolves.toContain('export const transport')
    await expect(readFile(join(projectRoot, 'src/hooks.server.user.ts'), 'utf8')).resolves.toContain('export const handle')
  }, 30000)

  it('patches compact SvelteKit kit objects without producing invalid config', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkNativeFramework(projectRoot, 'sveltekit')
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }, null, 2))
    await writeProjectFile(projectRoot, 'svelte.config.js', [
      'import adapter from \'@sveltejs/adapter-node\'',
      '',
      'const config = {',
      '  kit: { adapter: adapter() },',
      '}',
      '',
      'export default config',
      '',
    ].join('\n'))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const svelteConfig = await readFile(join(projectRoot, 'svelte.config.js'), 'utf8')
    expect(svelteConfig).toContain('kit: {')
    expect(svelteConfig).toContain('adapter: adapter()')
    expect(svelteConfig).toContain('withHoloSvelteKit')
    expect(svelteConfig).not.toContain('.holo-js/generated/hooks.server')
    expect(svelteConfig).not.toContain('.holo-js/generated/hooks')
    expect(svelteConfig).not.toContain('kit: { adapter: adapter() },\n    files:')
  }, 30000)

  it('wraps SvelteKit config without deleting unrelated user configuration', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkNativeFramework(projectRoot, 'sveltekit')
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }, null, 2))
    await writeProjectFile(projectRoot, 'svelte.config.js', [
      'import adapter from \'@sveltejs/adapter-node\'',
      'import { vitePreprocess } from \'@sveltejs/vite-plugin-svelte\'',
      '',
      'const config = {',
      '  preprocess: vitePreprocess(),',
      '  extensions: [\'.svelte\', \'.svx\'],',
      '  kit: {',
      '    adapter: adapter(),',
      '    alias: {',
      '      $components: \'./src/components\',',
      '    },',
      '    files: {',
      '      assets: \'assets\',',
      '    },',
      '  },',
      '}',
      '',
      'export default config',
      '',
    ].join('\n'))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const svelteConfig = await readFile(join(projectRoot, 'svelte.config.js'), 'utf8')
    expect(svelteConfig).toContain('withHoloSvelteKit')
    expect(svelteConfig).toContain('preprocess: vitePreprocess()')
    expect(svelteConfig).toContain('extensions: [\'.svelte\', \'.svx\']')
    expect(svelteConfig).toContain('$components: \'./src/components\'')
    expect(svelteConfig).toContain('assets: \'assets\'')
  }, 30000)

  it('wraps SvelteKit config with compact export spacing', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    linkNativeFramework(projectRoot, 'sveltekit')
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }, null, 2))
    await writeProjectFile(projectRoot, 'svelte.config.js', [
      'import adapter from \'@sveltejs/adapter-node\'',
      '',
      'const config = {',
      '  kit: {',
      '    adapter: adapter(),',
      '  },',
      '} export   default   config',
      '',
    ].join('\n'))

    await (async () => {
      await runProjectPrepare(projectRoot)
    })()

    const svelteConfig = await readFile(join(projectRoot, 'svelte.config.js'), 'utf8')
    expect(svelteConfig).toContain('withHoloSvelteKit')
    expect(svelteConfig).toContain('})\n\nexport default config')
  }, 30000)

  it('fails prepare for unsupported custom SvelteKit hook entrypoints', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }, null, 2))
    await writeProjectFile(projectRoot, 'svelte.config.js', [
      'import adapter from \'@sveltejs/adapter-node\'',
      '',
      'const config = {',
      '  kit: {',
      '    adapter: adapter(),',
      '    files: {',
      '      hooks: {',
      '        server: \'src/custom-hooks.server\',',
      '        universal: \'src/custom-hooks\',',
      '      },',
      '    },',
      '  },',
      '}',
      '',
      'export default config',
      '',
    ].join('\n'))

    await expect((async () => {
      await runProjectPrepare(projectRoot)
    })()).rejects.toThrow('Custom SvelteKit hook entrypoints are not supported')
  }, 30000)

  it('runs media regeneration through the built CLI runtime', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module' }))
    await writeProjectFile(projectRoot, '.env', 'DB_DRIVER=sqlite\nDB_URL=./storage/database.sqlite\n')
    await mkdir(join(projectRoot, 'storage'), { recursive: true })
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'
export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: { default: { driver: 'sqlite', url: './storage/database.sqlite' } },
})
`)
    await writeProjectFile(projectRoot, 'config/storage.ts', `
import { defineStorageConfig } from '@holo-js/storage'
export default defineStorageConfig({ defaultDisk: 'local' })
`)
    await writeProjectFile(projectRoot, 'server/models/Post.ts', `
import { column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { conversion, defineMediaModel } from '@holo-js/media'
export default defineMediaModel(defineModel(defineGeneratedTable('posts', { id: column.id() }), { name: 'Post' }), {
  conversions: [conversion('thumb').width(10)],
})
`)
    const table = runCliProcess(projectRoot, ['media:table'])
    expect(table.status, table.stderr || table.stdout).toBe(0)
    const migration = runCliProcess(projectRoot, ['migrate'])
    expect(migration.status, migration.stderr || migration.stdout).toBe(0)
    const regenerated = runCliProcess(projectRoot, ['media:regenerate', 'Post', '--only=thumb'])
    expect(regenerated.status, regenerated.stderr || regenerated.stdout).toBe(0)
    expect(regenerated.stdout).toContain('Media regenerated: 0; skipped: 0')
    const unknown = runCliProcess(projectRoot, ['media:regenerate', 'Missing'])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain('Unknown model "Missing"')
  })

  it('writes and detects queue restart signals and reports unsupported sync workers clearly', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)
    const io = createIo(projectRoot)

    await expect(readQueueRestartSignal(projectRoot)).resolves.toBeUndefined()
    const signalPath = await writeQueueRestartSignal(projectRoot, 1234)
    expect(signalPath).toBe(resolveQueueRestartSignalPath(projectRoot))
    await expect(readQueueRestartSignal(projectRoot)).resolves.toBe(1234)
    await expect(hasQueueRestartSignalSince(projectRoot, 1200)).resolves.toBe(true)
    await expect(hasQueueRestartSignalSince(projectRoot, 1300)).resolves.toBe(false)
    await writeFile(resolveQueueRestartSignalPath(projectRoot), 'NaN\n', 'utf8')
    await expect(readQueueRestartSignal(projectRoot)).resolves.toBeUndefined()

    await expect((async () => runQueueRestartCommand(io.io, projectRoot))()).resolves.toBeUndefined()
    expect(io.read().stdout).toContain('Restart signal written')

    await expect((async () => runQueueWorkCommand(io.io, projectRoot, {
      once: true,
    }))()).rejects.toThrow('requires an async-capable driver')

    await expect((async () => runQueueClearCommand(io.io, projectRoot, undefined, undefined))()).resolves.toBeUndefined()
    expect(io.read().stdout).toContain('Cleared 0 pending job(s).')
  })

  it('registers discovered queue jobs for default and custom paths and rejects invalid definitions', async () => {
    const successRoot = await createTempProject()
    tempDirs.push(successRoot)
    ;(globalThis as typeof globalThis & { __holoQueueModelLoaded__?: number }).__holoQueueModelLoaded__ = 0
    await writeProjectFile(successRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
    `)
    await writeProjectFile(successRoot, 'server/models/Post.mjs', `
import { column, defineGeneratedTable, defineModel } from '@holo-js/db'

globalThis.__holoQueueModelLoaded__ = (globalThis.__holoQueueModelLoaded__ ?? 0) + 1

const posts = defineGeneratedTable('posts', {
  id: column.id(),
})

export default defineModel(posts, {})
`)
    await writeProjectFile(successRoot, 'server/jobs/reports/send.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const isolatedCliInternals = await import('../src/queue')
    const queueModule = await import('@holo-js/queue')
    await (async () => {
      await prepareProjectDiscovery(successRoot)
      const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(successRoot)
      try {
        expect(environment.project.config.paths.jobs).toBe('server/jobs')
        expect(queueModule.listRegisteredQueueJobs().map(job => job.name)).toContain('reports.send')
        expect((globalThis as typeof globalThis & { __holoQueueModelLoaded__?: number }).__holoQueueModelLoaded__).toBeGreaterThanOrEqual(1)
      } finally {
        await environment.cleanup()
      }
    })()

    const customJobsRoot = await createTempProject()
    tempDirs.push(customJobsRoot)
    await writeProjectFile(customJobsRoot, 'config/database.ts', await readFile(join(successRoot, 'config/database.ts'), 'utf8'))
    await writeProjectFile(customJobsRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    jobs: 'queue',
  },
})
`)
    await writeProjectFile(customJobsRoot, 'queue/send-email.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'custom-root'
  },
})
`)

    await (async () => {
      await prepareProjectDiscovery(
        customJobsRoot,
        (await loadProjectConfig(customJobsRoot, { required: true })).config,
      )
      const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(customJobsRoot)
      try {
        expect(environment.project.config.paths.jobs).toBe('queue')
        expect(queueModule.listRegisteredQueueJobs().map(job => job.name)).toContain('send-email')
        expect(queueModule.listRegisteredQueueJobs().map(job => job.name)).not.toContain('queue.send-email')
      } finally {
        await environment.cleanup()
      }
    })()

    const emptyRoot = await createTempProject()
    tempDirs.push(emptyRoot)
    await writeProjectFile(emptyRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)

    await (async () => {
      await prepareProjectDiscovery(emptyRoot)
      const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(emptyRoot)
      try {
        expect(queueModule.listRegisteredQueueJobs().filter(job => job.sourcePath)).toEqual([])
      } finally {
        await environment.cleanup()
      }
    })()

    const failingRoot = await createTempProject()
    tempDirs.push(failingRoot)
    await writeProjectFile(failingRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)
    await writeProjectFile(failingRoot, 'server/jobs/broken.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    await (async () => {
      await prepareProjectDiscovery(failingRoot)
      const runtimeArtifacts = await readdir(join(failingRoot, '.holo-js', 'runtime'))
      await writeProjectFile(failingRoot, 'server/jobs/broken.mjs', 'export default { nope: true }\n')
      await expect(isolatedCliInternals.getQueueRuntimeEnvironment(failingRoot)).rejects.toThrow('does not export a Holo job')
      expect(queueModule.getRegisteredQueueJob('broken')).toBeUndefined()
      expect(await readdir(join(failingRoot, '.holo-js', 'runtime'))).toEqual(runtimeArtifacts)
    })()
  })












  it('installs cache support for file, redis, and database drivers and rejects unsupported or missing cache drivers', async () => {
    const fileRoot = await createTempProject()
    tempDirs.push(fileRoot)

    await expect(projectInternals.installCacheIntoProject(fileRoot)).resolves.toEqual({
      updatedPackageJson: true,
      createdCacheConfig: true,
      createdRedisConfig: false,
      updatedEnv: true,
      updatedEnvExample: true,
      databaseDriver: false,
    })
    expect(await readFile(join(fileRoot, 'config/cache.ts'), 'utf8')).toContain('driver: \'file\'')
    expect(await readFile(join(fileRoot, '.env'), 'utf8')).toContain('CACHE_PREFIX=')
    expect(JSON.parse(await readFile(join(fileRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
      },
    })
    await expect(projectInternals.installCacheIntoProject(fileRoot)).resolves.toEqual({
      updatedPackageJson: false,
      createdCacheConfig: false,
      createdRedisConfig: false,
      updatedEnv: false,
      updatedEnvExample: false,
      databaseDriver: false,
    })

    const redisRoot = await createTempProject()
    tempDirs.push(redisRoot)
    await writeProjectFile(redisRoot, '.env', '')
    await writeProjectFile(redisRoot, '.env.example', '')

    await expect(projectInternals.installCacheIntoProject(redisRoot, { driver: 'redis' })).resolves.toEqual({
      updatedPackageJson: true,
      createdCacheConfig: true,
      createdRedisConfig: true,
      updatedEnv: true,
      updatedEnvExample: true,
      databaseDriver: false,
    })
    expect(await readFile(join(redisRoot, 'config/cache.ts'), 'utf8')).toContain('driver: \'redis\'')
    expect(await readFile(join(redisRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    expect(await readFile(join(redisRoot, '.env.example'), 'utf8')).toContain('REDIS_URL=')
    expect(JSON.parse(await readFile(join(redisRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
        '@holo-js/cache-redis': expectedHoloPackageRange,
      },
    })

    const databaseRoot = await createTempProject()
    tempDirs.push(databaseRoot)
    await writeProjectFile(databaseRoot, '.env', '')
    await writeProjectFile(databaseRoot, '.env.example', '')
    await writeProjectFile(databaseRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'database',
  drivers: {
    file: {
      driver: 'file',
    },
    database: {
      driver: 'database',
      connection: 'default',
      table: 'cache',
      lockTable: 'cache_locks',
    },
  },
})
`)

    await expect(projectInternals.installCacheIntoProject(databaseRoot, { driver: 'database' })).resolves.toEqual({
      updatedPackageJson: true,
      createdCacheConfig: false,
      createdRedisConfig: false,
      updatedEnv: true,
      updatedEnvExample: true,
      databaseDriver: true,
    })
    expect(JSON.parse(await readFile(join(databaseRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/cache': expectedHoloPackageRange,
        '@holo-js/cache-db': expectedHoloPackageRange,
      },
    })

    const mismatchRoot = await createTempProject()
    tempDirs.push(mismatchRoot)
    await writeProjectFile(mismatchRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'file',
  drivers: {
    file: {
      driver: 'file',
    },
  },
})
`)

    await expect(projectInternals.installCacheIntoProject(mismatchRoot, {
      driver: 'redis',
    })).rejects.toThrow('does not configure the "redis" cache driver')
    await expect(projectInternals.installCacheIntoProject(mismatchRoot, {
      driver: 'bad' as never,
    })).rejects.toThrow('Unsupported cache driver: bad.')
  }, 30_000)

  it('refuses a redis cache install when the existing redis config has no cache connection', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.env', '')
    await writeProjectFile(projectRoot, '.env.example', '')
    await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'default',
  connections: {
    default: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`)

    await expect(projectInternals.installCacheIntoProject(projectRoot, { driver: 'redis' })).rejects.toThrow('does not define the "cache" Redis connection')
    await expect(projectInternals.installCacheIntoProject(projectRoot, { driver: 'redis' })).rejects.toThrow('cache: {')
    await expect(projectInternals.installCacheIntoProject(projectRoot, { driver: 'redis' })).rejects.toThrow("import { env } from '@holo-js/config'")
    await expect(readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(projectRoot, 'config/redis.ts'), 'utf8')).not.toContain('cache: {')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toBe('')
  }, 30_000)

  it('installs the redis cache store when the existing redis config defines the cache connection', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.env', '')
    await writeProjectFile(projectRoot, '.env.example', '')
    await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'default',
  connections: {
    default: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
    cache: {
      host: '127.0.0.1',
      port: 6379,
      db: 1,
    },
  },
})
`)

    await expect(projectInternals.installCacheIntoProject(projectRoot, { driver: 'redis' })).resolves.toMatchObject({
      createdCacheConfig: true,
      createdRedisConfig: false,
    })
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('connection: \'cache\'')
  }, 30_000)

  describe('redis cache connection check', () => {
    const redisConfigFormats = [
      { extension: 'ts', moduleFormat: 'esm' },
      { extension: 'mts', moduleFormat: 'esm' },
      { extension: 'js', moduleFormat: 'esm' },
      { extension: 'mjs', moduleFormat: 'esm' },
      { extension: 'cts', moduleFormat: 'cjs' },
      { extension: 'cjs', moduleFormat: 'cjs' },
    ] as const
    const envImportLineFor = (moduleFormat: 'esm' | 'cjs') => moduleFormat === 'cjs'
      ? 'const { env } = require(\'@holo-js/config\')'
      : 'import { env } from \'@holo-js/config\''

    function redisConfigSource(moduleFormat: 'esm' | 'cjs', options: { importEnv: boolean, extraConnections: readonly string[] }): string {
      const connections = [
        'default: { host: \'127.0.0.1\', port: 6379, db: 0 }',
        ...options.extraConnections.map(name => `${name}: { host: '127.0.0.1', port: 6379, db: 1 }`),
      ].join(', ')
      if (moduleFormat === 'cjs') {
        return [
          'const { defineRedisConfig } = require(\'@holo-js/kernel\')',
          ...(options.importEnv ? [envImportLineFor('cjs')] : []),
          '',
          `module.exports = defineRedisConfig({ default: 'default', connections: { ${connections} } })`,
          '',
        ].join('\n')
      }
      return [
        'import { defineRedisConfig } from \'@holo-js/kernel\'',
        ...(options.importEnv ? [envImportLineFor('esm')] : []),
        '',
        `export default defineRedisConfig({ default: 'default', connections: { ${connections} } })`,
        '',
      ].join('\n')
    }

    async function refusalMessage(projectRoot: string): Promise<string> {
      const failure = await projectInternals.installCacheIntoProject(projectRoot, { driver: 'redis' }).then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      return failure instanceof Error ? failure.message : ''
    }

    it.each(redisConfigFormats.flatMap(format => [true, false].map(importEnv => ({ ...format, importEnv }))).filter(
      // A CJS config cannot import @holo-js/config under Node today: the package has no require export, so the
      // loader fails before the check runs. The CJS env-import case is covered by redis-cache-connections.test.ts.
      ({ moduleFormat, importEnv }) => !(moduleFormat === 'cjs' && importEnv),
    ))(
      'refuses a redis cache install without a cache connection in a .$extension config (env imported: $importEnv)',
      async ({ extension, moduleFormat, importEnv }) => {
        const projectRoot = await createTempProject()
        tempDirs.push(projectRoot)
        await writeProjectFile(projectRoot, '.env', '')
        await writeProjectFile(projectRoot, '.env.example', '')
        await writeProjectFile(projectRoot, `config/redis.${extension}`, redisConfigSource(moduleFormat, { importEnv, extraConnections: [] }))

        const message = await refusalMessage(projectRoot)

        expect(message).toContain('cache: {')
        if (moduleFormat === 'cjs') {
          expect(message).toContain('db: Number(process.env.REDIS_CACHE_DB || 1),')
          expect(message).not.toContain('require(')
          expect(message).not.toContain('also add this import')
        } else if (importEnv) {
          expect(message).not.toContain('also add this import')
        } else {
          expect(message).toContain(envImportLineFor(moduleFormat))
        }
        await expect(readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      },
      30_000,
    )

    it.each([
      { store: 'none', redis: 'default-only', outcome: 'refuses', snippet: true, missing: '"cache"' },
      { store: 'none', redis: 'default-and-cache', outcome: 'installs' },
      { store: 'none', redis: 'absent', outcome: 'installs' },
      { store: 'cache', redis: 'default-only', outcome: 'refuses', snippet: true, missing: '"cache"' },
      { store: 'omitted', redis: 'default-only', outcome: 'installs' },
      { store: 'sessions', redis: 'default-only', outcome: 'refuses', snippet: false, missing: '"sessions"' },
      { store: 'cache', redis: 'default-and-cache', outcome: 'installs' },
      { store: 'cache', redis: 'absent', outcome: 'installs' },
      { store: 'sessions', redis: 'absent', outcome: 'refuses', snippet: false, missing: '"sessions"' },
    ] as const)(
      'redis cache install with redis config $redis and store $store $outcome',
      async ({ store, redis, outcome, ...expected }) => {
        const projectRoot = await createTempProject()
        tempDirs.push(projectRoot)
        await writeProjectFile(projectRoot, '.env', '')
        await writeProjectFile(projectRoot, '.env.example', '')
        if (redis !== 'absent') {
          await writeProjectFile(projectRoot, 'config/redis.ts', redisConfigSource('esm', {
            importEnv: false,
            extraConnections: redis === 'default-and-cache' ? ['cache'] : [],
          }))
        }
        if (store !== 'none') {
          await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'file',
  drivers: {
    file: {
      driver: 'file',
    },
    redis: {
      driver: 'redis'${store === 'omitted' ? '' : `,\n      connection: '${store}'`},
    },
  },
})
`)
        }

        if (outcome === 'refuses') {
          const message = await refusalMessage(projectRoot)
          expect(message).toContain(expected.missing)
          if (expected.snippet) {
            expect(message).toContain('cache: {')
          } else {
            expect(message).not.toContain('cache: {')
          }
          if (store === 'none') {
            await expect(readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
          }
          return
        }

        await expect(projectInternals.installCacheIntoProject(projectRoot, { driver: 'redis' })).resolves.toMatchObject({
          createdCacheConfig: store === 'none',
          createdRedisConfig: redis === 'absent',
        })
      },
      60_000,
    )
  })

  it('generates queue table migrations and flushes persisted failed jobs', async () => {
    const defaultProjectRoot = await createTempProject()
    tempDirs.push(defaultProjectRoot)

    await (async () => runQueueTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))()
    await expect((async () => runQueueTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))()).rejects.toThrow('A migration for table "jobs" already exists.')
    await (async () => runQueueFailedTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))()
    await expect((async () => runQueueFailedTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))()).rejects.toThrow('A migration for table "failed_jobs" already exists.')

    const defaultMigrationFiles = await readdir(join(defaultProjectRoot, 'server/db/migrations'))
    const jobsMigrationPath = join(defaultProjectRoot, 'server/db/migrations', defaultMigrationFiles.find(name => name.endsWith('create_jobs_table.ts'))!)
    const failedMigrationPath = join(defaultProjectRoot, 'server/db/migrations', defaultMigrationFiles.find(name => name.endsWith('create_failed_jobs_table.ts'))!)
    expect(await readFile(jobsMigrationPath, 'utf8')).toContain('table.string(\'reservation_id\').nullable()')
    expect(await readFile(failedMigrationPath, 'utf8')).toContain('table.text(\'exception\')')

    const customProjectRoot = await createTempProject()
    tempDirs.push(customProjectRoot)
    await writeProjectFile(customProjectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'database',
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'queue_failed_jobs',
  },
  connections: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'jobs',
    },
    reports: {
      driver: 'database',
      connection: 'default',
      table: 'report_jobs',
    },
  },
})
`)

    expect(resolveDatabaseQueueTables(await loadConfigDirectory(customProjectRoot).then(config => config.queue))).toEqual(['jobs', 'report_jobs'])
    await (async () => runQueueTableCommand(createIo(customProjectRoot).io, customProjectRoot))()
    await (async () => runQueueFailedTableCommand(createIo(customProjectRoot).io, customProjectRoot))()
    const customMigrations = await readdir(join(customProjectRoot, 'server/db/migrations'))
    expect(customMigrations.some(name => name.endsWith('create_jobs_table.ts'))).toBe(true)
    expect(customMigrations.some(name => name.endsWith('create_report_jobs_table.ts'))).toBe(true)
    expect(customMigrations.some(name => name.endsWith('create_queue_failed_jobs_table.ts'))).toBe(true)
    expect(renderQueueTableMigration('jobs')).toContain('table.bigInteger(\'available_at\')')
    expect(renderFailedJobsTableMigration('failed_jobs')).toContain('table.bigInteger(\'failed_at\')')

    const failedOnlyProjectRoot = await createTempProject()
    tempDirs.push(failedOnlyProjectRoot)
    await (async () => runQueueFailedTableCommand(createIo(failedOnlyProjectRoot).io, failedOnlyProjectRoot))()
    expect((await readdir(join(failedOnlyProjectRoot, 'server/db/migrations'))).some(name => name.endsWith('create_failed_jobs_table.ts'))).toBe(true)

    const disabledFailedProjectRoot = await createTempProject()
    tempDirs.push(disabledFailedProjectRoot)
    await writeProjectFile(disabledFailedProjectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  failed: false,
})
`)
    await (async () => runQueueFailedTableCommand(createIo(disabledFailedProjectRoot).io, disabledFailedProjectRoot))()
    expect((await readdir(join(disabledFailedProjectRoot, 'server/db/migrations'))).some(name => name.endsWith('create_failed_jobs_table.ts'))).toBe(true)

    const actualFlushProjectRoot = await createTempProject()
    tempDirs.push(actualFlushProjectRoot)
    await linkWorkspaceDb(actualFlushProjectRoot)
    const sqlitePath = join(actualFlushProjectRoot, 'queue.sqlite')
    await writeProjectFile(actualFlushProjectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ${JSON.stringify(sqlitePath)},
    },
  },
})
`)
    await writeProjectFile(actualFlushProjectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'database',
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
  connections: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'jobs',
      queue: 'default',
    },
  },
})
`)
    const actualRuntime = await initializeHolo(actualFlushProjectRoot)
    try {
      await createSchemaService(DB.connection()).createTable('jobs', (table) => {
        table.string('id').primaryKey()
        table.string('job')
        table.string('connection')
        table.string('queue')
        table.text('payload')
        table.integer('attempts').default(0)
        table.integer('max_attempts').default(1)
        table.bigInteger('available_at')
        table.bigInteger('reserved_at').nullable()
        table.string('reservation_id').nullable()
        table.bigInteger('created_at')
      })
      await createSchemaService(DB.connection()).createTable('failed_jobs', (table) => {
        table.string('id').primaryKey()
        table.string('job_id')
        table.string('job')
        table.string('connection')
        table.string('queue')
        table.text('payload')
        table.text('exception')
        table.bigInteger('failed_at')
      })
      await DB.connection().executeCompiled({
        sql: 'INSERT INTO "failed_jobs" (id, job_id, job, connection, queue, payload, exception, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bindings: ['failed-2', 'job-2', 'reports.send', 'database', 'default', '{"id":"job-2","name":"reports.send","connection":"database","queue":"default","payload":{"ok":true},"attempts":1,"maxAttempts":3,"createdAt":300}', 'boom', 300],
        source: 'test:queue:failed-jobs',
      })
    } finally {
      await actualRuntime.shutdown()
    }

    const actualFlushIo = createIo(actualFlushProjectRoot)
    const actualFailedIo = createIo(actualFlushProjectRoot)
    await runQueueFailedCommand(actualFailedIo.io, actualFlushProjectRoot)
    expect(actualFailedIo.read().stdout).toContain('failed-2 reports.send connection=database queue=default failedAt=300')
    await runQueueFlushCommand(actualFlushIo.io, actualFlushProjectRoot)
    expect(actualFlushIo.read().stdout).toContain('Flushed 1 failed job(s).')

    const actualRetryRuntime = await initializeHolo(actualFlushProjectRoot)
    try {
      await DB.connection().executeCompiled({
        sql: 'INSERT INTO "failed_jobs" (id, job_id, job, connection, queue, payload, exception, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bindings: ['failed-3', 'job-3', 'reports.retry', 'database', 'default', '{"id":"job-3","name":"reports.retry","connection":"database","queue":"default","payload":{"ok":true},"attempts":0,"maxAttempts":2,"createdAt":400}', 'boom', 400],
        source: 'test:queue:failed-jobs:retry',
      })
    } finally {
      await actualRetryRuntime.shutdown()
    }

    const actualRetryIo = createIo(actualFlushProjectRoot)
    await runQueueRetryCommand(actualRetryIo.io, actualFlushProjectRoot, 'failed-3')
    expect(actualRetryIo.read().stdout).toContain('Retried 1 failed job(s).')

    const actualForgetIo = createIo(actualFlushProjectRoot)
    await runQueueForgetCommand(actualForgetIo.io, actualFlushProjectRoot, 'missing')
    expect(actualForgetIo.read().stdout).toContain('Failed job missing was not found.')
  }, 120000)

  it('generates cache table migrations with default and configured database cache tables', async () => {
    const defaultProjectRoot = await createTempProject()
    tempDirs.push(defaultProjectRoot)
    await writeProjectFile(defaultProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'database',
  drivers: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'cache',
      lockTable: 'cache_locks',
    },
  },
})
`)

    await (async () => runCacheTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))()
    await expect((async () => runCacheTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))()).rejects.toThrow('A migration for cache tables "cache" and "cache_locks" already exists.')

    const defaultMigrationFiles = await readdir(join(defaultProjectRoot, 'server/db/migrations'))
    const defaultMigrationPath = join(defaultProjectRoot, 'server/db/migrations', defaultMigrationFiles.find(name => name.endsWith('create_cache_cache_table.ts'))!)
    const defaultMigration = await readFile(defaultMigrationPath, 'utf8')
    expect(defaultMigration).toContain('table.string(\'key\').primaryKey()')
    expect(defaultMigration).toContain('await schema.createTable(\'cache_locks\'')

    const customProjectRoot = await createTempProject()
    tempDirs.push(customProjectRoot)
    await writeProjectFile(customProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'database',
  drivers: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'cache_entries',
      lockTable: 'cache_entry_locks',
    },
    reports: {
      driver: 'database',
      connection: 'default',
      table: 'report_cache',
      lockTable: 'report_cache_locks',
    },
    file: {
      driver: 'file',
      path: '.holo/cache',
    },
  },
})
`)

    expect(resolveDatabaseCacheTables(await loadConfigDirectory(customProjectRoot).then(config => config.cache))).toEqual([
      { table: 'cache_entries', lockTable: 'cache_entry_locks' },
      { table: 'report_cache', lockTable: 'report_cache_locks' },
    ])

    await (async () => runCacheTableCommand(createIo(customProjectRoot).io, customProjectRoot))()
    const customMigrations = await readdir(join(customProjectRoot, 'server/db/migrations'))
    expect(customMigrations.some(name => name.endsWith('create_cache_entries_cache_table.ts'))).toBe(true)
    expect(customMigrations.some(name => name.endsWith('create_report_cache_cache_table.ts'))).toBe(true)
    expect(renderCacheTableMigration('cache_entries', 'cache_entry_locks')).toContain('table.bigInteger(\'expires_at\').nullable()')
    expect(renderCacheTableMigration(`cache'entries`, `cache\\locks`)).toContain('cache\\\'entries')
    expect(renderCacheTableMigration(`cache'entries`, `cache\\locks`)).toContain('cache\\\\locks')

    const fileOnlyProjectRoot = await createTempProject()
    tempDirs.push(fileOnlyProjectRoot)
    await writeProjectFile(fileOnlyProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'file',
  drivers: {
    file: {
      driver: 'file',
      path: '.holo/cache',
    },
  },
})
`)

    await expect(
      (async () => runCacheTableCommand(createIo(fileOnlyProjectRoot).io, fileOnlyProjectRoot))(),
    ).rejects.toThrow('The configured cache drivers do not use the database driver.')

    const duplicateProjectRoot = await createTempProject()
    tempDirs.push(duplicateProjectRoot)
    await writeProjectFile(duplicateProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'first',
  drivers: {
    first: {
      driver: 'database',
      connection: 'default',
      table: 'report.cache',
      lockTable: 'report_cache_locks',
    },
    second: {
      driver: 'database',
      connection: 'default',
      table: 'report_cache',
      lockTable: 'other_cache_locks',
    },
  },
})
`)

    await expect(
      (async () => runCacheTableCommand(createIo(duplicateProjectRoot).io, duplicateProjectRoot))(),
    ).rejects.toThrow('A migration for cache tables "report_cache" and "other_cache_locks" already exists.')
  })









  it('refreshes project discovery for queue runtime environments even when a registry already exists', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)
    await writeProjectFile(projectRoot, '.holo-js/generated/registry.json', `${JSON.stringify({
      version: 1,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: '.holo-js/generated/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      authorizationPolicies: [],
      authorizationAbilities: [],
    }, null, 2)}\n`)
    await writeProjectFile(projectRoot, 'server/jobs/reports/send.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'fresh'
  },
})
`)

    await (async () => {
      const environment = await getQueueRuntimeEnvironment(projectRoot)
      try {
        const registry = await loadGeneratedProjectRegistry(projectRoot)
        expect(registry?.jobs).toEqual([
          expect.objectContaining({
            sourcePath: 'server/jobs/reports/send.mjs',
            name: 'reports.send',
          }),
        ])
      } finally {
        await environment.cleanup()
      }
    })()
  }, 30000)


  it('covers project file helpers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const manifestPath = await writeProjectConfig(projectRoot, {
      ...defaultProjectConfig(),
      database: {
        connections: {
          default: {
            driver: 'sqlite',
            url: './data.sqlite',
          },
        },
      },
    })
    expect(manifestPath).toContain('config/app.ts')
    await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"name"')
    await expect(readFile(join(projectRoot, 'config/database.ts'), 'utf8')).resolves.toContain('defineDatabaseConfig({})')

    const notePath = join(projectRoot, 'notes.txt')
    await writeTextFile(notePath, 'ready')
    await expect(readTextFile(notePath)).resolves.toBe('ready')
    await expect(readTextFile(join(projectRoot, 'missing.txt'))).resolves.toBeUndefined()
    expect(stripFileExtension('/tmp/example/file.ts')).toBe('/tmp/example/file')

    const generatedPath = await ensureGeneratedSchemaPlaceholder(projectRoot, defaultProjectConfig())
    const generatedPathAgain = await ensureGeneratedSchemaPlaceholder(projectRoot, defaultProjectConfig())
    expect(generatedPathAgain).toBe(generatedPath)
  })

  it('falls back to defaults when serializing over broken live config files', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'config/app.ts', 'throw new Error("broken app config")')
    await rm(join(projectRoot, 'config/database.ts'), { force: true })

    const manifestSource = await projectInternals.serializeProjectConfig(
      projectRoot,
      defaultProjectConfig(),
      join(projectRoot, 'config/app.ts'),
    )
    const databaseSource = await projectInternals.serializeDatabaseConfig(
      projectRoot,
      join(projectRoot, 'config/database.ts'),
    )

    expect(manifestSource).toContain('"name": "Holo"')
    expect(databaseSource).toContain(`"defaultConnection": "${defaultProjectConfig().database?.defaultConnection ?? 'default'}"`)
  })

  it('falls back when package.json is missing or invalid while detecting module packages', async () => {
    const missingPackageRoot = await createTempDirectory()
    tempDirs.push(missingPackageRoot)
    const jsManifestPath = join(missingPackageRoot, 'config/app.js')

    await writeProjectConfig(missingPackageRoot, defaultProjectConfig(), jsManifestPath)
    await expect(readFile(jsManifestPath, 'utf8')).resolves.toContain('module.exports = defineAppConfig(')

    const invalidPackageRoot = await createTempProject()
    tempDirs.push(invalidPackageRoot)
    await writeProjectFile(invalidPackageRoot, 'package.json', '{ invalid json')
    const invalidManifestPath = join(invalidPackageRoot, 'config/app.js')

    await writeProjectConfig(invalidPackageRoot, defaultProjectConfig(), invalidManifestPath)
    await expect(readFile(invalidManifestPath, 'utf8')).resolves.toContain('module.exports = defineAppConfig(')
  })

  it('preserves CommonJS syntax when rewriting config/app.js', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const manifestPath = join(projectRoot, 'config/app.js')
    await writeProjectFile(projectRoot, 'config/app.js', 'module.exports = {}')

    await writeProjectConfig(projectRoot, defaultProjectConfig(), manifestPath)

    await expect(readFile(manifestPath, 'utf8')).resolves.toContain('module.exports = defineAppConfig(')
    await expect(readFile(manifestPath, 'utf8')).resolves.not.toContain('export default defineAppConfig(')
  })

  it('preserves ESM syntax for config/app.js inside type-module packages', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
    }, null, 2))

    const manifestPath = join(projectRoot, 'config/app.js')
    await writeProjectFile(projectRoot, 'config/app.js', 'export default {}')

    await writeProjectConfig(projectRoot, defaultProjectConfig(), manifestPath)

    await expect(readFile(manifestPath, 'utf8')).resolves.toContain('export default defineAppConfig(')
    await expect(readFile(manifestPath, 'utf8')).resolves.not.toContain('module.exports = defineAppConfig(')
  })

  it('covers project manifest and registration loaders', async () => {
    const ensureProjectRoot = await createTempDirectory()
    tempDirs.push(ensureProjectRoot)

    await expect(loadProjectConfig(ensureProjectRoot, { required: true })).rejects.toThrow('Missing config/app.(ts|mts|js|mjs)')

    const ensured = await ensureProjectConfig(ensureProjectRoot)
    expect(ensured.manifestPath).toContain('config/app.ts')

    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
})
`)
    await writeProjectFile(projectRoot, 'server/models/Session.mjs', `
export default {
  definition: { kind: 'model', name: 'Session', table: { tableName: 'sessions' }, prunable: true },
  async prune() { return 1 },
}
`)
    await writeProjectFile(projectRoot, 'server/models/Bad.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_example.mjs', `
export default {
  async up() {},
}
`)
    await writeProjectFile(projectRoot, 'server/db/migrations/manual_name.mjs', `
export default {
  name: 'manual-name',
  async up() {},
}
`)
    await writeProjectFile(projectRoot, 'server/db/migrations/Bad.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'server/db/seeders/Example.mjs', `
export default {
  name: 'example',
  async run() {},
}
`)
    await writeProjectFile(projectRoot, 'server/db/seeders/Bad.mjs', 'export default {}')

    await (async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      await expect(prepareProjectDiscovery(projectRoot, loaded.config)).rejects.toThrow('does not export a Holo model')

      await rm(join(projectRoot, 'server/models/Bad.mjs'))
      await expect(prepareProjectDiscovery(projectRoot, loaded.config)).rejects.toThrow('does not export a Holo migration')

      await rm(join(projectRoot, 'server/db/migrations/Bad.mjs'))
      await expect(prepareProjectDiscovery(projectRoot, loaded.config)).rejects.toThrow('must match YYYY_MM_DD_HHMMSS_description')
      await expect(loadRegisteredMigrations(projectRoot, {
        ...defaultProjectConfig(),
        migrations: ['server/db/migrations/manual_name.mjs'],
      })).rejects.toThrow('must match YYYY_MM_DD_HHMMSS_description')

      await rm(join(projectRoot, 'server/db/migrations/manual_name.mjs'))
      await expect(prepareProjectDiscovery(projectRoot, loaded.config)).rejects.toThrow('does not export a Holo seeder')

      await rm(join(projectRoot, 'server/db/seeders/Bad.mjs'))
      await prepareProjectDiscovery(projectRoot, loaded.config)
      const prepared = await loadProjectConfig(projectRoot, { required: true })
      await expect(loadRegisteredModels(projectRoot, {
        ...prepared.config,
        models: ['server/models/Session.mjs'],
      })).resolves.toHaveLength(1)
      await expect(loadRegisteredMigrations(projectRoot, {
        ...prepared.config,
        migrations: ['server/db/migrations/2026_01_01_000001_example.mjs'],
      })).resolves.toMatchObject([{ name: '2026_01_01_000001_example' }])
      await expect(loadRegisteredSeeders(projectRoot, {
        ...prepared.config,
        seeders: ['server/db/seeders/Example.mjs'],
      })).resolves.toHaveLength(1)

      expect(prepared.config.models).toEqual(['server/models/Session.mjs'])
      expect(prepared.config.migrations).toEqual(['server/db/migrations/2026_01_01_000001_example.mjs'])
      expect(prepared.config.seeders).toEqual(['server/db/seeders/Example.mjs'])
    })()
  })

  it('rejects invalid registered artifacts directly', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/Bad.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'server/db/migrations/Bad.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'server/db/seeders/Bad.mjs', 'export default {}')

    await (async () => {
      await expect(loadRegisteredModels(projectRoot, {
        ...defaultProjectConfig(),
        models: ['server/models/Bad.mjs'],
      })).rejects.toThrow('does not export a Holo model')
      await expect(loadRegisteredMigrations(projectRoot, {
        ...defaultProjectConfig(),
        migrations: ['server/db/migrations/Bad.mjs'],
      })).rejects.toThrow('does not export a Holo migration')
      await expect(loadRegisteredSeeders(projectRoot, {
        ...defaultProjectConfig(),
        seeders: ['server/db/seeders/Bad.mjs'],
      })).rejects.toThrow('does not export a Holo seeder')
    })()
  })

  it('falls back to the generated module when generated registry JSON is malformed', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, '.holo-js/generated/registry.json', '{')
    await writeProjectFile(projectRoot, '.holo-js/generated/index.ts', `
export const registry = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    jobs: 'server/jobs',
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
  models: [],
  migrations: [],
  seeders: [],
  commands: [],
  jobs: [],
  events: [],
  listeners: [],
  broadcast: [],
  channels: [],
  authorizationPolicies: [],
  authorizationAbilities: [],
}
`)

    await (async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toMatchObject({ version: 1 })
    })()
  }, 30000)

  it('loads generated registries from named exports and ignores invalid generated modules', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, '.holo-js/generated/index.ts', `
export const registry = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    jobs: 'server/jobs',
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
  models: [],
  migrations: [],
  seeders: [],
  commands: [],
  jobs: [],
}
`)

    await (async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toMatchObject({ version: 1 })
    })()

    await writeProjectFile(projectRoot, '.holo-js/generated/index.ts', 'export default 1')
    await (async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toBeUndefined()
    })()
  })

  it('loads generated registries from default exports', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, '.holo-js/generated/index.ts', `
export default {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    jobs: 'server/jobs',
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
  models: [],
  migrations: [],
  seeders: [],
  commands: [],
  jobs: [],
}
`)

    await (async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toMatchObject({ version: 1 })
    })()
  }, 30000)

  it('covers generated tsconfig render helpers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    expect(projectInternals.renderGeneratedTsconfig()).toContain('../../tsconfig.json')
    await expect(renderFrameworkAwareTsconfig(projectRoot)).resolves.toContain('../../tsconfig.json')
  }, 30000)

  it('renders schema runtime tables from default and named generated schema exports', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const registry = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: '.holo-js/generated/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      broadcast: [],
      channels: [],
      authorizationPolicies: [],
      authorizationAbilities: [],
    } satisfies Parameters<typeof writeGeneratedProjectRegistry>[1]

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
export default {
  kind: 'table',
  tableName: 'users',
  columns: {},
  indexes: [],
}
`)
    await writeGeneratedProjectRegistry(projectRoot, registry)
    await expect(readFile(join(projectRoot, '.holo-js/generated/schema.mjs'), 'utf8')).resolves.toContain('users')

    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
export const posts = {
  kind: 'table',
  tableName: 'posts',
  columns: {},
  indexes: [],
}
`)
    await writeGeneratedProjectRegistry(projectRoot, registry)
    await expect(readFile(join(projectRoot, '.holo-js/generated/schema.mjs'), 'utf8')).resolves.toContain('posts')
  }, 30000)

  it('propagates generated schema access errors other than missing files', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const generatedSchemaPath = join(projectRoot, '.holo-js/generated/schema.generated.ts')
    await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', 'export const users = {}')
    await chmod(dirname(generatedSchemaPath), 0)

    try {
      await expect(writeGeneratedProjectRegistry(projectRoot, {
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        paths: {
          models: 'server/models',
          migrations: 'server/db/migrations',
          seeders: 'server/db/seeders',
          commands: 'server/commands',
          jobs: 'server/jobs',
          events: 'server/events',
          listeners: 'server/listeners',
          broadcast: 'server/broadcast',
          channels: 'server/channels',
          authorizationPolicies: 'server/policies',
          authorizationAbilities: 'server/abilities',
          generatedSchema: '.holo-js/generated/schema.generated.ts',
        },
        models: [],
        migrations: [],
        seeders: [],
        commands: [],
        jobs: [],
        events: [],
        listeners: [],
        broadcast: [],
        channels: [],
        authorizationPolicies: [],
        authorizationAbilities: [],
      })).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(dirname(generatedSchemaPath), 0o755)
    }
  }, 30000)

  it('covers named exports for commands and registered runtime artifacts', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({})
`)
    await writeProjectFile(projectRoot, 'server/models/Session.mjs', `
export const SessionModel = {
  definition: { kind: 'model', name: 'Session', table: { tableName: 'sessions' }, prunable: true },
  async prune() { return 1 },
}
`)
    await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_example.mjs', `
export const ExampleMigration = {
  async up() {},
}
`)
    await writeProjectFile(projectRoot, 'server/db/seeders/Example.mjs', `
export const ExampleSeeder = {
  name: 'example',
  async run() {},
}
`)
    await writeProjectFile(projectRoot, 'server/commands/courses/reindex.mjs', `
export const command = {
  description: 'Reindex courses.',
  async run() {},
}
`)

    await (async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      await prepareProjectDiscovery(projectRoot, loaded.config)
      const prepared = await loadProjectConfig(projectRoot, { required: true })
      const commands = await discoverAppCommands(projectRoot, prepared.config)
      expect(commands).toHaveLength(1)
      expect(commands[0]?.name).toBe('courses:reindex')
      await expect(commands[0]?.load()).resolves.toMatchObject({ description: 'Reindex courses.' })
      await writeProjectFile(projectRoot, 'server/commands/courses/reindex.mjs', 'export default { nope: true }')
      await expect(commands[0]?.load()).rejects.toThrow('does not export a Holo command')
      await expect(loadRegisteredModels(projectRoot, prepared.config)).resolves.toHaveLength(1)
      await expect(loadRegisteredMigrations(projectRoot, prepared.config)).resolves.toHaveLength(1)
      await expect(loadRegisteredSeeders(projectRoot, prepared.config)).resolves.toHaveLength(1)
    })()
  })

  it('discovers commands from fresh canonical directories without a prebuilt registry', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/zeta.mjs', `
export default {
  description: 'Zeta command.',
  aliases: [' ', ''],
  async run() {},
}
`)
    await writeProjectFile(projectRoot, 'server/commands/alpha.mjs', `
export default {
  description: 'Alpha command.',
  usage: 'holo alpha',
  async run() {},
}
`)

    await rm(join(projectRoot, '.holo-js'), { recursive: true, force: true })

    await (async () => {
      const commands = await discoverAppCommands(projectRoot, defaultProjectConfig())
      expect(commands.map(command => command.name)).toEqual(['alpha', 'zeta'])
      await expect(commands[0]?.load()).resolves.toMatchObject({ description: 'Alpha command.' })
      await expect(readFile(join(projectRoot, '.holo-js/generated/index.ts'), 'utf8')).resolves.toContain('export default registry')
    })()
  })

  it('covers fallback manifest resolution and existing project config reuse', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await (async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.models).toEqual([])

      const ensured = await ensureProjectConfig(projectRoot)
      expect(ensured.manifestPath).toContain('config/app.ts')
    })()
  })

  it('ships a runnable published CLI entrypoint', async () => {
    const built = ensureBuiltWorkspacePackagesSync()

    const packageJson = JSON.parse(await readFile(join(workspaceRoot, 'packages/cli/package.json'), 'utf8')) as {
      bin?: Record<string, string>
      files?: string[]
      engines?: Record<string, string>
    }
    const publishedBin = await readFile(join(built.cliPackageRoot, 'dist/bin/holo.mjs'), 'utf8')
    const publishedIndex = await readFile(join(built.cliPackageRoot, 'dist/index.mjs'), 'utf8')
    const publishedEntrypoints = [
      publishedBin,
      ...await Promise.all(
        (await readdir(join(built.cliPackageRoot, 'dist')))
          .filter(fileName => fileName.endsWith('.mjs'))
          .map(async fileName => readFile(join(built.cliPackageRoot, 'dist', fileName), 'utf8')),
      ),
    ]
    const executed = spawnSync('node', [built.cliBinPath, 'list'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: process.env,
    })

    expect(packageJson.bin?.holo).toBe('./dist/bin/holo.mjs')
    expect(packageJson.files).toContain('dist')
    expect(packageJson.engines?.node).toBeDefined()
    expect(packageJson.engines?.bun).toBeUndefined()
    expect(publishedBin.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(publishedBin.startsWith('#!/usr/bin/env node\n#!/usr/bin/env node')).toBe(false)
    expect(publishedIndex.startsWith('#!/usr/bin/env node')).toBe(false)
    expect(publishedEntrypoints.some(entrypoint => entrypoint.includes('workspaces:'))).toBe(false)
    expect(publishedEntrypoints.some(entrypoint => entrypoint.includes('.workspaces.catalog'))).toBe(false)
    expect(executed.status, executed.stderr || executed.stdout).toBe(0)
    expect(executed.stdout).toContain('Internal commands:')
  })

  it('runs non-runtime published CLI commands without loading runtime-only deps', async () => {
    const built = ensureBuiltWorkspacePackagesSync()

    const listed = spawnSync('node', [built.cliBinPath, 'list'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: process.env,
    })
    const help = spawnSync('node', [built.cliBinPath, 'make:model', '--help'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: process.env,
    })

    expect(listed.status, listed.stderr || listed.stdout).toBe(0)
    expect(listed.stdout).toContain('Internal commands:')
    expect(help.status, help.stderr || help.stdout).toBe(0)
    expect(help.stdout).toContain('Create a model and optionally related database artifacts.')
  })

  it('runs published make:model through the user CLI path without installing unrelated optional packages', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await linkWorkspaceDb(projectRoot)

    const person = runCliProcess(projectRoot, ['make:model', 'Person', '--migration'])
    const child = runCliProcess(projectRoot, ['make:model', 'Child', '--migration', '--observer', '--seeder', '--factory'])
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    }

    expect(person.status, person.stderr || person.stdout).toBe(0)
    expect(child.status, child.stderr || child.stdout).toBe(0)

    const personModel = await readFile(join(projectRoot, 'server/models/Person.ts'), 'utf8')
    const childModel = await readFile(join(projectRoot, 'server/models/Child.ts'), 'utf8')
    const childObserver = await readFile(join(projectRoot, 'server/db/observers/ChildObserver.ts'), 'utf8')
    const childSeeder = await readFile(join(projectRoot, 'server/db/seeders/ChildSeeder.ts'), 'utf8')
    const childFactory = await readFile(join(projectRoot, 'server/db/factories/ChildFactory.ts'), 'utf8')
    const migrations = await readdir(join(projectRoot, 'server/db/migrations'))

    expect(personModel).toContain('export default defineModel("people", {')
    expect(childModel).toContain('export default defineModel("children", {')
    expect(childModel).toContain('observers: [ChildObserver],')
    expect(childObserver).toContain('export class ChildObserver')
    expect(childSeeder).toContain('name: \'child\',')
    expect(childFactory).toContain('defineFactory(Child, () => ({')
    expect(migrations.some(fileName => fileName.endsWith('_create_people_table.ts'))).toBe(true)
    expect(migrations.some(fileName => fileName.endsWith('_create_children_table.ts'))).toBe(true)
    expect(dependencies['@holo-js/auth']).toBeUndefined()
    expect(dependencies['@holo-js/notifications']).toBeUndefined()
    expect(dependencies['@holo-js/mail']).toBeUndefined()
    expect(dependencies['@holo-js/broadcast']).toBeUndefined()
    expect(dependencies['@holo-js/cache']).toBeUndefined()
    expect(dependencies['@holo-js/security']).toBeUndefined()
    expect(dependencies['@holo-js/storage']).toBeUndefined()
  }, 30_000)
})
