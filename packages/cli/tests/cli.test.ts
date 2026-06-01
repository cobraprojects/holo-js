import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { initializeHolo } from '@holo-js/core'
import { DB, createSchemaService } from '@holo-js/db'
import {
  linkInstalledDependenciesForPackageSync,
  resolveInstalledDependencyRoot,
  symlinkPackageDependencySync,
} from '../../../tests/support/published-package'
import type * as HoloConfigModule from '@holo-js/config'
import type * as HoloCoreModule from '@holo-js/core'
import type * as HoloDbModule from '@holo-js/db'
import type * as HoloDbMysqlModule from '../../db-mysql/src'
import type * as HoloDbPostgresModule from '../../db-postgres/src'
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
import { defineCommand } from '../src'
import {
  generateProjectAppKey,
  renderEnvWithAppKey,
} from '../src/app-key'
import { cliInternals } from '../src/cli-internals'
import { cleanupRuntimeDependencyLink, ensureRuntimeDependencyLink, runRuntimeInvocation } from '../src/runtime'
import { collectDiscoveryWatchRoots, isDiscoveryRelevantPath } from '../src/dev'
import { generatorInternals } from '../src/generators'
import { loadSecurityCliModule } from '../src/security'
import {
  bundleProjectModule,
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
  prepareProjectDiscovery,
  projectInternals,
  readTextFile,
  stripFileExtension,
  upsertProjectRegistration,
  writeProjectConfig,
  writeTextFile,
} from '../src/project'
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
  SCAFFOLD_NEXT_REACT_VERSIONS,
  SCAFFOLD_NUXT_DEPENDENCY_VERSIONS,
  SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS,
} from '../src/metadata'
import type { FSWatcher } from 'node:fs'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
type BuiltWorkspacePackages = {
  readonly root: string
  readonly adapterNextPackageRoot: string
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
}

const tempBuildRoots: string[] = []
let builtWorkspacePackages: BuiltWorkspacePackages | null = null
let fakePackageManagerBinRoot: string | null = null
const expectedHoloPackageRange = `^${HOLO_PACKAGE_VERSION}`
const expectedNextPackageRange = SCAFFOLD_FRAMEWORK_VERSIONS.next
const expectedReactPackageRange = SCAFFOLD_NEXT_REACT_VERSIONS.react
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

function writePackageWrapperSync(sourcePackageDir: string, targetPackageDir: string): void {
  mkdirSync(targetPackageDir, { recursive: true })
  writeFileSync(
    join(targetPackageDir, 'package.json'),
    readFileSync(join(sourcePackageDir, 'package.json'), 'utf8'),
    'utf8',
  )
}

function ensureFakePackageManagerBinRootSync(): string {
  if (fakePackageManagerBinRoot) {
    return fakePackageManagerBinRoot
  }

  const root = createTempBuildRootSync('holo-fake-package-manager-')
  for (const packageManager of ['bun', 'npm', 'pnpm', 'yarn']) {
    const binaryPath = join(root, packageManager)
    writeFileSync(binaryPath, `#!/bin/sh\nprintf 'fake ${packageManager} %s\\n' "$*"\nexit 0\n`, 'utf8')
    chmodSync(binaryPath, 0o755)
  }
  fakePackageManagerBinRoot = root
  return root
}

function linkPackageDependencySync(
  targetPackageDir: string,
  packageName: string,
  dependencyRoot: string,
): void {
  const dependencyPath = join(targetPackageDir, 'node_modules', ...packageName.split('/'))
  rmSync(dependencyPath, { recursive: true, force: true })
  mkdirSync(dirname(dependencyPath), { recursive: true })
  symlinkSync(dependencyRoot, dependencyPath)
}

function buildWorkspacePackageSync(filter: string, outDir: string) {
  return spawnSync('bun', ['run', '--filter', filter, 'build'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOLO_BUILD_OUT_DIR: outDir,
    },
  })
}

function ensureBuiltWorkspacePackagesSync(): BuiltWorkspacePackages {
  if (builtWorkspacePackages) {
    return builtWorkspacePackages
  }

  const root = createTempBuildRootSync('holo-cli-build-')
  const adapterNextPackageRoot = join(root, 'packages/adapter-next')
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

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/db-sqlite'), dbSqlitePackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(dbSqlitePackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/db-sqlite/package.json'),
  })
  const dbSqliteBuild = buildWorkspacePackageSync('@holo-js/db-sqlite', join(dbSqlitePackageRoot, 'dist'))
  expect(dbSqliteBuild.status, dbSqliteBuild.stderr || dbSqliteBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/db-postgres'), dbPostgresPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(dbPostgresPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/db-postgres/package.json'),
  })
  const dbPostgresBuild = buildWorkspacePackageSync('@holo-js/db-postgres', join(dbPostgresPackageRoot, 'dist'))
  expect(dbPostgresBuild.status, dbPostgresBuild.stderr || dbPostgresBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/db-mysql'), dbMysqlPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(dbMysqlPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/db-mysql/package.json'),
  })
  const dbMysqlBuild = buildWorkspacePackageSync('@holo-js/db-mysql', join(dbMysqlPackageRoot, 'dist'))
  expect(dbMysqlBuild.status, dbMysqlBuild.stderr || dbMysqlBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/db'), dbPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(dbPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/db/package.json'),
  })
  linkPackageDependencySync(dbPackageRoot, '@holo-js/db-sqlite', dbSqlitePackageRoot)
  linkPackageDependencySync(dbPackageRoot, '@holo-js/db-postgres', dbPostgresPackageRoot)
  linkPackageDependencySync(dbPackageRoot, '@holo-js/db-mysql', dbMysqlPackageRoot)
  const dbBuild = buildWorkspacePackageSync('@holo-js/db', join(dbPackageRoot, 'dist'))
  expect(dbBuild.status, dbBuild.stderr || dbBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/queue-redis'), queueRedisPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(queueRedisPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/queue-redis/package.json'),
  })
  const queueRedisBuild = buildWorkspacePackageSync('@holo-js/queue-redis', join(queueRedisPackageRoot, 'dist'))
  expect(queueRedisBuild.status, queueRedisBuild.stderr || queueRedisBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/queue'), queuePackageRoot)
  linkPackageDependencySync(queuePackageRoot, '@holo-js/queue-redis', queueRedisPackageRoot)
  const queueBuild = buildWorkspacePackageSync('@holo-js/queue', join(queuePackageRoot, 'dist'))
  expect(queueBuild.status, queueBuild.stderr || queueBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/queue-db'), queueDbPackageRoot)
  linkPackageDependencySync(queueDbPackageRoot, '@holo-js/db', dbPackageRoot)
  linkPackageDependencySync(queueDbPackageRoot, '@holo-js/queue', queuePackageRoot)
  const queueDbBuild = buildWorkspacePackageSync('@holo-js/queue-db', join(queueDbPackageRoot, 'dist'))
  expect(queueDbBuild.status, queueDbBuild.stderr || queueDbBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/events'), eventsPackageRoot)
  linkPackageDependencySync(eventsPackageRoot, '@holo-js/db', dbPackageRoot)
  linkPackageDependencySync(eventsPackageRoot, '@holo-js/queue', queuePackageRoot)
  const eventsBuild = buildWorkspacePackageSync('@holo-js/events', join(eventsPackageRoot, 'dist'))
  expect(eventsBuild.status, eventsBuild.stderr || eventsBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/config'), configPackageRoot)
  linkPackageDependencySync(configPackageRoot, '@holo-js/db', dbPackageRoot)
  linkPackageDependencySync(configPackageRoot, '@holo-js/queue', queuePackageRoot)
  const configBuild = buildWorkspacePackageSync('@holo-js/config', join(configPackageRoot, 'dist'))
  expect(configBuild.status, configBuild.stderr || configBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/validation'), validationPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(validationPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/validation/package.json'),
  })
  const validationBuild = buildWorkspacePackageSync('@holo-js/validation', join(validationPackageRoot, 'dist'))
  expect(validationBuild.status, validationBuild.stderr || validationBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/session'), sessionPackageRoot)
  linkPackageDependencySync(sessionPackageRoot, '@holo-js/config', configPackageRoot)
  const sessionBuild = buildWorkspacePackageSync('@holo-js/session', join(sessionPackageRoot, 'dist'))
  expect(sessionBuild.status, sessionBuild.stderr || sessionBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/security'), securityPackageRoot)
  linkPackageDependencySync(securityPackageRoot, '@holo-js/config', configPackageRoot)
  const securityBuild = buildWorkspacePackageSync('@holo-js/security', join(securityPackageRoot, 'dist'))
  expect(securityBuild.status, securityBuild.stderr || securityBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/auth'), authPackageRoot)
  linkPackageDependencySync(authPackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(authPackageRoot, '@holo-js/security', securityPackageRoot)
  linkPackageDependencySync(authPackageRoot, '@holo-js/validation', validationPackageRoot)
  const authBuild = buildWorkspacePackageSync('@holo-js/auth', join(authPackageRoot, 'dist'))
  expect(authBuild.status, authBuild.stderr || authBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/authorization'), authorizationPackageRoot)
  const authorizationBuild = buildWorkspacePackageSync('@holo-js/authorization', join(authorizationPackageRoot, 'dist'))
  expect(authorizationBuild.status, authorizationBuild.stderr || authorizationBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/cache'), cachePackageRoot)
  linkPackageDependencySync(cachePackageRoot, '@holo-js/config', configPackageRoot)
  const cacheBuild = buildWorkspacePackageSync('@holo-js/cache', join(cachePackageRoot, 'dist'))
  expect(cacheBuild.status, cacheBuild.stderr || cacheBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/cache-db'), cacheDbPackageRoot)
  linkPackageDependencySync(cacheDbPackageRoot, '@holo-js/cache', cachePackageRoot)
  linkPackageDependencySync(cacheDbPackageRoot, '@holo-js/db', dbPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(cacheDbPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/cache-db/package.json'),
  })
  const cacheDbBuild = buildWorkspacePackageSync('@holo-js/cache-db', join(cacheDbPackageRoot, 'dist'))
  expect(cacheDbBuild.status, cacheDbBuild.stderr || cacheDbBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/cache-redis'), cacheRedisPackageRoot)
  linkPackageDependencySync(cacheRedisPackageRoot, '@holo-js/cache', cachePackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(cacheRedisPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/cache-redis/package.json'),
  })
  const cacheRedisBuild = buildWorkspacePackageSync('@holo-js/cache-redis', join(cacheRedisPackageRoot, 'dist'))
  expect(cacheRedisBuild.status, cacheRedisBuild.stderr || cacheRedisBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/broadcast'), broadcastPackageRoot)
  linkPackageDependencySync(broadcastPackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(broadcastPackageRoot, '@holo-js/validation', validationPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(broadcastPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/broadcast/package.json'),
  })
  const broadcastBuild = buildWorkspacePackageSync('@holo-js/broadcast', join(broadcastPackageRoot, 'dist'))
  expect(broadcastBuild.status, broadcastBuild.stderr || broadcastBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/flux'), fluxPackageRoot)
  linkPackageDependencySync(fluxPackageRoot, '@holo-js/broadcast', broadcastPackageRoot)
  const fluxBuild = buildWorkspacePackageSync('@holo-js/flux', join(fluxPackageRoot, 'dist'))
  expect(fluxBuild.status, fluxBuild.stderr || fluxBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/flux-react'), fluxReactPackageRoot)
  linkPackageDependencySync(fluxReactPackageRoot, '@holo-js/broadcast', broadcastPackageRoot)
  linkPackageDependencySync(fluxReactPackageRoot, '@holo-js/flux', fluxPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(fluxReactPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/flux-react/package.json'),
  })
  const fluxReactBuild = buildWorkspacePackageSync('@holo-js/flux-react', join(fluxReactPackageRoot, 'dist'))
  expect(fluxReactBuild.status, fluxReactBuild.stderr || fluxReactBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/notifications'), notificationsPackageRoot)
  linkPackageDependencySync(notificationsPackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(notificationsPackageRoot, '@holo-js/queue', queuePackageRoot)
  const notificationsBuild = buildWorkspacePackageSync('@holo-js/notifications', join(notificationsPackageRoot, 'dist'))
  expect(notificationsBuild.status, notificationsBuild.stderr || notificationsBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/storage-s3'), storageS3PackageRoot)
  const storageS3Build = buildWorkspacePackageSync('@holo-js/storage-s3', join(storageS3PackageRoot, 'dist'))
  expect(storageS3Build.status, storageS3Build.stderr || storageS3Build.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/storage'), storagePackageRoot)
  linkPackageDependencySync(storagePackageRoot, '@holo-js/storage-s3', storageS3PackageRoot)
  const storageBuild = buildWorkspacePackageSync('@holo-js/storage', join(storagePackageRoot, 'dist'))
  expect(storageBuild.status, storageBuild.stderr || storageBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/mail'), mailPackageRoot)
  linkPackageDependencySync(mailPackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(mailPackageRoot, '@holo-js/queue', queuePackageRoot)
  linkPackageDependencySync(mailPackageRoot, '@holo-js/storage', storagePackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(mailPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/mail/package.json'),
  })
  const mailBuild = buildWorkspacePackageSync('@holo-js/mail', join(mailPackageRoot, 'dist'))
  expect(mailBuild.status, mailBuild.stderr || mailBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/media'), mediaPackageRoot)
  linkPackageDependencySync(mediaPackageRoot, '@holo-js/db', dbPackageRoot)
  linkPackageDependencySync(mediaPackageRoot, '@holo-js/queue', queuePackageRoot)
  linkPackageDependencySync(mediaPackageRoot, '@holo-js/storage', storagePackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(mediaPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/media/package.json'),
  })
  const mediaBuild = buildWorkspacePackageSync('@holo-js/media', join(mediaPackageRoot, 'dist'))
  expect(mediaBuild.status, mediaBuild.stderr || mediaBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/core'), corePackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(corePackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/core/package.json'),
  })
  linkPackageDependencySync(corePackageRoot, '@holo-js/auth', authPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/authorization', authorizationPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/cache', cachePackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/cache-db', cacheDbPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/cache-redis', cacheRedisPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/broadcast', broadcastPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/db', dbPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/events', eventsPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/flux', fluxPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/flux-react', fluxReactPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/mail', mailPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/media', mediaPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/notifications', notificationsPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/queue', queuePackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/queue-db', queueDbPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/security', securityPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/session', sessionPackageRoot)
  linkPackageDependencySync(corePackageRoot, '@holo-js/storage', storagePackageRoot)
  const coreBuild = buildWorkspacePackageSync('@holo-js/core', join(corePackageRoot, 'dist'))
  expect(coreBuild.status, coreBuild.stderr || coreBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/adapter-next'), adapterNextPackageRoot)
  linkPackageDependencySync(adapterNextPackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(adapterNextPackageRoot, '@holo-js/core', corePackageRoot)
  const adapterNextBuild = buildWorkspacePackageSync('@holo-js/adapter-next', join(adapterNextPackageRoot, 'dist'))
  expect(adapterNextBuild.status, adapterNextBuild.stderr || adapterNextBuild.stdout).toBe(0)

  writePackageWrapperSync(resolve(workspaceRoot, 'packages/cli'), cliPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/authorization', authorizationPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/cache', cachePackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/cache-db', cacheDbPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/cache-redis', cacheRedisPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/core', corePackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/config', configPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/db', dbPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/events', eventsPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/flux', fluxPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/flux-react', fluxReactPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/mail', mailPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/media', mediaPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/notifications', notificationsPackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/queue', queuePackageRoot)
  linkPackageDependencySync(cliPackageRoot, '@holo-js/queue-db', queueDbPackageRoot)
  linkInstalledDependenciesForPackageSync({
    repoRoot: workspaceRoot,
    nodeModulesRoot: join(cliPackageRoot, 'node_modules'),
    packageJsonPath: resolve(workspaceRoot, 'packages/cli/package.json'),
  })
  const cliBuild = buildWorkspacePackageSync('@holo-js/cli', join(cliPackageRoot, 'dist'))
  expect(cliBuild.status, cliBuild.stderr || cliBuild.stdout).toBe(0)

  builtWorkspacePackages = {
    root,
    adapterNextPackageRoot,
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
  }

  return builtWorkspacePackages
}

async function runWorkspacePackageBuild(filter: string) {
  const root = await mkdtemp(join(tmpdir(), 'holo-package-build-'))
  tempBuildRoots.push(root)
  const outDir = join(root, 'dist')
  const result = buildWorkspacePackageSync(filter, outDir)

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

type UserFlowDatabaseDriver = 'sqlite' | 'mysql' | 'postgres'

function quoteMySqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

async function importUserFlowMySQLDriver(): Promise<typeof HoloDbMysqlModule> {
  const { dbMysqlPackageRoot } = ensureBuiltWorkspacePackagesSync()

  return await import(pathToFileURL(join(dbMysqlPackageRoot, 'dist/index.mjs')).href) as typeof HoloDbMysqlModule
}

async function importUserFlowPostgresDriver(): Promise<typeof HoloDbPostgresModule> {
  const { dbPostgresPackageRoot } = ensureBuiltWorkspacePackagesSync()

  return await import(pathToFileURL(join(dbPostgresPackageRoot, 'dist/index.mjs')).href) as typeof HoloDbPostgresModule
}

async function dropUserFlowDatabase(driver: UserFlowDatabaseDriver, databaseName: string): Promise<void> {
  if (driver === 'sqlite') {
    await rm(databaseName, { force: true }).catch(() => {})
    return
  }

  if (driver === 'mysql') {
    const { createMySQLAdapter } = await importUserFlowMySQLDriver()
    const admin = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'mysql',
      },
    })

    try {
      await admin.execute(`drop database if exists ${quoteMySqlIdentifier(databaseName)}`)
    } finally {
      await admin.disconnect()
    }
    return
  }

  const { createPostgresAdapter } = await importUserFlowPostgresDriver()
  const admin = createPostgresAdapter({
    config: {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
    },
  })

  try {
    await admin.execute('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [databaseName])
    await admin.execute(`drop database if exists ${quotePostgresIdentifier(databaseName)}`)
  } finally {
    await admin.disconnect()
  }
}

async function expectUserFlowDatabaseExists(driver: UserFlowDatabaseDriver, databaseName: string): Promise<void> {
  if (driver === 'sqlite') {
    await expect(stat(databaseName)).resolves.toBeDefined()
    return
  }

  if (driver === 'mysql') {
    const { createMySQLAdapter } = await importUserFlowMySQLDriver()
    const admin = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'mysql',
      },
    })

    try {
      const result = await admin.query<{ SCHEMA_NAME: string }>(
        'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [databaseName],
      )
      expect(result.rows).toEqual([{ SCHEMA_NAME: databaseName }])
    } finally {
      await admin.disconnect()
    }
    return
  }

  const { createPostgresAdapter } = await importUserFlowPostgresDriver()
  const admin = createPostgresAdapter({
    config: {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
    },
  })

  try {
    const result = await admin.query<{ datname: string }>(
      'select datname from pg_database where datname = $1',
      [databaseName],
    )
    expect(result.rows).toEqual([{ datname: databaseName }])
  } finally {
    await admin.disconnect()
  }
}

async function setUserFlowDatabaseEnv(
  projectRoot: string,
  driver: UserFlowDatabaseDriver,
  databaseName: string,
): Promise<void> {
  const envPath = join(projectRoot, '.env')
  const envContents = await readFile(envPath, 'utf8')
  const nextContents = envContents
    .replace(/^DB_DRIVER=.*$/m, `DB_DRIVER=${driver}`)
    .replace(/^DB_URL=.*$/m, `DB_URL=${driver === 'sqlite' ? databaseName : './storage/database.sqlite'}`)
    .replace(/^DB_DATABASE=.*$/m, `DB_DATABASE=${databaseName}`)

  await writeFile(envPath, nextContents, 'utf8')
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
  const fakePackageManagerRoot = ensureFakePackageManagerBinRootSync()
  linkWorkspaceFakeInstalledPackagesSync(projectRoot)

  return spawnSync('node', [cliBinPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakePackageManagerRoot}:${process.env.PATH ?? ''}`,
      ...(options.env ?? {}),
    },
  })
}

function linkWorkspaceFakeInstalledPackagesSync(projectRoot: string): void {
  const {
    adapterNextPackageRoot,
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

function runNpxHoloProcess(
  projectRoot: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const fakePackageManagerRoot = ensureFakePackageManagerBinRootSync()

  return spawnSync('npx', ['holo', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(projectRoot, 'node_modules/.bin')}:${fakePackageManagerRoot}:${process.env.PATH ?? ''}`,
      ...(options.env ?? {}),
    },
  })
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
import { defineDatabaseConfig } from '@holo-js/config'

export default defineDatabaseConfig({})
`)
  await linkWorkspaceConfig(dir)
  return dir
}

async function createTempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'holo-cli-dir-'))
}

async function writeProjectFile(projectRoot: string, relativePath: string, contents: string): Promise<void> {
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
  const { configPackageRoot } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await rm(join(targetDir, 'config'), { recursive: true, force: true }).catch(() => {})
  await mkdir(targetDir, { recursive: true })
  await linkWorkspaceEvents(projectRoot)
  await symlink(configPackageRoot, join(targetDir, 'config')).catch(() => {})
}

async function linkWorkspaceDb(projectRoot: string): Promise<void> {
  const { dbPackageRoot } = ensureBuiltWorkspacePackagesSync()
  const targetDir = join(projectRoot, 'node_modules', '@holo-js')
  await mkdir(targetDir, { recursive: true })
  await linkWorkspaceConfig(projectRoot)
  await rm(join(targetDir, 'db'), { recursive: true, force: true }).catch(() => {})
  await symlink(dbPackageRoot, join(targetDir, 'db')).catch(() => {})
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

async function writeFrameworkBinary(projectRoot: string, binaryName: string): Promise<void> {
  await linkWorkspaceAuthFlowPackages(projectRoot)
  await writeFrameworkBinaryScript(projectRoot, binaryName, '#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(" "))\n')
}

async function writeFrameworkBinaryScript(projectRoot: string, binaryName: string, script: string): Promise<void> {
  const binPath = join(projectRoot, 'node_modules', '.bin', binaryName)
  await mkdir(dirname(binPath), { recursive: true })
  await writeFile(binPath, script, 'utf8')
  await chmod(binPath, 0o755)
}

async function withFakeBun<T>(callback: () => Promise<T>): Promise<T> {
  const fakeBinRoot = await mkdtemp(join(tmpdir(), 'holo-fake-bun-'))
  const fakeBunPath = join(fakeBinRoot, 'bun')
  const originalPath = process.env.PATH

  await writeFile(fakeBunPath, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(fakeBunPath, 0o755)
  process.env.PATH = `${fakeBinRoot}:${originalPath ?? ''}`

  try {
    return await callback()
  } finally {
    process.env.PATH = originalPath
    await rm(fakeBinRoot, { recursive: true, force: true })
  }
}

async function withFakePackageManagers<T>(callback: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH
  process.env.PATH = `${ensureFakePackageManagerBinRootSync()}:${originalPath ?? ''}`

  try {
    return await callback()
  } finally {
    process.env.PATH = originalPath
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  projectInternals.resetProjectModuleBundlerForTesting()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

afterAll(async () => {
  for (const root of tempBuildRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('Holo CLI', () => {
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
    expect(listed.stdout).toContain('Internal Commands')
    expect(listed.stdout).toContain('holo make:broadcast <name>')
    expect(listed.stdout).toContain('holo make:channel <pattern>')
    expect(listed.stdout).toContain('holo make:job <name>')
    expect(listed.stdout).toContain('holo make:mail <name> [--markdown]')
    expect(listed.stdout).toContain('holo make:model <name>')
    expect(listed.stdout).toContain('App Commands')
    expect(listed.stdout).toContain('holo courses:reindex')

    const executed = runCliProcess(projectRoot, ['courses:reindex'])
    expect(executed.status).toBe(0)
    expect(executed.stdout).toContain('courses reindexed')
  }, 90000)

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
    const keyCommand = cliInternals.createInternalCommands({
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
    const skippedKeyCommand = cliInternals.createInternalCommands({
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

  it('scaffolds a new project non-interactively with deterministic files', async () => {
    const targetRoot = await createTempDirectory()
    tempDirs.push(targetRoot)

    const result = runCliProcess(targetRoot, [
      'new',
      'demo-app',
      '--framework',
      'next',
      '--database',
      'postgres',
      '--package-manager',
      'pnpm',
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Created Holo project:')
    expect(result.stdout).toContain('fake pnpm install')
    expect(result.stdout).toContain('  - installed dependencies')
    expect(result.stdout).toContain('Next steps')
    expect(result.stdout).not.toContain('\n  pnpm install\n')
    expect(result.stdout).toContain('pnpm dev')

    const projectRoot = join(targetRoot, 'demo-app')
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      name: 'demo-app',
      packageManager: 'pnpm@latest',
      scripts: {
        prepare: 'holo key:generate && holo prepare',
        dev: 'holo dev',
        build: 'holo build',
        ['config:cache']: 'holo config:cache',
        ['config:clear']: 'holo config:clear',
        ['holo:dev']: 'node ./.holo-js/framework/run.mjs dev',
        ['holo:build']: 'node ./.holo-js/framework/run.mjs build',
      },
      dependencies: {
        'next': expectedNextPackageRange,
        'react': expectedReactPackageRange,
        'react-dom': expectedReactPackageRange,
        '@holo-js/adapter-next': expectedHoloPackageRange,
        '@holo-js/cli': expectedHoloPackageRange,
        '@holo-js/config': expectedHoloPackageRange,
        '@holo-js/core': expectedHoloPackageRange,
        '@holo-js/db': expectedHoloPackageRange,
      },
    })
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('.env.production')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('DB_PASSWORD=')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('APP_NAME=')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('APP_NAME="demo-app"')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('DB_DRIVER=postgres')
    expect(await readFile(join(projectRoot, 'config/app.ts'), 'utf8')).toContain(`name: env('APP_NAME', "demo-app")`)
    expect(await readFile(join(projectRoot, 'config/app.ts'), 'utf8')).toContain(`const appEnv = env('APP_ENV') === 'production'`)
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('STORAGE_DEFAULT_DISK=')
    expect(await readFile(join(projectRoot, 'config/app.ts'), 'utf8')).toContain('server/models')
    expect(await readFile(join(projectRoot, 'config/app.ts'), 'utf8')).toContain('server/jobs')
    expect(await readFile(join(projectRoot, 'config/app.ts'), 'utf8')).toContain('server/events')
    expect(await readFile(join(projectRoot, 'config/app.ts'), 'utf8')).toContain('server/listeners')
    expect(await readFile(join(projectRoot, 'config/database.ts'), 'utf8')).toContain('driver: \'postgres\'')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).not.toContain('REDIS_HOST=')
    await expect(stat(join(projectRoot, 'config/queue.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'config/storage.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'config/media.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'server/jobs'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'server/events'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'server/listeners'))).rejects.toThrow()
    expect(await readFile(join(projectRoot, '.holo-js/framework/project.json'), 'utf8')).toContain('"framework": "next"')
    expect(await readFile(join(projectRoot, '.holo-js/framework/run.mjs'), 'utf8')).toContain('Missing framework binary')
    await expect(stat(join(projectRoot, 'app/api/holo/health/route.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, '.holo-js/generated/next/health-route.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'instrumentation.ts'))).rejects.toThrow()
    await expect(stat(join(projectRoot, 'server/holo.ts'))).rejects.toThrow()
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/holo.ts'), 'utf8')).toContain('createNextHoloHelpers')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/bootstrap.mjs'), 'utf8')).toContain('await holo.getApp()')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/holo.ts'), 'utf8')).not.toContain('schema.generated')
    expect(await readFile(join(projectRoot, 'app/layout.tsx'), 'utf8')).not.toContain('schema.generated')
    expect(await readFile(join(projectRoot, 'next.config.ts'), 'utf8')).toContain('nextConfig')
    expect(await readFile(join(projectRoot, 'tsconfig.json'), 'utf8')).toContain('next-env.d.ts')
    expect(await readFile(join(projectRoot, '.gitignore'), 'utf8')).toContain('.holo-js/generated')
    expect(await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')).toContain('Generated')

    const duplicateResult = runCliProcess(targetRoot, [
      'new',
      'demo-app',
      '--framework',
      'next',
      '--database',
      'postgres',
      '--package-manager',
      'pnpm',
    ])
    expect(duplicateResult.status).toBe(1)
    expect(duplicateResult.stderr).toContain('Refusing to scaffold into a non-empty directory')

    const secondRoot = await createTempDirectory()
    tempDirs.push(secondRoot)
    const secondResult = runCliProcess(secondRoot, [
      'new',
      'demo-app',
      '--framework',
      'next',
      '--database',
      'postgres',
      '--package-manager',
      'pnpm',
    ])
    expect(secondResult.status).toBe(0)

    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toBe(await readFile(join(secondRoot, 'demo-app/package.json'), 'utf8'))
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toBe(await readFile(join(secondRoot, 'demo-app/.env.example'), 'utf8'))
  }, 90000)

  it('installs every package target in fresh apps through the user npx entrypoint', async () => {
    const installCases: readonly {
      readonly name: string
      readonly args: readonly string[]
      readonly message: string
      readonly alreadyInstalledMessage: string
      readonly dependencies: readonly string[]
      readonly generatedFiles: readonly { readonly path: string, readonly contains: string }[]
      readonly envContains?: readonly string[]
      readonly envExampleContains?: readonly string[]
      readonly migrationSuffixes?: readonly string[]
      readonly stdoutContains?: readonly string[]
    }[] = [
      {
        name: 'queue',
        args: ['queue'],
        message: 'Installed queue support.',
        alreadyInstalledMessage: 'Queue support is already installed.',
        dependencies: ['@holo-js/queue'],
        generatedFiles: [
          { path: 'config/queue.ts', contains: 'default: \'sync\'' },
          { path: 'server/jobs', contains: '' },
        ],
      },
      {
        name: 'queue-redis',
        args: ['queue', '--driver', 'redis'],
        message: 'Installed queue support.',
        alreadyInstalledMessage: 'Queue support is already installed.',
        dependencies: ['@holo-js/queue', '@holo-js/queue-redis'],
        generatedFiles: [
          { path: 'config/queue.ts', contains: 'driver: \'redis\'' },
          { path: 'config/redis.ts', contains: 'defineRedisConfig' },
        ],
        envContains: ['REDIS_HOST=', 'REDIS_PORT='],
        envExampleContains: ['REDIS_HOST=', 'REDIS_PORT='],
      },
      {
        name: 'events',
        args: ['events'],
        message: 'Installed events support.',
        alreadyInstalledMessage: 'Events support is already installed.',
        dependencies: ['@holo-js/events'],
        generatedFiles: [
          { path: 'server/events', contains: '' },
          { path: 'server/listeners', contains: '' },
        ],
      },
      {
        name: 'auth',
        args: ['auth'],
        message: 'Installed auth support.',
        alreadyInstalledMessage: 'Auth support is already installed.',
        dependencies: ['@holo-js/auth', '@holo-js/session', '@holo-js/security'],
        generatedFiles: [
          { path: 'config/auth.ts', contains: 'defineAuthConfig' },
          { path: 'config/session.ts', contains: 'defineSessionConfig' },
          { path: 'config/security.ts', contains: 'defineSecurityConfig' },
          { path: 'config/cors.ts', contains: 'defineCorsConfig' },
          { path: 'server/models/User.ts', contains: 'defineModel(\'users\'' },
          { path: 'app/api/auth/user/route.ts', contains: 'import auth, { check, isAuthError, provider, user } from \'@holo-js/auth\'' },
        ],
        envContains: ['SESSION_DRIVER=file'],
        migrationSuffixes: [
          '_create_users.ts',
          '_create_sessions.ts',
          '_create_auth_identities.ts',
          '_create_personal_access_tokens.ts',
          '_create_password_reset_tokens.ts',
          '_create_email_verification_tokens.ts',
        ],
      },
      {
        name: 'authorization',
        args: ['authorization'],
        message: 'Installed authorization support.',
        alreadyInstalledMessage: 'Authorization support is already installed.',
        dependencies: ['@holo-js/authorization'],
        generatedFiles: [
          { path: 'server/policies/README.md', contains: 'Policies' },
          { path: 'server/abilities/README.md', contains: 'Abilities' },
        ],
      },
      {
        name: 'notifications',
        args: ['notifications'],
        message: 'Installed notifications support.',
        alreadyInstalledMessage: 'Notifications support is already installed.',
        dependencies: ['@holo-js/notifications'],
        generatedFiles: [
          { path: 'config/notifications.ts', contains: 'defineNotificationsConfig' },
        ],
        migrationSuffixes: ['_create_notifications.ts'],
      },
      {
        name: 'mail',
        args: ['mail'],
        message: 'Installed mail support.',
        alreadyInstalledMessage: 'Mail support is already installed.',
        dependencies: ['@holo-js/mail'],
        generatedFiles: [
          { path: 'config/mail.ts', contains: 'defineMailConfig' },
          { path: 'server/mail', contains: '' },
        ],
        envContains: ['MAIL_MAILER=preview'],
        envExampleContains: ['MAIL_MAILER='],
      },
      {
        name: 'broadcast',
        args: ['broadcast'],
        message: 'Installed broadcast support.',
        alreadyInstalledMessage: 'Broadcast support is already installed.',
        dependencies: ['@holo-js/broadcast', '@holo-js/flux', '@holo-js/flux-react'],
        generatedFiles: [
          { path: 'config/broadcast.ts', contains: 'defineBroadcastConfig' },
          { path: 'server/broadcast', contains: '' },
          { path: 'server/channels', contains: '' },
        ],
        envContains: ['BROADCAST_CONNECTION=holo'],
        envExampleContains: ['BROADCAST_CONNECTION=holo', 'BROADCAST_APP_ID='],
      },
      {
        name: 'security',
        args: ['security'],
        message: 'Installed security support.',
        alreadyInstalledMessage: 'Security support is already installed.',
        dependencies: ['@holo-js/security'],
        generatedFiles: [
          { path: 'config/security.ts', contains: 'defineSecurityConfig' },
          { path: 'config/cors.ts', contains: 'defineCorsConfig' },
        ],
      },
      {
        name: 'cache-file',
        args: ['cache'],
        message: 'Installed cache support.',
        alreadyInstalledMessage: 'Cache support is already installed.',
        dependencies: ['@holo-js/cache'],
        generatedFiles: [
          { path: 'config/cache.ts', contains: 'default: \'file\'' },
        ],
        envContains: ['CACHE_PREFIX='],
        envExampleContains: ['CACHE_PREFIX='],
      },
      {
        name: 'cache-redis',
        args: ['cache', '--driver', 'redis'],
        message: 'Installed cache support.',
        alreadyInstalledMessage: 'Cache support is already installed.',
        dependencies: ['@holo-js/cache', '@holo-js/cache-redis'],
        generatedFiles: [
          { path: 'config/cache.ts', contains: 'driver: \'redis\'' },
          { path: 'config/redis.ts', contains: 'defineRedisConfig' },
        ],
        envContains: ['CACHE_PREFIX=', 'REDIS_HOST=', 'REDIS_PORT='],
        envExampleContains: ['CACHE_PREFIX=', 'REDIS_HOST=', 'REDIS_PORT='],
      },
      {
        name: 'cache-database',
        args: ['cache', '--driver', 'database'],
        message: 'Installed cache support.',
        alreadyInstalledMessage: 'Cache support is already installed.',
        dependencies: ['@holo-js/cache', '@holo-js/cache-db'],
        generatedFiles: [
          { path: 'config/cache.ts', contains: 'driver: \'database\'' },
        ],
        envContains: ['CACHE_PREFIX='],
        envExampleContains: ['CACHE_PREFIX='],
        stdoutContains: ['run "holo cache:table" to create the cache tables'],
      },
      {
        name: 'media',
        args: ['media'],
        message: 'Installed media support.',
        alreadyInstalledMessage: 'Media support is already installed.',
        dependencies: ['@holo-js/media'],
        generatedFiles: [
          { path: 'config/media.ts', contains: 'defineMediaConfig' },
        ],
        migrationSuffixes: ['_create_media_table.ts'],
      },
    ]

    for (const installCase of installCases) {
      const targetRoot = await createTempDirectory()
      tempDirs.push(targetRoot)
      const projectName = `npx-${installCase.name}-app`
      await linkWorkspaceCli(targetRoot)

      const created = runNpxHoloProcess(targetRoot, [
        'new',
        projectName,
        '--framework',
        'next',
        '--database',
        'sqlite',
        '--package-manager',
        'npm',
      ])
      expect(created.status, created.stderr).toBe(0)
      expect(created.stdout).toContain('fake npm install')

      const projectRoot = join(targetRoot, projectName)
      await linkWorkspaceAuthFlowPackages(projectRoot)

      const installed = runNpxHoloProcess(projectRoot, ['install', ...installCase.args])
      expect(installed.status, installed.stderr || installed.stdout).toBe(0)
      expect(installed.stdout).toContain(installCase.message)
      expect(installed.stdout).toContain('fake npm install')
      expect(installed.stdout).toContain('  - installed dependencies')
      for (const expectedOutput of installCase.stdoutContains ?? []) {
        expect(installed.stdout).toContain(expectedOutput)
      }

      const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      for (const dependency of installCase.dependencies) {
        expect(packageJson.dependencies?.[dependency]).toBe(expectedHoloPackageRange)
      }

      for (const generatedFile of installCase.generatedFiles) {
        const path = join(projectRoot, generatedFile.path)
        const stats = await stat(path)
        expect(stats).toBeDefined()
        if (generatedFile.contains) {
          expect(await readFile(path, 'utf8')).toContain(generatedFile.contains)
        }
      }

      const env = await readFile(join(projectRoot, '.env'), 'utf8')
      for (const expectedEntry of installCase.envContains ?? []) {
        expect(env).toContain(expectedEntry)
      }
      const envExample = await readFile(join(projectRoot, '.env.example'), 'utf8')
      for (const expectedEntry of installCase.envExampleContains ?? []) {
        expect(envExample).toContain(expectedEntry)
      }

      if (installCase.migrationSuffixes) {
        const migrations = await readdir(join(projectRoot, 'server/db/migrations'))
        for (const suffix of installCase.migrationSuffixes) {
          const migration = migrations.find(entry => entry.endsWith(suffix))
          expect(migration, `missing migration ${suffix}`).toBeDefined()
          expect(await readFile(join(projectRoot, 'server/db/migrations', migration!), 'utf8')).toContain('defineMigration')
        }
      }

      const prepared = runNpxHoloProcess(projectRoot, ['prepare'])
      expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0)

      const rerun = runNpxHoloProcess(projectRoot, ['install', ...installCase.args])
      expect(rerun.status, rerun.stderr || rerun.stdout).toBe(0)
      expect(rerun.stdout).toContain(installCase.alreadyInstalledMessage)

      if (installCase.name === 'auth') {
        expect((await readdir(join(projectRoot, 'server/db/migrations'))).filter(entry => entry.endsWith('.ts'))).toHaveLength(6)
        await expect(stat(join(projectRoot, 'instrumentation.ts'))).rejects.toThrow()
        await expect(stat(join(projectRoot, 'server/holo.ts'))).rejects.toThrow()
        await expect(readFile(join(projectRoot, 'app/api/auth/user/route.ts'), 'utf8')).resolves.not.toContain('holo.getApp')
        await expect(readFile(join(projectRoot, 'app/api/auth/user/route.ts'), 'utf8')).resolves.not.toContain('.holo-js/generated')
        await expect(readFile(join(projectRoot, '.holo-js/generated/next/holo.ts'), 'utf8')).resolves.toContain('createNextHoloHelpers')
        await expect(readFile(join(projectRoot, '.holo-js/generated/next/bootstrap.mjs'), 'utf8')).resolves.toContain('await holo.getApp()')
        await expect(stat(join(projectRoot, '.holo-js/generated/next/auth-user-route.ts'))).rejects.toThrow()
      }

      if (installCase.name === 'media') {
        const migrations = await readdir(join(projectRoot, 'server/db/migrations'))
        expect(migrations.filter(entry => entry.endsWith('_create_media_table.ts'))).toHaveLength(1)
      }
    }
  }, 240000)

  const authUserFlowCases: readonly {
    readonly driver: UserFlowDatabaseDriver
    readonly enabled: boolean
  }[] = [
    { driver: 'sqlite', enabled: true },
    { driver: 'mysql', enabled: process.env.HOLO_MYSQL_INTEGRATION === '1' },
    { driver: 'postgres', enabled: process.env.HOLO_POSTGRES_INTEGRATION === '1' },
  ]

  for (const { driver, enabled } of authUserFlowCases) {
    const registerTest = enabled ? it : it.skip
    registerTest(`runs the fresh app auth user flow against ${driver}`, async () => {
      const targetRoot = await createTempDirectory()
      tempDirs.push(targetRoot)

      const projectName = `auth-flow-${driver}`
      const databaseName = driver === 'sqlite'
        ? join(targetRoot, `${projectName}.sqlite`)
        : `holo_user_flow_${driver}_${randomUUID().replaceAll('-', '_')}`

      await dropUserFlowDatabase(driver, databaseName)

      try {
        await linkWorkspaceCli(targetRoot)
        const created = runNpxHoloProcess(targetRoot, [
          'new',
          projectName,
          '--framework',
          'next',
          '--database',
          driver,
          '--package-manager',
          'npm',
        ])
        expect(created.status, created.stderr).toBe(0)

        const projectRoot = join(targetRoot, projectName)
        await linkWorkspaceAuthFlowPackages(projectRoot)
        await setUserFlowDatabaseEnv(projectRoot, driver, databaseName)

        const keyGenerated = runNpxHoloProcess(projectRoot, ['key:generate'])
        expect(keyGenerated.status, keyGenerated.stderr).toBe(0)
        expect(keyGenerated.stdout).toContain('Generated APP_KEY')

        const installed = runNpxHoloProcess(projectRoot, ['install', 'auth'])
        expect(installed.status, installed.stderr).toBe(0)
        expect(installed.stdout).toContain('Installed auth support.')
        expect(installed.stdout).toContain('created 6 auth migrations')
        expect(installed.stdout).toContain('fake npm install')
        expect(installed.stdout).toContain('  - installed dependencies')
        expect((await readdir(join(projectRoot, 'server/db/migrations'))).filter(entry => entry.endsWith('.ts'))).toHaveLength(6)
        await expect(stat(join(projectRoot, 'instrumentation.ts'))).rejects.toThrow()
        await expect(stat(join(projectRoot, 'server/holo.ts'))).rejects.toThrow()
        await expect(readFile(join(projectRoot, 'app/api/auth/user/route.ts'), 'utf8')).resolves.not.toContain('holo.getApp')
        await expect(readFile(join(projectRoot, 'app/api/auth/user/route.ts'), 'utf8')).resolves.not.toContain('.holo-js/generated')
        await expect(readFile(join(projectRoot, '.holo-js/generated/next/holo.ts'), 'utf8')).resolves.toContain('createNextHoloHelpers')
        await expect(readFile(join(projectRoot, '.holo-js/generated/next/bootstrap.mjs'), 'utf8')).resolves.toContain('await holo.getApp()')

        await writeProjectFile(projectRoot, 'server/commands/auth-flow.ts', `
export default {
  description: 'Run the generated auth user flow.',
  async run(context) {
    const { createHolo } = await import('@holo-js/core')
    const auth = (await import('@holo-js/auth')).default
    const app = await createHolo(context.projectRoot, { preferCache: false })
    const email = 'ava.${driver}@example.com'

    function unwrap(result) {
      if (!result) {
        throw new Error('Expected auth result.')
      }

      if (typeof result === 'object' && 'error' in result && result.error) {
        throw new Error(\`Auth failed with \${result.error.code}.\`)
      }

      return typeof result === 'object' && 'data' in result ? result.data : result
    }

    await app.initialize()

    try {
      const registered = unwrap(await auth.register({
        name: 'Ava',
        email,
        password: 'secret-secret',
        passwordConfirmation: 'secret-secret',
      }))
      const loggedIn = unwrap(await auth.login({
        email,
        password: 'secret-secret',
      }))
      const current = await auth.user()
      const authenticated = await auth.check()
      const loggedOut = await auth.logout()
      console.log(JSON.stringify({
        registeredEmail: registered.email,
        loginGuard: loggedIn.guard,
        currentEmail: current?.email,
        authenticated,
        logoutGuard: loggedOut.guard,
      }))
    } finally {
      await app.shutdown()
    }
  },
}
`)

        const prepared = runNpxHoloProcess(projectRoot, ['prepare'])
        expect(prepared.status, prepared.stderr).toBe(0)
        await expect(stat(join(projectRoot, '.holo-js/generated/next/auth-user-route.ts'))).rejects.toThrow()

        const migratedFresh = runNpxHoloProcess(projectRoot, ['migrate:fresh'])
        expect(migratedFresh.status, migratedFresh.stderr).toBe(0)
        expect(migratedFresh.stdout).toContain('Migrations executed:')
        expect(migratedFresh.stdout).toContain('create_users')
        await expectUserFlowDatabaseExists(driver, databaseName)

        const migratedAgain = runNpxHoloProcess(projectRoot, ['migrate'])
        expect(migratedAgain.status, migratedAgain.stderr).toBe(0)
        expect(migratedAgain.stdout).toContain('No migrations were executed.')

        const authFlow = runNpxHoloProcess(projectRoot, ['auth-flow'])
        expect(authFlow.status, authFlow.stderr).toBe(0)
        expect(parseLastJsonLine<{
          registeredEmail: string
          loginGuard: string
          currentEmail: string
          authenticated: boolean
          logoutGuard: string
        }>(authFlow.stdout)).toEqual({
          registeredEmail: `ava.${driver}@example.com`,
          loginGuard: 'web',
          currentEmail: `ava.${driver}@example.com`,
          authenticated: true,
          logoutGuard: 'web',
        })

        const failed = runNpxHoloProcess(projectRoot, ['migrate'], {
          env: driver === 'sqlite'
            ? { DB_URL: join(targetRoot, 'missing-directory/database.sqlite') }
            : {
                DB_DATABASE: `holo_user_flow_failure_${driver}_${randomUUID().replaceAll('-', '_')}`,
                DB_PORT: '1',
              },
        })
        expect(failed.status).toBe(1)
        if (driver === 'sqlite') {
          expect(failed.stderr).toContain('Unable to open SQLite database')
        } else {
          expect(failed.stderr).toContain(`Unable to ensure ${driver === 'mysql' ? 'MySQL' : 'Postgres'} database`)
        }
        expect(failed.stderr).not.toContain('\n    at ')
      } finally {
        await dropUserFlowDatabase(driver, databaseName)
      }
    }, 180000)
  }

  it('covers the in-process new command and scaffold helpers directly', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    const io = createIo(baseRoot)
    await withFakePackageManagers(async () => {
      await expect(import('../src/cli').then(module => module.runCli([
        'new',
        'covered-app',
        '--framework',
        'next',
        '--database',
        'mysql',
        '--package-manager',
        'npm',
      ], io.io))).resolves.toBe(0)
    })

    const coveredRoot = join(baseRoot, 'covered-app')
    const newOutput = io.read().stdout
    expect(newOutput).toContain('Created Holo project:')
    expect(newOutput).toContain('fake npm install')
    expect(newOutput).toContain('  - installed dependencies')
    expect(newOutput).not.toContain('\n  npm install\n')
    expect(newOutput).toContain('npm run dev')
    expect(await readFile(join(coveredRoot, 'config/database.ts'), 'utf8')).toContain('driver: \'mysql\'')

    const directRoot = join(baseRoot, 'direct-app')
    await projectInternals.scaffoldProject(directRoot, {
      projectName: '!!!',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['forms'],
    })

    expect(await readFile(join(directRoot, 'storage/database.sqlite'), 'utf8')).toBe('')
    expect(await readFile(join(directRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/forms": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(directRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/validation": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(directRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')

    const optionalRoot = join(baseRoot, 'optional-runtime-app')
    await projectInternals.scaffoldProject(optionalRoot, {
      projectName: 'Optional Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage', 'queue', 'events'],
    })

    expect(await readFile(join(optionalRoot, 'config/queue.ts'), 'utf8')).toContain('driver: \'sync\'')
    expect(await readFile(join(optionalRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    expect(await readFile(join(optionalRoot, 'config/storage.ts'), 'utf8')).toContain('defineStorageConfig')
    expect(await stat(join(optionalRoot, 'server/events'))).toBeDefined()
    expect(await stat(join(optionalRoot, 'server/listeners'))).toBeDefined()

    const storageRoot = join(baseRoot, 'storage-runtime-app')
    await projectInternals.scaffoldProject(storageRoot, {
      projectName: 'Storage Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage'],
    })

    expect(await readFile(join(storageRoot, 'package.json'), 'utf8')).toContain('"@holo-js/storage":')
    expect(await readFile(join(storageRoot, 'config/storage.ts'), 'utf8')).toContain('defineStorageConfig')
    expect(await readFile(join(storageRoot, 'app/storage/[[...path]]/route.ts'), 'utf8')).toContain('.holo-js/generated/next/storage-route')
    expect(await readFile(join(storageRoot, 'app/storage/[[...path]]/route.ts'), 'utf8')).not.toContain('holo.getApp')
    expect(await readFile(join(storageRoot, '.holo-js/generated/next/storage-route.ts'), 'utf8')).toContain('createPublicStorageResponse')
    expect(await stat(join(storageRoot, 'storage/app/public'))).toBeDefined()
    await expect(stat(join(storageRoot, 'server/lib/public-storage.ts'))).rejects.toThrow()

    const queueRoot = join(baseRoot, 'queue-runtime-app')
    await projectInternals.scaffoldProject(queueRoot, {
      projectName: 'Queue Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['queue'],
    })

    expect(await readFile(join(queueRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(queueRoot, 'config/queue.ts'), 'utf8')).toContain('driver: \'sync\'')
    expect(await stat(join(queueRoot, 'server/jobs'))).toBeDefined()
    await expect(stat(join(queueRoot, 'server/events'))).rejects.toThrow()

    const eventsRoot = join(baseRoot, 'events-runtime-app')
    await projectInternals.scaffoldProject(eventsRoot, {
      projectName: 'Events Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['events'],
    })

    expect(await readFile(join(eventsRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/events": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(eventsRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    expect(await stat(join(eventsRoot, 'server/events'))).toBeDefined()
    expect(await stat(join(eventsRoot, 'server/listeners'))).toBeDefined()
    await expect(stat(join(eventsRoot, 'config/queue.ts'))).rejects.toThrow()

    const validationRoot = join(baseRoot, 'validation-runtime-app')
    await projectInternals.scaffoldProject(validationRoot, {
      projectName: 'Validation Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['validation'],
    })

    expect(await readFile(join(validationRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/validation": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(validationRoot, 'package.json'), 'utf8')).not.toContain(`"@holo-js/forms": "${expectedHoloPackageRange}"`)

    const authRoot = join(baseRoot, 'auth-runtime-app')
    await projectInternals.scaffoldProject(authRoot, {
      projectName: 'Auth Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    })

    expect(await readFile(join(authRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/auth": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(authRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/session": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(authRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/security": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(authRoot, 'config/auth.ts'), 'utf8')).toContain('guard: \'web\'')
    expect(await readFile(join(authRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    expect(await readFile(join(authRoot, 'config/auth.ts'), 'utf8')).toContain('identifiers: [\'email\']')
    expect(await readFile(join(authRoot, 'config/session.ts'), 'utf8')).toContain('defineSessionConfig')
    expect(await readFile(join(authRoot, '.env'), 'utf8')).toContain('SESSION_CONNECTION=main')
    expect(await readFile(join(authRoot, 'server/models/User.ts'), 'utf8')).toContain('hidden: [\'password\']')
    expect(await readFile(join(authRoot, 'app/api/auth/user/route.ts'), 'utf8')).toContain('import auth, { check, isAuthError, provider, user } from \'@holo-js/auth\'')
    expect(await readFile(join(authRoot, 'app/api/auth/user/route.ts'), 'utf8')).not.toContain('.holo-js/generated')
    expect(await readFile(join(authRoot, 'app/api/auth/user/route.ts'), 'utf8')).not.toContain('holo.getApp')
    expect(await readFile(join(authRoot, '.holo-js/generated/next/bootstrap.mjs'), 'utf8')).toContain('await holo.getApp()')
    await expect(stat(join(authRoot, '.holo-js/generated/next/auth-user-route.ts'))).rejects.toThrow()
    await expect(stat(join(authRoot, 'app/api/logout/route.ts'))).rejects.toThrow()
    await expect(stat(join(authRoot, 'proxy.ts'))).rejects.toThrow()
    await expect(stat(join(authRoot, 'server/notifications/auth/email-verification.ts'))).rejects.toThrow()
    await linkWorkspaceConfig(authRoot)
    await expect(projectInternals.installAuthIntoProject(authRoot, { workos: true, clerk: true })).resolves.toMatchObject({
      updatedPackageJson: true,
    })
    expect(await readFile(join(authRoot, 'app/api/auth/workos/callback/route.ts'), 'utf8')).toContain('.holo-js/generated/next/auth-workos-callback-route')
    expect(await readFile(join(authRoot, 'app/api/auth/clerk/callback/route.ts'), 'utf8')).toContain('.holo-js/generated/next/auth-clerk-callback-route')
    expect(await readFile(join(authRoot, '.holo-js/generated/next/auth-workos-callback-route.ts'), 'utf8')).toContain('completeWorkosAuth')
    expect(await readFile(join(authRoot, '.holo-js/generated/next/auth-clerk-callback-route.ts'), 'utf8')).toContain('completeClerkAuth')
    expect((await readdir(join(authRoot, 'server/db/migrations'))).filter(entry => entry.endsWith('.ts'))).toHaveLength(6)

    const authNotificationsRoot = join(baseRoot, 'auth-notifications-runtime-app')
    await projectInternals.scaffoldProject(authNotificationsRoot, {
      projectName: 'Auth Notifications Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth', 'notifications'],
    })

    expect(await readFile(join(authNotificationsRoot, 'server/notifications/auth/email-verification.ts'), 'utf8'))
      .toContain('export default defineNotification')
    expect(await readFile(join(authNotificationsRoot, 'server/notifications/auth/password-reset.ts'), 'utf8'))
      .toContain('export default defineNotification')
    expect(await readFile(join(authNotificationsRoot, 'server/notifications/auth/email-verification.ts'), 'utf8'))
      .toContain('auth.email-verification')
    expect(await readFile(join(authNotificationsRoot, 'server/notifications/auth/password-reset.ts'), 'utf8'))
      .toContain('auth.password-reset')

    const authorizationRoot = join(baseRoot, 'authorization-runtime-app')
    await projectInternals.scaffoldProject(authorizationRoot, {
      projectName: 'Authorization Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['authorization'],
    })

    expect(await readFile(join(authorizationRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/authorization": "${expectedHoloPackageRange}"`)
    expect((await stat(join(authorizationRoot, 'server/policies'))).isDirectory()).toBe(true)
    expect((await stat(join(authorizationRoot, 'server/abilities'))).isDirectory()).toBe(true)
    expect(await readFile(join(authorizationRoot, 'server/policies/README.md'), 'utf8')).toContain('Authorization Policies')
    expect(await readFile(join(authorizationRoot, 'server/abilities/README.md'), 'utf8')).toContain('Authorization Abilities')

    const mailRoot = join(baseRoot, 'mail-runtime-app')
    await projectInternals.scaffoldProject(mailRoot, {
      projectName: 'Mail Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['mail', 'notifications'],
    })

    expect(await readFile(join(mailRoot, 'config/mail.ts'), 'utf8')).toContain('defineMailConfig')
    expect(await readFile(join(mailRoot, 'config/notifications.ts'), 'utf8')).toContain('defineNotificationsConfig')
    expect(await readFile(join(mailRoot, '.env'), 'utf8')).toContain('DB_URL=./storage/database.sqlite\n\nMAIL_MAILER=preview')

    const notificationsRoot = join(baseRoot, 'notifications-runtime-app')
    await projectInternals.scaffoldProject(notificationsRoot, {
      projectName: 'Notifications Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['notifications'],
    })

    expect(await readFile(join(notificationsRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/notifications": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(notificationsRoot, 'config/notifications.ts'), 'utf8')).toContain('defineNotificationsConfig')
    expect(await readFile(join(notificationsRoot, '.env'), 'utf8')).not.toContain('MAIL_MAILER=')
    await expect(stat(join(notificationsRoot, 'config/mail.ts'))).rejects.toThrow()

    const standaloneMailRoot = join(baseRoot, 'standalone-mail-runtime-app')
    await projectInternals.scaffoldProject(standaloneMailRoot, {
      projectName: 'Standalone Mail Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['mail'],
    })

    expect(await readFile(join(standaloneMailRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/mail": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(standaloneMailRoot, 'config/mail.ts'), 'utf8')).toContain('defineMailConfig')
    expect(await readFile(join(standaloneMailRoot, '.env'), 'utf8')).toContain('DB_URL=./storage/database.sqlite\n\nMAIL_MAILER=preview')
    await expect(stat(join(standaloneMailRoot, 'config/notifications.ts'))).rejects.toThrow()

    const securityRoot = join(baseRoot, 'security-runtime-app')
    await projectInternals.scaffoldProject(securityRoot, {
      projectName: 'Security Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['security'],
    })

    expect(await readFile(join(securityRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/security": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(securityRoot, 'config/redis.ts'), 'utf8')).toContain('defineRedisConfig')
    expect(await readFile(join(securityRoot, 'config/security.ts'), 'utf8')).toContain(`import { defineSecurityConfig, limit } from '@holo-js/security'`)
    expect(await readFile(join(securityRoot, 'config/security.ts'), 'utf8')).toContain('connection: \'default\'')
    expect(await readFile(join(securityRoot, 'config/security.ts'), 'utf8')).toContain('login: limit.perMinute(5).define()')
    expect(await readFile(join(securityRoot, 'config/security.ts'), 'utf8')).toContain('register: limit.perHour(10).define()')
    expect(await stat(join(securityRoot, 'storage/framework/rate-limits'))).toBeDefined()
    await expect(readFile(join(securityRoot, 'storage/framework/rate-limits/.gitignore'), 'utf8')).resolves.toBe('*\n!.gitignore\n')

    const cacheRoot = join(baseRoot, 'cache-runtime-app')
    await projectInternals.scaffoldProject(cacheRoot, {
      projectName: 'Cache Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['cache'],
    })

    expect(await readFile(join(cacheRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(cacheRoot, 'config/cache.ts'), 'utf8')).toContain('defineCacheConfig')
    expect(await readFile(join(cacheRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'file\'')
    expect(await readFile(join(cacheRoot, '.env'), 'utf8')).toContain('CACHE_PREFIX=')
    expect(await readFile(join(cacheRoot, '.env.example'), 'utf8')).toContain('CACHE_PREFIX=')

    const broadcastRoot = join(baseRoot, 'broadcast-runtime-app')
    await projectInternals.scaffoldProject(broadcastRoot, {
      projectName: 'Broadcast Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })

    expect(await readFile(join(broadcastRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/broadcast": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(broadcastRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/flux": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(broadcastRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/flux-react": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(broadcastRoot, 'config/broadcast.ts'), 'utf8')).toContain('defineBroadcastConfig')
    expect(await readFile(join(broadcastRoot, 'config/broadcast.ts'), 'utf8')).not.toContain('authEndpoint:')
    expect(await readFile(join(broadcastRoot, '.env'), 'utf8')).toContain('BROADCAST_CONNECTION=holo')
    expect(await readFile(join(broadcastRoot, '.env.example'), 'utf8')).toContain('BROADCAST_APP_KEY=')
    expect((await stat(join(broadcastRoot, 'server/broadcast'))).isDirectory()).toBe(true)
    expect((await stat(join(broadcastRoot, 'server/channels'))).isDirectory()).toBe(true)
    await expect(stat(join(broadcastRoot, 'app/broadcasting/auth/route.ts'))).rejects.toThrow()

    const authBroadcastRoot = join(baseRoot, 'auth-broadcast-runtime-app')
    await projectInternals.scaffoldProject(authBroadcastRoot, {
      projectName: 'Auth Broadcast Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth', 'broadcast'],
    })

    expect(await readFile(join(authBroadcastRoot, 'config/broadcast.ts'), 'utf8')).toContain('authEndpoint:')
    expect(await readFile(join(authBroadcastRoot, 'app/broadcasting/auth/route.ts'), 'utf8')).toContain('.holo-js/generated/next/broadcast-auth-route')
    expect(await readFile(join(authBroadcastRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).toContain('renderBroadcastAuthResponse')

    expect(projectInternals.renderScaffoldPackageJson({
      projectName: '!!!',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).toContain('"name": "holo-app"')
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Optional App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['validation'],
    })).toContain(`"@holo-js/validation": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Optional App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['validation'],
    })).not.toContain(`"@holo-js/forms": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Forms App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['forms'],
    })).toContain(`"@holo-js/validation": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Optional Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage', 'events', 'queue'],
    })).toContain(`"@holo-js/storage": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Optional Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage', 'events', 'queue'],
    })).toContain(`"@holo-js/events": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Optional Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage', 'events', 'queue'],
    })).toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Optional Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'public',
      optionalPackages: ['storage', 'events', 'queue'],
    })).not.toContain(`"@holo-js/queue-db": "${expectedHoloPackageRange}"`)
    expect(JSON.parse(projectInternals.renderScaffoldPackageJson({
      projectName: 'Linted App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).devDependencies).toMatchObject({
      eslint: expect.any(String),
    })
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Broadcast Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })).toContain(`"@holo-js/broadcast": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Broadcast Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })).toContain(`"@holo-js/flux": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Broadcast Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })).toContain(`"@holo-js/flux-react": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Auth Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    })).toContain(`"@holo-js/auth": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Auth Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    })).toContain(`"@holo-js/session": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Auth Runtime App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    })).toContain(`"@holo-js/security": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldAppConfig('Typed App')).toContain("const appEnv = env('APP_ENV') === 'production'")
    expect(projectInternals.renderScaffoldAppConfig('Typed App')).toContain("env('APP_DEBUG', true)")
    expect(projectInternals.renderScaffoldAppConfig('Typed Svelte App', 'sveltekit')).toContain("url: env('APP_URL', 'http://localhost:5173')")
    expect(projectInternals.renderAuthConfig()).toContain('guard: \'web\'')
    expect(projectInternals.renderAuthConfig()).toContain('identifiers: [\'email\']')
    expect(projectInternals.renderAuthConfig()).not.toContain('defaultAbilities')
    expect(projectInternals.renderAuthConfig({ social: true })).toContain('AUTH_GOOGLE_CLIENT_ID')
    expect(projectInternals.renderAuthConfig({ socialProviders: ['linkedin'] })).toContain('AUTH_LINKEDIN_CLIENT_ID')
    expect(projectInternals.renderAuthConfig({ socialProviders: ['github', 'discord', 'facebook', 'apple'] })).toContain('read:user')
    expect(projectInternals.renderAuthConfig({ socialProviders: ['github', 'discord', 'facebook', 'apple'] })).toContain('identify')
    expect(projectInternals.renderAuthConfig({ socialProviders: ['github', 'discord', 'facebook', 'apple'] })).toContain('public_profile')
    expect(projectInternals.renderAuthConfig({ socialProviders: ['github', 'discord', 'facebook', 'apple'] })).toContain('\'name\', \'email\'')
    expect(projectInternals.renderAuthMigration('create_personal_access_tokens')).toContain('table.uuid(\'id\').primaryKey()')
    expect(projectInternals.renderAuthMigration('create_users')).toContain('table.string(\'email\').unique()')
    expect(projectInternals.renderAuthMigration('create_personal_access_tokens')).toContain('table.string(\'provider\').default(\'users\')')
    expect(projectInternals.renderAuthMigration('create_personal_access_tokens')).toContain('table.string(\'user_id\')')
    expect(projectInternals.renderAuthMigration('create_password_reset_tokens')).toContain('table.uuid(\'id\').primaryKey()')
    expect(projectInternals.renderAuthMigration('create_password_reset_tokens')).toContain('table.string(\'provider\').default(\'users\')')
    expect(projectInternals.renderAuthMigration('create_email_verification_tokens')).toContain('table.uuid(\'id\').primaryKey()')
    expect(projectInternals.renderAuthMigration('create_email_verification_tokens')).toContain('table.string(\'provider\').default(\'users\')')
    expect(projectInternals.renderAuthMigration('create_email_verification_tokens')).toContain('table.string(\'user_id\')')
    expect(projectInternals.renderAuthMigration('create_auth_identities')).toContain('table.string(\'user_id\')')
    expect(projectInternals.renderAuthConfig({ workos: true })).toContain('WORKOS_CLIENT_ID')
    expect(projectInternals.renderAuthConfig({ clerk: true })).toContain('CLERK_PUBLISHABLE_KEY')
    expect(projectInternals.renderAuthEnvFiles({ clerk: true }).env).toContain('CLERK_REDIRECT_URI=')
    const hostedAuthRoutes = [
      ...projectInternals.renderAuthProviderRouteFiles('next', { clerk: true }),
      ...projectInternals.renderAuthProviderRouteFiles('nuxt', { clerk: true }),
      ...projectInternals.renderAuthProviderRouteFiles('sveltekit', { clerk: true }),
    ].filter(file => file.path.includes('/callback'))
    expect(hostedAuthRoutes).toHaveLength(3)
    for (const route of hostedAuthRoutes) {
      expect(route.contents).not.toContain('/admin')
    }
    expect(hostedAuthRoutes.find(route => route.path.startsWith('app/'))?.contents).toContain('.holo-js/generated/next/auth-clerk-callback-route')
    expect(hostedAuthRoutes.find(route => route.path.startsWith('server/'))?.contents).toContain('sendRedirect(event, \'/\', 303)')
    expect(hostedAuthRoutes.find(route => route.path.startsWith('src/'))?.contents).toContain('completeClerkAuth')
    expect(projectInternals.renderAuthProviderRouteFiles('sveltekit', { clerk: true })
      .find(route => route.path === 'src/routes/api/auth/clerk/callback/+server.ts')?.contents).toContain('redirect(303, \'/\')')
    expect(projectInternals.authFeaturesRequireConfigUpdate({ socialProviders: ['google'] })).toBe(true)
    expect(projectInternals.detectAuthInstallFeaturesFromConfig(projectInternals.renderAuthConfig({
      workos: true,
      clerk: true,
    }))).toMatchObject({
      workos: true,
      clerk: true,
    })
    expect(projectInternals.renderAuthConfig()).not.toContain('AUTH_SOCIAL_ENCRYPTION_KEY')
    expect(projectInternals.renderAuthConfig()).not.toContain('currentUserEndpoint')
    expect(projectInternals.renderAuthEnvFiles({ socialProviders: ['linkedin'] }).env).toContain('AUTH_LINKEDIN_CLIENT_ID=')
    expect(projectInternals.renderAuthEnvFiles().env).not.toContain('AUTH_SOCIAL_ENCRYPTION_KEY=')
    expect(projectInternals.renderAuthEnvFiles().env).not.toContain('AUTH_CURRENT_USER_ENDPOINT=/api/auth/user')
    expect(projectInternals.renderAuthEnvFiles({}, 'primary').env).toContain('SESSION_CONNECTION=primary')
    expect(projectInternals.renderAuthEnvFiles().env).toContain('SESSION_DRIVER=file')
    expect(projectInternals.renderSessionConfig()).toContain('defineSessionConfig')
    expect(projectInternals.renderSessionConfig()).toContain('driver: env(\'SESSION_DRIVER\', \'file\')')
    expect(projectInternals.renderAuthUserModel()).toContain("export default defineModel('users', {")
    expect(projectInternals.renderStorageConfig()).toContain('defineStorageConfig')
    expect(projectInternals.renderMediaConfig()).toContain('defineMediaConfig')
    expect(projectInternals.renderQueueConfig({
      driver: 'sync',
      defaultDatabaseConnection: 'main',
    })).toContain('default: \'sync\'')
    expect(projectInternals.renderQueueConfig({
      driver: 'redis',
      defaultDatabaseConnection: 'main',
    })).toContain('connection: \'default\'')
    expect(projectInternals.renderRedisConfig()).toContain('defineRedisConfig')
    expect(projectInternals.renderQueueConfig({
      driver: 'database',
      defaultDatabaseConnection: 'main',
    })).toContain('driver: \'database\'')
    expect(projectInternals.renderQueueConfig()).toContain('failed: false')
    expect(projectInternals.renderCacheConfig('redis', 'main', 'cache')).toContain('connection: \'cache\'')
    expect(projectInternals.renderCacheConfig('database', 'main')).toContain('lockTable: \'cache_locks\'')
    expect(projectInternals.renderCacheEnvFiles('redis').env).toContain('REDIS_URL=')
    expect(projectInternals.renderCacheEnvFiles('file').env).toEqual(['CACHE_PREFIX='])
    expect(projectInternals.isSupportedCacheInstallerDriver('database')).toBe(true)
    expect(projectInternals.isSupportedCacheInstallerDriver('memcached')).toBe(false)
    expect(projectInternals.renderQueueEnvFiles('sync').env).toEqual([])
    expect(projectInternals.renderQueueEnvFiles('redis').env).toContain('REDIS_URL=')
    expect(projectInternals.renderQueueEnvFiles('redis').env).toContain('REDIS_HOST=127.0.0.1')
    expect(projectInternals.isSupportedQueueInstallerDriver('redis')).toBe(true)
    expect(projectInternals.isSupportedQueueInstallerDriver('sqs')).toBe(false)
    expect(projectInternals.renderScaffoldDatabaseConfig({
      projectName: 'sqlite-app',
      databaseDriver: 'sqlite',
    })).toContain('url: env(\'DB_URL\', \'./storage/database.sqlite\')')
    expect(projectInternals.renderScaffoldDatabaseConfig({
      projectName: 'postgres-app',
      databaseDriver: 'postgres',
    })).toContain('schema: env(\'DB_SCHEMA\', \'public\')')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'mysql-app',
      databaseDriver: 'mysql',
      storageDefaultDisk: 'public',
    }).env).toContain('DB_PORT=3306')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'postgres-app',
      databaseDriver: 'postgres',
      storageDefaultDisk: 'local',
    }).env).toContain('DB_SCHEMA=public')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: '!!!',
      databaseDriver: 'mysql',
      storageDefaultDisk: 'local',
    }).env).toContain('DB_DATABASE=holo_app')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Auth App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).env).toContain('SESSION_CONNECTION=main')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
    }).env).toContain('APP_URL=http://localhost:5173')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
    }).env).not.toContain('MAIL_MAILER=preview')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
    }).env).not.toContain('MAIL_USERNAME=')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
    }).example).not.toContain('MAIL_FROM_ADDRESS=')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['mail'],
    }).env).toContain('MAIL_MAILER=preview')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['mail'],
    }).env).toContain('MAIL_USERNAME=')
    expect(projectInternals.renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['mail'],
    }).example).toContain('MAIL_FROM_ADDRESS=')
    expect(projectInternals.renderMailConfig()).toContain('logBodies: env(\'MAIL_LOG_BODIES\', false)')
    expect(projectInternals.renderMailConfig()).toContain('user: env(\'MAIL_USERNAME\') || undefined')
    expect(projectInternals.renderMailConfig()).toContain('password: env(\'MAIL_PASSWORD\') || undefined')
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'nuxt-broadcast-app',
      framework: 'nuxt',
      packageManager: 'bun',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })).toContain('@holo-js/flux-vue')
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'svelte-broadcast-app',
      framework: 'sveltekit',
      packageManager: 'bun',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['broadcast'],
    })).toContain('@holo-js/flux-svelte')
    expect(projectInternals.resolveDefaultDatabaseUrl('sqlite')).toBe('./storage/database.sqlite')
    expect(projectInternals.resolveDefaultDatabaseUrl('postgres')).toBeUndefined()
    expect(projectInternals.resolveProjectPackageImportSpecifier(
      '/tmp/project',
      '@holo-js/queue',
      () => '/tmp/project/node_modules/@holo-js/queue/dist/index.mjs',
    )).toBe(pathToFileURL('/tmp/project/node_modules/@holo-js/queue/dist/index.mjs').href)
    expect(projectInternals.resolveProjectPackageImportSpecifier(
      '/tmp/project',
      '@holo-js/queue',
      () => '/tmp/.bun/install/cache/@holo-js/queue/dist/index.mjs',
    )).toBe(pathToFileURL('/tmp/.bun/install/cache/@holo-js/queue/dist/index.mjs').href)
    expect(projectInternals.resolveProjectPackageImportSpecifier('/tmp/project', '@holo-js/queue', () => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' })
    })).toContain('/packages/queue/dist/index.mjs')
    expect(projectInternals.resolveProjectPackageImportSpecifier('/tmp/project', '@holo-js/security/drivers/redis-adapter', () => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' })
    })).toContain('/packages/security/dist/drivers/redis-adapter.mjs')
    expect(projectInternals.resolveProjectPackageImportSpecifier('/tmp/project', 'left-pad', () => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' })
    })).toBe('left-pad')
    expect(projectInternals.resolveProjectPackageImportSpecifier('/tmp/project', '@holo-js/', () => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' })
    })).toBe('@holo-js/')
    expect(projectInternals.resolveProjectPackageImportSpecifier('/tmp/project', '@holo-js/not-a-real-package', () => {
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' })
    })).toBe('@holo-js/not-a-real-package')
    expect(projectInternals.inferDatabaseDriverFromUrl('postgres://localhost/app')).toBe('postgres')
    expect(projectInternals.inferDatabaseDriverFromUrl('mysql2://localhost/app')).toBe('mysql')
    expect(projectInternals.inferDatabaseDriverFromUrl('./storage/database.sqlite')).toBe('sqlite')
    expect(projectInternals.inferDatabaseDriverFromUrl('../storage/database.sqlite3')).toBe('sqlite')
    expect(projectInternals.inferDatabaseDriverFromUrl(undefined)).toBeUndefined()
    expect(projectInternals.inferDatabaseDriverFromUrl('sqlserver://localhost/app')).toBeUndefined()
    expect(projectInternals.inferConnectionDriver('postgresql://localhost/app')).toBe('postgres')
    expect(projectInternals.inferConnectionDriver('sqlserver://localhost/app')).toBeUndefined()
    expect(projectInternals.inferConnectionDriver({ driver: 'mysql' })).toBe('mysql')
    expect(projectInternals.inferConnectionDriver({ filename: './storage/data.sqlite' })).toBe('sqlite')
    expect(projectInternals.inferConnectionDriver({ url: 'sqlserver://localhost/app' })).toBeUndefined()
    expect(projectInternals.hasLoadedConfigFile([
      '/tmp/example/config/queue.ts',
      '/tmp/example/config/storage.mjs',
    ], 'queue')).toBe(true)
    expect(projectInternals.hasLoadedConfigFile([
      '/tmp/example/config/storage.mjs',
    ], 'queue')).toBe(false)
    expect(projectInternals.renderFrameworkRunner({
      framework: 'nuxt',
    })).toContain('Missing framework binary')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Next App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['storage'],
    }).find(file => file.path === 'next.config.ts')?.contents).toContain('withHolo')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Next App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['storage'],
    }).find(file => file.path === 'app/storage/[[...path]]/route.ts')?.contents).toContain('.holo-js/generated/next/storage-route')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Next App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['storage'],
    }).find(file => file.path === '.holo-js/generated/next/storage-route.ts')?.contents).toContain('createPublicStorageResponse')
    const svelteFrameworkPaths = projectInternals.renderFrameworkFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    }).map(file => file.path)
    expect(svelteFrameworkPaths).not.toContain('src/routes/api/holo/health/+server.ts')
    expect(svelteFrameworkPaths).toContain('.holo-js/generated/sveltekit/holo.ts')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    }).find(file => file.path === 'svelte.config.js')?.contents).toContain('@sveltejs/vite-plugin-svelte')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    }).find(file => file.path === 'svelte.config.js')?.contents).toContain('withHoloSvelteKit')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    }).find(file => file.path === 'src/hooks.ts')?.contents).toContain('export {}')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    }).find(file => file.path === 'src/hooks.server.ts')?.contents).toContain('export {}')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    }).find(file => file.path === '.holo-js/generated/sveltekit/holo.ts')?.contents).toContain('@holo-js/adapter-sveltekit')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Next Auth App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)).toEqual(expect.arrayContaining([
      'app/api/auth/user/route.ts',
    ]))
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Next Auth App',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)).not.toEqual(expect.arrayContaining([
      'app/api/logout/route.ts',
      'proxy.ts',
    ]))
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Nuxt Auth App',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)).toEqual(expect.arrayContaining([
      'server/api/auth/user.get.ts',
    ]))
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Nuxt Auth App',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)).not.toEqual(expect.arrayContaining([
      'server/api/logout.post.ts',
      'app/middleware/auth-only.global.ts',
      'app/middleware/guest-only.global.ts',
    ]))
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte Auth App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)).not.toContain('src/routes/api/auth/user/+server.ts')
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte Auth App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).map(file => file.path)).not.toEqual(expect.arrayContaining([
      'src/routes/api/logout/+server.ts',
    ]))
    expect(projectInternals.renderFrameworkFiles({
      projectName: 'Svelte Auth App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['auth'],
    }).find(file => file.path === 'src/hooks.server.ts')?.contents).toContain('export {}')
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).toContain(`"@sveltejs/vite-plugin-svelte": "${expectedSvelteVitePluginPackageRange}"`)
    expect(JSON.parse(projectInternals.renderScaffoldPackageJson({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).devDependencies).toMatchObject({
      'svelte-check': expectedSvelteCheckPackageRange,
    })
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: ['storage'],
    })).toContain(`"@holo-js/storage": "${expectedHoloPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Nuxt App',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).toContain(`"vue-router": "${expectedVueRouterPackageRange}"`)
    expect(projectInternals.renderScaffoldPackageJson({
      projectName: 'Svelte App',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
      optionalPackages: [],
    })).toContain(`"esbuild": "${ESBUILD_PACKAGE_VERSION}"`)
    expect(projectInternals.renderScaffoldTsconfig({
      framework: 'next',
    })).toContain('next-env.d.ts')
    expect(projectInternals.renderScaffoldTsconfig({
      framework: 'next',
    })).toContain('.holo-js/generated/**/*.d.ts')
    expect(projectInternals.renderScaffoldTsconfig({
      framework: 'nuxt',
    })).toContain('"extends": "./.nuxt/tsconfig.json"')
    expect(projectInternals.renderScaffoldTsconfig({
      framework: 'nuxt',
    })).not.toContain('"include"')
    expect(projectInternals.renderScaffoldTsconfig({
      framework: 'nuxt',
    })).not.toContain('"compilerOptions"')
    expect(projectInternals.renderVSCodeSettings({
      framework: 'nuxt',
    })).toContain('"typescript.tsdk": "node_modules/typescript/lib"')
    expect(projectInternals.renderVSCodeSettings({
      framework: 'nuxt',
    })).toContain('"vue.server.hybridMode": true')
    expect(projectInternals.renderVSCodeSettings({
      framework: 'next',
    })).toBeUndefined()
    const svelteTsconfig = JSON.parse(projectInternals.renderScaffoldTsconfig({
      framework: 'sveltekit',
    })) as {
      compilerOptions?: {
        baseUrl?: string
        paths?: Record<string, string[]>
      }
    }
    expect(svelteTsconfig.compilerOptions?.baseUrl).toBeUndefined()
    expect(svelteTsconfig.compilerOptions?.paths).toBeUndefined()
    expect(projectInternals.resolvePackageManagerVersion('bun')).toBe('bun@1.3.9')
    expect(projectInternals.resolvePackageManagerVersion('npm')).toBe('npm@latest')
    expect(projectInternals.resolvePackageManagerVersion('pnpm')).toBe('pnpm@latest')
    expect(projectInternals.resolvePackageManagerVersion('yarn')).toBe('yarn@stable')
    expect(projectInternals.sanitizePackageName('My App')).toBe('my-app')
    expect(projectInternals.isSupportedScaffoldFramework('next')).toBe(true)
    expect(projectInternals.isSupportedScaffoldFramework('astro')).toBe(false)
    expect(projectInternals.isSupportedScaffoldPackageManager('pnpm')).toBe(true)
    expect(projectInternals.isSupportedScaffoldPackageManager('deno')).toBe(false)
    expect(projectInternals.isSupportedScaffoldStorageDisk('public')).toBe(true)
    expect(projectInternals.isSupportedScaffoldStorageDisk('s3')).toBe(false)
    expect(projectInternals.isSupportedScaffoldOptionalPackage('forms')).toBe(true)
    expect(projectInternals.isSupportedScaffoldOptionalPackage('storage')).toBe(true)
    expect(projectInternals.isSupportedScaffoldOptionalPackage('auth')).toBe(true)
    expect(projectInternals.isSupportedScaffoldOptionalPackage('authorization')).toBe(true)
    expect(projectInternals.normalizeScaffoldOptionalPackages(['forms'])).toEqual(['forms', 'validation'])
    expect(projectInternals.normalizeScaffoldOptionalPackages(['validation', 'forms', 'validation'])).toEqual(['forms', 'validation'])
    expect(projectInternals.normalizeScaffoldOptionalPackages(['validate', 'form', 'storage', 'queue', 'events', 'auth', 'authorization'])).toEqual([
      'auth',
      'authorization',
      'events',
      'forms',
      'queue',
      'storage',
      'validation',
    ])
    expect(() => projectInternals.normalizeScaffoldOptionalPackages(['wat'])).toThrow('Unsupported optional package: wat.')

    await writeProjectFile(baseRoot, 'occupied-direct/file.txt', 'taken')
    await expect(projectInternals.scaffoldProject(join(baseRoot, 'occupied-direct'), {
      projectName: 'occupied-direct',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    })).rejects.toThrow('Refusing to scaffold into a non-empty directory')

    const fallbackIo = createIo(baseRoot)
    const newCommand = cliInternals.createInternalCommands({
      ...fallbackIo.io,
      projectRoot: baseRoot,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }).find(command => command.name === 'new')

    expect(newCommand).toBeDefined()
    await expect(newCommand!.prepare?.({
      args: ['prepared-app'],
      flags: {
        package: ['forms', 'validation'],
      },
    }, {
      ...fallbackIo.io,
      projectRoot: baseRoot,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    })).resolves.toEqual({
      args: ['prepared-app'],
      flags: {
        'framework': 'nuxt',
        'database': 'sqlite',
        'package-manager': 'npm',
        'storage-default-disk': 'local',
        'package': ['forms', 'validation'],
      },
    })
    await withFakePackageManagers(async () => {
      await expect(newCommand!.run({
        projectRoot: baseRoot,
        cwd: baseRoot,
        args: ['fallback-app'],
        flags: {},
        loadProject: async () => ({ config: defaultProjectConfig() }),
      })).resolves.toBeUndefined()
    })
    expect(fallbackIo.read().stdout).toContain('Created Holo project:')

    const nuxtRoot = join(baseRoot, 'nuxt-runner')
    await projectInternals.scaffoldProject(nuxtRoot, {
      projectName: 'nuxt-runner',
      framework: 'nuxt',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    })
    await writeFrameworkBinary(nuxtRoot, 'nuxt')
    expect(runNodeScript(nuxtRoot, join(nuxtRoot, '.holo-js/framework/run.mjs'), ['dev']).stdout).toContain('dev')
    expect(await readFile(join(nuxtRoot, '.holo-js/framework/run.mjs'), 'utf8')).toContain("process.on('SIGTERM'")
    expect(await readFile(join(nuxtRoot, 'nuxt.config.ts'), 'utf8')).toContain('@holo-js/adapter-nuxt')
    expect(await readFile(join(nuxtRoot, 'package.json'), 'utf8')).toContain('"postinstall": "nuxt prepare"')
    expect(await readFile(join(nuxtRoot, 'app/app.vue'), 'utf8')).toContain('const appName = "nuxt-runner"')
    expect(await readFile(join(nuxtRoot, 'app/app.vue'), 'utf8')).not.toContain('<h1>nuxt-runner</h1>')
    expect(await stat(join(nuxtRoot, 'shared/.gitkeep'))).toBeDefined()
    await expect(stat(join(nuxtRoot, 'app.vue'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'pages'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'middleware'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'plugins'))).rejects.toThrow()
    expect(await readFile(join(nuxtRoot, '.holo-js/generated/model-registry.d.ts'), 'utf8')).toContain('schema.generated')
    expect(await readFile(join(nuxtRoot, 'nuxt.config.ts'), 'utf8')).not.toContain('import { defineNuxtConfig } from \'nuxt/config\'')
    await expect(stat(join(nuxtRoot, 'server/api/holo/health.get.ts'))).rejects.toThrow()
    expect(await readFile(join(nuxtRoot, 'tsconfig.json'), 'utf8')).toContain('"extends": "./.nuxt/tsconfig.json"')

    const nextRoot = join(baseRoot, 'next-runner')
    await projectInternals.scaffoldProject(nextRoot, {
      projectName: 'next-runner',
      framework: 'next',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    })
    await linkWorkspaceAuthFlowPackages(nextRoot)
    await writeFrameworkBinaryScript(nextRoot, 'next', [
      '#!/usr/bin/env node',
      'console.log(process.argv.slice(2).join(" "))',
      'console.log(process.env.NODE_OPTIONS ?? "")',
      '',
    ].join('\n'))
    const nextBootstrapPathMarker = '/.holo-js/generated/next/bootstrap.mjs'
    const nextBuildResult = runNodeScript(nextRoot, join(nextRoot, '.holo-js/framework/run.mjs'), ['build'])
    expect(nextBuildResult.status, nextBuildResult.stderr || nextBuildResult.stdout).toBe(0)
    expect(nextBuildResult.stdout).toContain('build')
    expect(nextBuildResult.stdout).toContain('--import=file://')
    expect(nextBuildResult.stdout).toContain(nextBootstrapPathMarker)
    const nextDevResult = runNodeScript(nextRoot, join(nextRoot, '.holo-js/framework/run.mjs'), ['dev'])
    expect(nextDevResult.status).toBe(0)
    expect(nextDevResult.stdout).toContain('dev')
    expect(nextDevResult.stdout).toContain('--import=file://')
    expect(nextDevResult.stdout).toContain(nextBootstrapPathMarker)
    await expect(stat(join(nextRoot, 'server/holo.ts'))).rejects.toThrow()
    expect(await readFile(join(nextRoot, '.holo-js/generated/next/holo.ts'), 'utf8')).not.toContain('schema.generated')
    expect(await readFile(join(nextRoot, 'app/layout.tsx'), 'utf8')).not.toContain('schema.generated')

    const svelteRoot = join(baseRoot, 'svelte-runner')
    await projectInternals.scaffoldProject(svelteRoot, {
      projectName: 'svelte-runner',
      framework: 'sveltekit',
      databaseDriver: 'sqlite',
      packageManager: 'bun',
      storageDefaultDisk: 'local',
    })
    await writeFrameworkBinary(svelteRoot, 'vite')
    expect(runNodeScript(svelteRoot, join(svelteRoot, '.holo-js/framework/run.mjs'), ['dev']).stdout).toContain('dev')
    await expect(stat(join(svelteRoot, 'src/lib/server/holo.ts'))).rejects.toThrow()
    expect(await readFile(join(svelteRoot, '.holo-js/generated/sveltekit/holo.ts'), 'utf8')).toContain('createSvelteKitHoloHelpers')
    expect(await readFile(join(svelteRoot, '.holo-js/generated/sveltekit/holo.ts'), 'utf8')).not.toContain('schema.generated')
    expect(await readFile(join(svelteRoot, 'src/hooks.ts'), 'utf8')).toContain('export {}')

    const missingBinary = runNodeScript(join(baseRoot, 'fallback-app'), join(baseRoot, 'fallback-app/.holo-js/framework/run.mjs'), ['dev'])
    expect(missingBinary.status).toBe(1)
    expect(missingBinary.stderr).toContain('Missing framework binary')

    const rootDir = await createTempDirectory()
    tempDirs.push(rootDir)
    const rootIo = createIo(rootDir)
    const rootCommand = cliInternals.createInternalCommands({
      ...rootIo.io,
      projectRoot: rootDir,
      registry: [],
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }).find(command => command.name === 'new')
    expect(rootCommand).toBeDefined()
    await withFakePackageManagers(async () => {
      await expect(rootCommand!.run({
        projectRoot: rootIo.io.cwd,
        cwd: rootIo.io.cwd,
        args: [],
        flags: {},
        loadProject: async () => ({ config: defaultProjectConfig() }),
      })).resolves.toBeUndefined()
    })
    expect(rootIo.read().stdout).toContain('Created Holo project:')

    // Cover injectBroadcastAuthEndpoint returning undefined (no regex match)
    expect(projectInternals.injectBroadcastAuthEndpoint('export default {}')).toBeUndefined()
    // Cover injectBroadcastAuthEndpoint returning value (already has authEndpoint)
    expect(projectInternals.injectBroadcastAuthEndpoint('authEndpoint: "x"')).toBe('authEndpoint: "x"')

    // Cover resolveBroadcastConfigTargetPath with non-ts/js extension (falls back to .ts)
    expect(projectInternals.resolveBroadcastConfigTargetPath('/project', 'config/app.json', 'esm')).toContain('broadcast.ts')
    // Cover resolveBroadcastConfigTargetPath with .js extension
    expect(projectInternals.resolveBroadcastConfigTargetPath('/project', 'config/app.js', 'esm')).toContain('broadcast.js')
    // Cover resolveBroadcastConfigTargetPath with cjs format
    expect(projectInternals.resolveBroadcastConfigTargetPath('/project', 'config/app.json', 'cjs')).toContain('broadcast.cjs')
  }, 90000)

  it('suppresses SvelteKit semver circular dependency warnings in the framework runner', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)

    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'sveltekit' }))
    await writeProjectFile(projectRoot, '.holo-js/framework/run.mjs', projectInternals.renderFrameworkRunner({ framework: 'sveltekit' }))
    await writeFrameworkBinaryScript(projectRoot, 'vite', [
      '#!/usr/bin/env node',
      'console.log(process.argv.slice(2).join(" "))',
      'console.warn(\'Circular dependency: ../../node_modules/.bun/semver@7.7.4/node_modules/semver/classes/range.js -> ../../node_modules/.bun/semver@7.7.4/node_modules/semver/classes/comparator.js -> ../../node_modules/.bun/semver@7.7.4/node_modules/semver/classes/range.js\')',
      'console.warn(\'framework warning\')',
      '',
    ].join('\n'))

    const result = runNodeScript(projectRoot, join(projectRoot, '.holo-js/framework/run.mjs'), ['build'])

    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('build --logLevel error')
    expect(result.stderr).not.toContain('Circular dependency:')
    expect(result.stderr).toContain('framework warning')
  })

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

  it('scaffolds a new project with cache support through the CLI', async () => {
    const targetRoot = await createTempDirectory()
    tempDirs.push(targetRoot)

    const result = runCliProcess(targetRoot, [
      'new',
      'cached-app',
      '--framework',
      'next',
      '--database',
      'sqlite',
      '--package-manager',
      'bun',
      '--package',
      'cache',
    ])

    expect(result.status).toBe(0)
    const projectRoot = join(targetRoot, 'cached-app')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'file\'')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('CACHE_PREFIX=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('CACHE_PREFIX=')
  }, 30_000)

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
    expect(await readFile(join(projectRoot, 'config/queue.ts'), 'utf8')).toContain('default: \'sync\'')
    expect(await readFile(join(projectRoot, 'config/queue.ts'), 'utf8')).toContain('failed: false')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toBe('APP_NAME=Fixture\n')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toBe('APP_NAME=\n')
    await expect(stat(join(projectRoot, 'server/jobs'))).resolves.toBeDefined()

    const rerun = runCliProcess(projectRoot, ['install', 'queue'])
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain('Queue support is already installed.')
  }, 90000)

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
  }, 90000)

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
    expect(result.stdout).toContain('created 6 auth migrations')

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
    expect((await readdir(join(projectRoot, 'server/db/migrations'))).filter(entry => entry.endsWith('.ts'))).toHaveLength(6)

    const rerun = runCliProcess(projectRoot, ['install', 'auth'])
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain('Auth support is already installed.')
  }, 90000)


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
  }, 90000)

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
import { defineSessionConfig } from '@holo-js/config'

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
    expect(await readFile(join(projectRoot, 'config/auth.ts'), 'utf8')).toContain('guard: \'web\'')
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
    expect(initial.createdMigrationFiles).toHaveLength(6)
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
import { defineSessionConfig } from '@holo-js/config'

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
import { defineAuthConfig } from '@holo-js/config'

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
import { defineDatabaseConfig } from '@holo-js/config'

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
    expect(unsupportedTarget.stderr).toContain('Unsupported install target: mailer. Expected one of queue, events, auth, authorization, notifications, mail, broadcast, security, cache, media.')

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
  }, 30000)

  it('covers the install command and queue installer helpers in-process', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.env', '# existing\nexport REDIS_HOST=cache.internal\nIGNORED\n')
    await writeProjectFile(projectRoot, '.env.example', 'APP_NAME=\n')

    const installCommandIo = createIo(projectRoot)
    const commandContext = {
      ...installCommandIo.io,
      projectRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const installCommand = cliInternals.createInternalCommands(commandContext as never)
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
      updatedEnv: false,
      updatedEnvExample: false,
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
import { defineQueueConfig } from '@holo-js/config'

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
import { defineRedisConfig } from '@holo-js/config'

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
      updatedEnv: false,
      updatedEnvExample: false,
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
    linkWorkspaceFakeInstalledPackagesSync(runRoot)
    await writeProjectFile(runRoot, '.env', 'APP_NAME=Run\n')
    await writeProjectFile(runRoot, '.env.example', 'APP_NAME=\n')
    const runIo = createIo(runRoot)
    const runCommandContext = {
      ...runIo.io,
      projectRoot: runRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const runInstallCommand = cliInternals.createInternalCommands(runCommandContext as never)
      .find(command => command.name === 'install')

    await expect(runInstallCommand?.run({
      projectRoot: runRoot,
      cwd: runRoot,
      args: ['queue'],
      flags: {},
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(runIo.read().stdout).toContain('Installed queue support.')
    expect(runIo.read().stdout).toContain('created config/queue.ts')

    const rerunIo = createIo(runRoot)
    const rerunContext = {
      ...rerunIo.io,
      projectRoot: runRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const rerunInstallCommand = cliInternals.createInternalCommands(rerunContext as never)
      .find(command => command.name === 'install')
    await expect(rerunInstallCommand?.run({
      projectRoot: runRoot,
      cwd: runRoot,
      args: ['queue'],
      flags: { driver: 'sync' },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(rerunIo.read().stdout).toContain('Queue support is already installed.')

    const redisRunRoot = await createTempProject()
    tempDirs.push(redisRunRoot)
    linkWorkspaceFakeInstalledPackagesSync(redisRunRoot)
    await writeProjectFile(redisRunRoot, '.env', 'APP_NAME=Redis')
    await writeProjectFile(redisRunRoot, '.env.example', 'APP_NAME=\n')
    const redisRunIo = createIo(redisRunRoot)
    const redisRunContext = {
      ...redisRunIo.io,
      projectRoot: redisRunRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const redisInstallCommand = cliInternals.createInternalCommands(redisRunContext as never)
      .find(command => command.name === 'install')
    await expect(redisInstallCommand?.run({
      projectRoot: redisRunRoot,
      cwd: redisRunRoot,
      args: ['queue'],
      flags: { driver: 'redis' },
      loadProject: async () => ({ config: defaultProjectConfig() }),
    } as never)).resolves.toBeUndefined()
    expect(redisRunIo.read().stdout).toContain('updated .env')
    expect(redisRunIo.read().stdout).toContain('updated .env.example')
    const redisEnv = await readFile(join(redisRunRoot, '.env'), 'utf8')
    expect(redisEnv).toContain('APP_NAME=Redis')
    expect(redisEnv).toMatch(/\nREDIS_URL=/)
    expect(redisEnv).toContain('REDIS_HOST=127.0.0.1')

    const authProviderRunRoot = await createTempProject()
    tempDirs.push(authProviderRunRoot)
    linkWorkspaceFakeInstalledPackagesSync(authProviderRunRoot)
    await writeProjectFile(authProviderRunRoot, '.env', 'APP_NAME=Auth\n')
    await writeProjectFile(authProviderRunRoot, '.env.example', 'APP_NAME=\n')
    const authProviderRunIo = createIo(authProviderRunRoot)
    const authProviderRunContext = {
      ...authProviderRunIo.io,
      projectRoot: authProviderRunRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const authProviderInstallCommand = cliInternals.createInternalCommands(authProviderRunContext as never)
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
    linkWorkspaceFakeInstalledPackagesSync(eventsRunRoot)
    const eventsRunIo = createIo(eventsRunRoot)
    const eventsRunContext = {
      ...eventsRunIo.io,
      projectRoot: eventsRunRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const eventsInstallCommand = cliInternals.createInternalCommands(eventsRunContext as never)
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
    linkWorkspaceFakeInstalledPackagesSync(interactiveEventsRoot)
    await writeProjectFile(interactiveEventsRoot, '.env', 'APP_NAME=Queued\n')
    await writeProjectFile(interactiveEventsRoot, '.env.example', 'APP_NAME=\n')
    const interactiveEventsIo = createIo(interactiveEventsRoot, {
      tty: true,
      input: 'y\n',
    })
    const interactiveEventsContext = {
      ...interactiveEventsIo.io,
      projectRoot: interactiveEventsRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const interactiveEventsCommand = cliInternals.createInternalCommands(interactiveEventsContext as never)
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
    await expect(readFile(join(interactiveEventsRoot, 'config/queue.ts'), 'utf8')).resolves.toContain('default: \'sync\'')

    const queueOnlyEventsRoot = await createTempProject()
    tempDirs.push(queueOnlyEventsRoot)
    linkWorkspaceFakeInstalledPackagesSync(queueOnlyEventsRoot)
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
      input: 'y\n',
    })
    const queueOnlyEventsContext = {
      ...queueOnlyEventsIo.io,
      projectRoot: queueOnlyEventsRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const queueOnlyEventsCommand = cliInternals.createInternalCommands(queueOnlyEventsContext as never)
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
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-sqlite': expectedHoloPackageRange,
        '@holo-js/queue-db': expectedHoloPackageRange,
      },
    }, null, 2))
    await writeProjectFile(dependencySyncRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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
import { defineQueueConfig } from '@holo-js/config'

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
import { defineRedisConfig } from '@holo-js/config'

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
import { defineStorageConfig } from '@holo-js/config'

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
import { defineDatabaseConfig } from '@holo-js/config'

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
import { defineQueueConfig } from '@holo-js/config'

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
import { defineRedisConfig } from '@holo-js/config'

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
import { defineDatabaseConfig } from '@holo-js/config'

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
import { defineQueueConfig } from '@holo-js/config'

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
import { defineRedisConfig } from '@holo-js/config'

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
import { defineDatabaseConfig } from '@holo-js/config'

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
  }, 180000)

  it('preserves workspace versions when syncing managed dependencies in workspace apps', async () => {
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
import { defineDatabaseConfig } from '@holo-js/config'

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
import { defineAuthConfig } from '@holo-js/config'

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
import { defineCacheConfig } from '@holo-js/config'

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
        '@holo-js/auth': 'workspace:*',
        '@holo-js/cache': 'workspace:*',
        '@holo-js/cache-db': 'workspace:*',
        '@holo-js/core': 'workspace:*',
        '@holo-js/db': 'workspace:*',
        '@holo-js/db-sqlite': 'workspace:*',
        '@holo-js/security': 'workspace:*',
        '@holo-js/session': 'workspace:*',
      },
    })
  }, 30000)

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
import { defineAuthConfig } from '@holo-js/config'

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
import { defineSessionConfig } from '@holo-js/config'

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
import { defineSecurityConfig } from '@holo-js/config'

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
import { defineMailConfig } from '@holo-js/config'

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
import { defineNotificationsConfig } from '@holo-js/config'

export default defineNotificationsConfig({})
`)
    await writeProjectFile(projectRoot, 'config/broadcast.ts', `
import { defineBroadcastConfig } from '@holo-js/config'

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
import { defineRedisConfig } from '@holo-js/config'

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
  }, 30000)

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
import { defineDatabaseConfig } from '@holo-js/config'

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
  }, 30000)

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
import { defineAuthConfig } from '@holo-js/config'

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
import { defineSessionConfig } from '@holo-js/config'

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
import { defineCacheConfig } from '@holo-js/config'

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

  it('uses fallback authorization scaffold paths and default cache database connections in isolated scaffold imports', async () => {
    const scaffoldRoot = await createTempProject()
    tempDirs.push(scaffoldRoot)
    await mkdir(join(scaffoldRoot, 'server/policies'), { recursive: true })

    const baseProjectConfig = defaultProjectConfig()
    const loadProjectConfig = vi.fn(async () => ({
      config: {
        ...baseProjectConfig,
        paths: {
          ...baseProjectConfig.paths,
          authorizationPolicies: undefined,
          authorizationAbilities: undefined,
        },
      },
    }))

    vi.resetModules()
    vi.doMock('../src/project/config', async () => {
      const actual = await vi.importActual('../src/project/config') as typeof ProjectConfigInternalModule
      return {
        ...actual,
        loadProjectConfig,
      }
    })

    try {
      const isolatedScaffold = await import('../src/project/scaffold')

      await expect(isolatedScaffold.syncManagedDriverDependencies(scaffoldRoot)).resolves.toBe(true)
      expect(JSON.parse(await readFile(join(scaffoldRoot, 'package.json'), 'utf8'))).toMatchObject({
        dependencies: {
          '@holo-js/authorization': expectedHoloPackageRange,
        },
      })

      const cacheRoot = await createTempProject()
      tempDirs.push(cacheRoot)
      await writeProjectFile(cacheRoot, '.env', '')
      await writeProjectFile(cacheRoot, '.env.example', '')

      await expect(isolatedScaffold.installCacheIntoProject(cacheRoot, {
        driver: 'database',
      })).resolves.toEqual({
        updatedPackageJson: true,
        createdCacheConfig: true,
        createdRedisConfig: false,
        updatedEnv: true,
        updatedEnvExample: true,
        databaseDriver: true,
      })
      expect(await readFile(join(cacheRoot, 'config/cache.ts'), 'utf8')).toContain('connection: \'default\'')
    } finally {
      vi.doUnmock('../src/project/config')
      vi.resetModules()
    }
  }, 30_000)

  it('detects queue and storage config files from Windows-style loaded paths during dependency sync', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
      },
    }, null, 2))

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          app: actual.holoAppDefaults,
          database: {
            defaultConnection: 'default',
            connections: {
              default: {
                driver: 'postgres',
                url: 'postgres://localhost/app',
              },
            },
          },
          queue: {
            default: 'redis',
            failed: false,
            connections: {
              redis: {
                name: 'redis',
                driver: 'redis',
                queue: 'default',
                retryAfter: 90,
                blockFor: 5,
                redis: {
                  host: '127.0.0.1',
                  port: 6379,
                  db: 0,
                },
              },
            },
          },
          storage: {
            defaultDisk: 'media',
            routePrefix: '/storage',
            disks: {
              media: {
                name: 'media',
                driver: 's3',
                visibility: 'private',
                bucket: 'media-bucket',
                region: 'us-east-1',
                endpoint: 'https://s3.us-east-1.amazonaws.com',
              },
            },
          },
          media: {},
          custom: {},
          all: {} as never,
          environment: {
            name: 'development',
            values: {},
            loadedFiles: [],
            warnings: [],
          },
          loadedFiles: [
            'C:\\workspace\\app\\config\\queue.ts',
            'C:\\workspace\\app\\config\\storage.ts',
          ],
          warnings: [],
        })),
      }
    })

    try {
      const { projectInternals: isolatedProjectInternals } = await import('../src/project')
      await expect(isolatedProjectInternals.syncManagedDriverDependencies(projectRoot)).resolves.toBe(true)
      expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
        dependencies: {
          '@holo-js/db': expectedHoloPackageRange,
          '@holo-js/db-postgres': expectedHoloPackageRange,
          '@holo-js/queue': expectedHoloPackageRange,
          '@holo-js/queue-redis': expectedHoloPackageRange,
          '@holo-js/storage': expectedHoloPackageRange,
          '@holo-js/storage-s3': expectedHoloPackageRange,
        },
      })
      expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies['@holo-js/queue-db']).toBeUndefined()
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.resetModules()
    }
  }, 30000)

  it('resolves new project input defaults, flags, and storage package defaults', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
      args: [],
      flags: {},
    })).rejects.toThrow('Missing required argument: Project name.')

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
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
    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
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
    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
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

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
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
    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
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

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
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
  }, 30000)

  it('installs security support through the CLI', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'security'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed security support.')
    expect(result.stdout).toContain('  - created config/security.ts')
    expect(result.stdout).toContain('  - created config/cors.ts')
    expect(await readFile(join(projectRoot, 'config/security.ts'), 'utf8')).toContain('defineSecurityConfig')
    expect(await readFile(join(projectRoot, 'config/cors.ts'), 'utf8')).toContain('defineCorsConfig')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/security": "${expectedHoloPackageRange}"`)
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/package.json', JSON.stringify({
      name: '@holo-js/security',
      type: 'module',
      exports: {
        '.': './index.mjs',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/index.mjs', `
export function defineSecurityConfig(config) {
  return Object.freeze({ ...config })
}

export function ip(request, trustedProxy = false) {
  if (!trustedProxy) {
    return 'unknown'
  }

  return request.headers.get('x-forwarded-for') ?? 'unknown'
}

export const limit = Object.freeze({
  perMinute(maxAttempts) {
    return {
      by(key) {
        return Object.freeze({
          maxAttempts,
          decaySeconds: 60,
          key,
        })
      },
      define() {
        return Object.freeze({
          maxAttempts,
          decaySeconds: 60,
        })
      },
    }
  },
  perHour(maxAttempts) {
    return {
      by(key) {
        return Object.freeze({
          maxAttempts,
          decaySeconds: 3600,
          key,
        })
      },
      define() {
        return Object.freeze({
          maxAttempts,
          decaySeconds: 3600,
        })
      },
    }
  },
})
`)

    const loaded = await loadConfigDirectory(projectRoot, {
      preferCache: false,
      processEnv: {},
    })
    expect(loaded.security.rateLimit.limiters.login?.key).toBeUndefined()
    expect(loaded.security.rateLimit.limiters.register?.key).toBeUndefined()

    const cached = runCliProcess(projectRoot, ['config:cache'], {
      env: {
        APP_ENV: 'production',
        APP_KEY: 'super-secret',
      },
    })
    expect(cached.status, cached.stderr || cached.stdout).toBe(0)
    expect(cached.stdout).toContain('Config cached:')
  }, 30000)

  it('runs prepare after installing dependencies for first-party support', async () => {
    const projectRoot = await createTempDirectory()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      dependencies: {},
    }, null, 2))
    await writeProjectFile(projectRoot, 'config/app.mjs', 'export default {}\n')

    const io = createIo(projectRoot)
    const runProjectDependencyInstall = vi.fn(async () => {})
    const runProjectPrepare = vi.fn(async () => {})
    const context = {
      ...io.io,
      projectRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const commands = cliInternals.createInternalCommands(
      context,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {},
      {
        runProjectDependencyInstall,
        runProjectPrepare,
      },
    )
    const installCommand = commands.find(command => command.name === 'install')
    const prepared = await installCommand?.prepare?.({ args: ['security'], flags: {} }, context as never)
    await installCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: prepared?.args ?? [],
      flags: prepared?.flags ?? {},
      loadProject: context.loadProject,
    } as never)

    expect(runProjectDependencyInstall).toHaveBeenCalledWith(context, projectRoot)
    expect(runProjectPrepare).toHaveBeenCalledWith(projectRoot, context)
    expect(runProjectDependencyInstall.mock.invocationCallOrder[0]).toBeLessThan(runProjectPrepare.mock.invocationCallOrder[0] ?? 0)
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
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'file\'')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('CACHE_PREFIX=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).not.toContain('"@holo-js/cache-redis"')
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

  it('installs cache support with the redis driver', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'redis'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed cache support.')
    expect(result.stdout).toContain('  - created config/cache.ts')
    expect(result.stdout).toContain('  - created config/redis.ts')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'redis\'')
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
import { defineRedisConfig } from '@holo-js/config'

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
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('connection: \'cache\'')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, '.env.example'), 'utf8')).toContain('REDIS_HOST=')
  }, 30_000)

  it('switches cache drivers after the user updates cache config and reruns the public install command', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    expect(runCliProcess(projectRoot, ['install', 'cache']).status).toBe(0)
    await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/config'

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
    expect(result.stdout).toContain('  - updated package.json')
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

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'redis'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('config/cache.ts already exists')
    expect(result.stderr).toContain('does not configure the "redis" cache driver')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'file\'')
    await expect(readFile(join(projectRoot, 'config/redis.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('REDIS_URL=')
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).not.toContain('REDIS_HOST=')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).not.toContain('"@holo-js/cache-redis"')
  }, 30_000)

  it('installs cache support with the database driver and prints the migration hint', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const result = runCliProcess(projectRoot, ['install', 'cache', '--driver', 'database'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed cache support.')
    expect(result.stdout).toContain('run "holo cache:table" to create the cache tables')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('default: \'database\'')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('driver: \'database\'')
    expect(await readFile(join(projectRoot, 'config/cache.ts'), 'utf8')).toContain('table: \'cache\'')
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toContain(`"@holo-js/cache-db": "${expectedHoloPackageRange}"`)
  }, 30_000)

  it('installs broadcast support without requiring framework Flux bootstrap files', async () => {
    const nextRoot = await createTempProject()
    tempDirs.push(nextRoot)
    await writeProjectFile(nextRoot, 'package.json', JSON.stringify({
      name: 'next-broadcast-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))
    await writeProjectFile(nextRoot, 'app/layout.tsx', 'export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }\n')
    const nextResult = runCliProcess(nextRoot, ['install', 'broadcast'])
    expect(nextResult.status).toBe(0)
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

    const nuxtRoot = await createTempProject()
    tempDirs.push(nuxtRoot)
    await writeProjectFile(nuxtRoot, 'package.json', JSON.stringify({
      name: 'nuxt-broadcast-fixture',
      private: true,
      dependencies: {
        nuxt: expectedNuxtPackageRange,
      },
    }, null, 2))
    const nuxtResult = runCliProcess(nuxtRoot, ['install', 'broadcast'])
    expect(nuxtResult.status).toBe(0)
    await expect(stat(join(nuxtRoot, 'app/plugins/flux.client.ts'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'server/routes/broadcasting/auth.post.ts'))).rejects.toThrow()
    await expect(stat(join(nuxtRoot, 'server/holo.ts'))).rejects.toThrow()
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-vue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(nuxtRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-nuxt": "${expectedHoloPackageRange}"`)

    const svelteRoot = await createTempProject()
    tempDirs.push(svelteRoot)
    await writeProjectFile(svelteRoot, 'package.json', JSON.stringify({
      name: 'svelte-broadcast-fixture',
      private: true,
      dependencies: {
        '@sveltejs/kit': expectedSvelteKitPackageRange,
      },
    }, null, 2))
    const svelteResult = runCliProcess(svelteRoot, ['install', 'broadcast'])
    expect(svelteResult.status).toBe(0)
    await expect(stat(join(svelteRoot, 'src/lib/flux.ts'))).rejects.toThrow()
    await expect(stat(join(svelteRoot, 'src/routes/broadcasting/auth/+server.ts'))).rejects.toThrow()
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/flux-svelte": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.not.toContain(`"@holo-js/queue": "${expectedHoloPackageRange}"`)
    await expect(readFile(join(svelteRoot, 'package.json'), 'utf8')).resolves.toContain(`"@holo-js/adapter-sveltekit": "${expectedHoloPackageRange}"`)

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
  }, 30000)

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
    await expect(readFile(join(nextRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).resolves.toContain('channelAuth')
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
      createdBroadcastAuthRoute: true,
      updatedEnv: true,
      updatedEnvExample: true,
    })
    await expect(readFile(join(nuxtRoot, 'server/routes/broadcasting/auth.post.ts'), 'utf8')).resolves.toContain('channelAuth')
    await expect(readFile(join(nuxtRoot, 'server/routes/broadcasting/auth.post.ts'), 'utf8')).resolves.toContain('import { holo } from \'#imports\'')
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
  }, 30000)

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
import { defineBroadcastConfig, env } from '@holo-js/config'

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
    await expect(cliInternals.resolveNewProjectInput(defaultNamePromptIo.io, {
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
    await expect(cliInternals.resolveNewProjectInput(defaultChoicePromptIo.io, {
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
    await expect(cliInternals.resolveNewProjectInput(defaultOptionalPackagesIo.io, {
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
    await expect(cliInternals.resolveNewProjectInput(io.io, { args: [], flags: {} }, {
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

    await expect(cliInternals.resolveNewProjectInput(io.io, { args: [], flags: {} }, {
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

    await expect(cliInternals.resolveNewProjectInput(io.io, { args: [], flags: {} }, {
      prompt: async () => 'bad-app',
      choose: async () => {
        throw new Error('Unsupported Framework: invalid-framework. Expected one of nuxt, next, sveltekit.')
      },
      optionalPackages: async () => [],
    })).rejects.toThrow('Unsupported')

    await expect(cliInternals.resolveNewProjectInput(io.io, { args: [], flags: {} }, {
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
    await expect(cliInternals.promptChoice(choiceIo.io, 'Framework', ['nuxt', 'next'], 'nuxt')).resolves.toBe('next')

    const invalidChoiceIo = createIo(baseRoot, {
      tty: true,
      input: 'astro\n',
    })
    await expect(cliInternals.promptChoice(invalidChoiceIo.io, 'Framework', ['nuxt', 'next'], 'nuxt')).rejects.toThrow('Unsupported Framework')
    const optionalPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'forms,validation\n',
    })
    await expect(cliInternals.promptOptionalPackages(optionalPromptIo.io)).resolves.toEqual(['forms', 'validation'])
    const securityPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'security\n',
    })
    await expect(cliInternals.promptOptionalPackages(securityPromptIo.io)).resolves.toEqual(['security'])
    const broadcastPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'broadcast\n',
    })
    await expect(cliInternals.promptOptionalPackages(broadcastPromptIo.io)).resolves.toEqual(['broadcast'])
    const formsOnlyPromptIo = createIo(baseRoot, {
      tty: true,
      input: 'forms\n',
    })
    await expect(cliInternals.promptOptionalPackages(formsOnlyPromptIo.io)).resolves.toEqual(['forms', 'validation'])
    expect(cliInternals.normalizeChoice('next', ['nuxt', 'next'], 'Framework')).toBe('next')
    expect(() => cliInternals.normalizeChoice('astro', ['nuxt', 'next'], 'Framework')).toThrow('Unsupported Framework')
    expect(() => cliInternals.normalizeChoice(undefined, ['nuxt', 'next'], 'Framework')).toThrow('(empty)')
    expect(() => cliInternals.normalizeOptionalPackages(['weird-package'])).toThrow('Unsupported optional package')
    expect(cliInternals.normalizeOptionalPackages(['broadcast'])).toEqual(['broadcast'])
    expect(cliInternals.normalizeOptionalPackages(['security'])).toEqual(['security'])
    expect(cliInternals.normalizeOptionalPackages(['forms'])).toEqual(['forms', 'validation'])
    expect(cliInternals.normalizeOptionalPackages(['forms', 'validation', 'forms'])).toEqual(['forms', 'validation'])
    expect(cliInternals.normalizeOptionalPackages(['form', 'validate', 'storage', 'queue', 'events'])).toEqual([
      'events',
      'forms',
      'queue',
      'storage',
      'validation',
    ])
    expect(cliInternals.normalizeOptionalPackages(['none'])).toEqual([])
  })

  it('rejects conflicting flags, unsupported values, non-empty targets, and generated project regressions', async () => {
    const baseRoot = await createTempDirectory()
    tempDirs.push(baseRoot)

    await writeProjectFile(baseRoot, 'occupied/file.txt', 'taken')

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['demo'],
      flags: { name: 'other' },
    })).rejects.toThrow('Conflicting project names')

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['demo'],
      flags: { framework: 'astro' },
    })).rejects.toThrow('Unsupported framework')

    await expect(cliInternals.resolveNewProjectInput(createIo(baseRoot).io, {
      args: ['demo'],
      flags: { package: 'weird-package' },
    })).rejects.toThrow('Unsupported optional package')

    const occupiedResult = runCliProcess(baseRoot, ['new', 'occupied'])
    expect(occupiedResult.status).toBe(1)
    expect(occupiedResult.stderr).toContain('Refusing to scaffold into a non-empty directory')

    const projectRoot = join(baseRoot, 'scripted-app')
    const scaffolded = runCliProcess(baseRoot, ['new', 'scripted-app'])
    expect(scaffolded.status).toBe(0)
    await writeFrameworkBinary(projectRoot, 'nuxt')

    const optionalCliResult = runCliProcess(baseRoot, [
      'new',
      'optional-cli-app',
      '--package',
      'forms,validation',
    ])
    expect(optionalCliResult.status).toBe(0)
    expect(await readFile(join(baseRoot, 'optional-cli-app/package.json'), 'utf8')).toContain(`"@holo-js/forms": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(baseRoot, 'optional-cli-app/package.json'), 'utf8')).toContain(`"@holo-js/validation": "${expectedHoloPackageRange}"`)

    const notificationsCliResult = runCliProcess(baseRoot, [
      'new',
      'notifications-cli-app',
      '--package',
      'notifications',
    ])
    expect(notificationsCliResult.status).toBe(0)
    expect(await readFile(join(baseRoot, 'notifications-cli-app/package.json'), 'utf8')).toContain(`"@holo-js/notifications": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(baseRoot, 'notifications-cli-app/config/notifications.ts'), 'utf8')).toContain('defineNotificationsConfig')
    expect((await readdir(join(baseRoot, 'notifications-cli-app/server/db/migrations'))).some(name => name.endsWith('_create_notifications.ts'))).toBe(true)

    const mailCliResult = runCliProcess(baseRoot, [
      'new',
      'mail-cli-app',
      '--package',
      'mail',
    ])
    expect(mailCliResult.status).toBe(0)
    expect(await readFile(join(baseRoot, 'mail-cli-app/package.json'), 'utf8')).toContain(`"@holo-js/mail": "${expectedHoloPackageRange}"`)
    expect(await readFile(join(baseRoot, 'mail-cli-app/config/mail.ts'), 'utf8')).toContain('defineMailConfig')
    expect((await stat(join(baseRoot, 'mail-cli-app/server/mail'))).isDirectory()).toBe(true)

    await linkWorkspaceCli(projectRoot)
    await writeProjectFile(projectRoot, '.nuxt/tsconfig.json', JSON.stringify({
      compilerOptions: {
        strict: true,
      },
    }, null, 2))

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })
    expect(await readFile(join(projectRoot, '.holo-js/generated/registry.json'), 'utf8')).toContain('"version": 1')

    const devResult = runNodeScript(projectRoot, join(projectRoot, '.holo-js/framework/run.mjs'), ['dev'])
    expect(devResult.status, devResult.stderr || devResult.stdout).toBe(0)
    expect(devResult.stdout).toContain('dev')

    const buildResult = runNodeScript(projectRoot, join(projectRoot, '.holo-js/framework/run.mjs'), ['build'])
    expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0)
    expect(buildResult.stdout).toContain('build')

    const cacheResult = spawnSync('bun', ['run', 'config:cache'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: process.env,
    })
    expect(cacheResult.status, cacheResult.stderr || cacheResult.stdout).toBe(0)

    const clearResult = spawnSync('bun', ['run', 'config:clear'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: process.env,
    })
    expect(clearResult.status, clearResult.stderr || clearResult.stdout).toBe(0)
  }, 30000)

  it('prepares discovery artifacts and syncs managed driver dependencies before installing them', async () => {
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
import { defineDatabaseConfig } from '@holo-js/config'

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

    const fakeBinRoot = await createTempDirectory()
    tempDirs.push(fakeBinRoot)
    const installLogPath = join(fakeBinRoot, 'npm-install.log')
    await writeFile(join(fakeBinRoot, 'npm'), `#!/bin/sh
printf '%s\n' "$*" > ${JSON.stringify(installLogPath)}
printf 'fake npm install\n'
`, 'utf8')
    await chmod(join(fakeBinRoot, 'npm'), 0o755)
    const io = createIo(projectRoot)
    const originalPath = process.env.PATH

    process.env.PATH = `${fakeBinRoot}:${originalPath ?? ''}`
    try {
      await withFakeBun(async () => {
        await cliInternals.runProjectPrepare(projectRoot, io.io)
      })
    } finally {
      process.env.PATH = originalPath
    }

    expect(await readFile(join(projectRoot, '.holo-js/generated/registry.json'), 'utf8')).toContain('"version": 1')
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@holo-js/db': expectedHoloPackageRange,
        '@holo-js/db-postgres': expectedHoloPackageRange,
      },
    })
    expect(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies?.['@holo-js/db-sqlite']).toBeUndefined()
    expect(await readFile(installLogPath, 'utf8')).toContain('install')
    expect(io.read().stdout).toContain('fake npm install')
  }, 30000)

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
import { defineCacheConfig } from '@holo-js/config'

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

    const fakeBinRoot = await createTempDirectory()
    tempDirs.push(fakeBinRoot)
    const installLogPath = join(fakeBinRoot, 'npm-install.log')
    await writeFile(join(fakeBinRoot, 'npm'), `#!/bin/sh
printf '%s\n' "$*" > ${JSON.stringify(installLogPath)}
printf 'fake npm install\n'
`, 'utf8')
    await chmod(join(fakeBinRoot, 'npm'), 0o755)

    const io = createIo(projectRoot)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBinRoot}:${originalPath ?? ''}`

    try {
      await withFakeBun(async () => {
        await cliInternals.runProjectPrepare(projectRoot, io.io)
      })

      const syncedDependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {}
      expect(syncedDependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
      expect(syncedDependencies['@holo-js/cache-db']).toBe(expectedHoloPackageRange)
      expect(syncedDependencies['@holo-js/cache-redis']).toBe(expectedHoloPackageRange)
      expect(typeof syncedDependencies.ioredis).toBe('string')
      await writeFile(installLogPath, '', 'utf8')

      await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/config'

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

      await withFakeBun(async () => {
        await cliInternals.runProjectPrepare(projectRoot, io.io)
      })
    } finally {
      process.env.PATH = originalPath
    }

    const dependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {}
    expect(dependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
    expect(dependencies['@holo-js/cache-db']).toBeUndefined()
    expect(dependencies['@holo-js/cache-redis']).toBeUndefined()
    expect(dependencies.ioredis).toBeUndefined()
    expect(await readFile(installLogPath, 'utf8')).toContain('install')
    expect(io.read().stdout).toContain('fake npm install')
  }, 30000)

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

    const fakeBinRoot = await createTempDirectory()
    tempDirs.push(fakeBinRoot)
    const installLogPath = join(fakeBinRoot, 'npm-install.log')
    await writeFile(join(fakeBinRoot, 'npm'), `#!/bin/sh
printf '%s\n' "$*" > ${JSON.stringify(installLogPath)}
printf 'fake npm install\n'
`, 'utf8')
    await chmod(join(fakeBinRoot, 'npm'), 0o755)

    const io = createIo(projectRoot)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBinRoot}:${originalPath ?? ''}`

    try {
      await withFakeBun(async () => {
        await cliInternals.runProjectPrepare(projectRoot, io.io)
      })
    } finally {
      process.env.PATH = originalPath
    }

    const dependencies = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {}
    expect(dependencies['@holo-js/cache']).toBe(expectedHoloPackageRange)
    expect(await readFile(installLogPath, 'utf8')).toContain('install')
    expect(io.read().stdout).toContain('fake npm install')
  }, 30000)

  it('caches config placeholders and clears the cache through the CLI', async () => {
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
    expect(cacheContents).toContain('"APP_KEY"')
    expect(cacheContents).not.toContain('super-secret')

    await writeProjectFile(projectRoot, 'config/app.ts', 'export default (() => { throw new Error("live config should not load") })()')

    const listed = runCliProcess(projectRoot, ['list'], {
      env: {
        APP_ENV: 'production',
        APP_NAME: 'Cached App',
        APP_KEY: 'super-secret',
      },
    })
    expect(listed.status, listed.stderr || listed.stdout).toBe(0)
    expect(listed.stdout).toContain('Internal Commands')

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
    expect(listedIo.read().stdout).toContain('Internal Commands')
    expect(listedIo.read().stdout).toContain('App Commands')
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
import { defineDatabaseConfig } from '@holo-js/config'

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
import { configureDB, createSchemaService, DB, resolveRuntimeConnectionManagerOptions } from '@holo-js/db'

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
    expect(setup.status).toBe(0)

    const pruned = runCliProcess(projectRoot, ['prune'])
    expect(pruned.status).toBe(0)
    expect(pruned.stdout).toContain('Session: deleted 2')
    expect(pruned.stdout).toContain('Total deleted: 2')

    const invalid = runCliProcess(projectRoot, ['prune', 'User'])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('Model "User" does not define a prunable query.')
  }, 30000)

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
import { defineDatabaseConfig } from '@holo-js/config'

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
import { configureDB, createSchemaService, DB, resolveRuntimeConnectionManagerOptions } from '@holo-js/db'

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
    expect(setup.status).toBe(0)

    const pruned = runCliProcess(projectRoot, ['prune'], {
      env: {
        DB_DRIVER: 'sqlite',
        DB_URL: './env.sqlite',
      },
    })

    expect(pruned.status, pruned.stderr || pruned.stdout).toBe(0)
    expect(pruned.stdout).toContain('Session: deleted 1')
    await expect(readFile(join(projectRoot, 'env.sqlite'))).resolves.toBeDefined()
    await expect(readFile(join(projectRoot, 'data/database.sqlite'))).rejects.toThrow()
  }, 30000)

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
import { defineDatabaseConfig } from '@holo-js/config'

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

    const migrated = runCliProcess(projectRoot, ['migrate'])
    expect(migrated.status, migrated.stderr || migrated.stdout).toBe(0)

    const generatedPath = join(projectRoot, '.holo-js/generated/schema.generated.ts')
    await expect(readFile(generatedPath, 'utf8')).resolves.toContain('export const users = defineGeneratedTable("users", {')

    const rolledBack = runCliProcess(projectRoot, ['migrate:rollback'])
    expect(rolledBack.status, rolledBack.stderr || rolledBack.stdout).toBe(0)

    const generated = await readFile(generatedPath, 'utf8')
    expect(generated).toContain('registerGeneratedTables(tables)')
    expect(generated).not.toContain('defineGeneratedTable("users"')
  }, 30000)

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
import { defineDatabaseConfig } from '@holo-js/config'

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

    const fresh = runCliProcess(projectRoot, ['migrate:fresh', '--seed'])
    expect(fresh.status, fresh.stderr || fresh.stdout).toBe(0)
    expect(fresh.stdout).toContain('Seeders executed:')
    expect(fresh.stdout).toContain('UserSeeder')
    expect(fresh.stdout).toContain('AdminSeeder')

    const generated = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
    expect(generated).toContain('"name": column.string()')
    expect(generated).toContain('export const admins = defineGeneratedTable("admins", {')
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
import { defineDatabaseConfig } from '@holo-js/config'

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

    await withFakeBun(async () => {
      await expect(findProjectRoot(join(projectRoot, 'server/nested'))).resolves.toBe(projectRoot)

      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.models).toEqual([])
      expect(loaded.config.paths.commands).toBe('server/commands')

      const commands = await discoverAppCommands(projectRoot, loaded.config)
      expect(commands).toHaveLength(1)
      expect(commands[0]?.name).toBe('courses:reindex')
    })
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

    await withFakeBun(async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      await expect(discoverAppCommands(projectRoot, loaded.config)).rejects.toThrow('does not export a Holo command')
    })
  })

  it('discovers nested jobs, events, and listeners, including derived event names and invalid modules', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/config'

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
import { defineQueueConfig } from '@holo-js/config'

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

    await withFakeBun(async () => {
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
    })

    const invalidRoot = await createTempProject()
    tempDirs.push(invalidRoot)
    await writeProjectFile(invalidRoot, 'server/jobs/bad.mjs', 'export default { nope: true }')
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(invalidRoot)).rejects.toThrow('does not export a Holo job')
    })

    const invalidEventRoot = await createTempProject()
    tempDirs.push(invalidEventRoot)
    await writeProjectFile(invalidEventRoot, 'server/events/bad.mjs', 'export default { nope: true }')
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(invalidEventRoot)).rejects.toThrow('does not export a Holo event')
    })

    const invalidListenerRoot = await createTempProject()
    tempDirs.push(invalidListenerRoot)
    await writeProjectFile(invalidListenerRoot, 'server/events/user/registered.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await writeProjectFile(invalidListenerRoot, 'server/listeners/bad.mjs', 'export default { nope: true }')
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(invalidListenerRoot)).rejects.toThrow('does not export a Holo listener')
    })

    const hiddenEventRoot = await createTempProject()
    tempDirs.push(hiddenEventRoot)
    await writeProjectFile(hiddenEventRoot, 'server/events/.mjs', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({})
`)
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(hiddenEventRoot)).rejects.toThrow('Derived event names require a non-empty source path.')
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(hiddenListenerRoot)).rejects.toThrow(
        'Derived listener identifiers require a non-empty source path.',
      )
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(stringListenerRoot)).resolves.toMatchObject({
        listeners: [{
          id: 'user.by-string',
          eventNames: ['user.registered'],
        }],
      })
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(missingListenerEventRoot)).rejects.toThrow(
        'Listener "user.missing-event" references unknown event "user.registered".',
      )
    })
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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(orderedListenersRoot)).resolves.toMatchObject({
        listeners: [
          { id: 'a.listener' },
          { id: 'z.listener' },
        ],
      })
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(pathDerivedListenerRoot)).resolves.toMatchObject({
        events: [{
          name: 'audit.activity',
        }],
        listeners: [{
          id: 'audit.bad',
          eventNames: ['audit.activity'],
        }],
      })
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(singleReferenceListenerRoot)).resolves.toMatchObject({
        events: [{
          name: 'audit.activity',
        }],
        listeners: [{
          id: 'audit.single-reference',
          eventNames: ['audit.activity'],
        }],
      })
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(extensionlessListenerImportRoot)).resolves.toMatchObject({
        events: [{
          name: 'audit.activity',
        }],
        listeners: [{
          id: 'audit.by-extensionless-import',
          eventNames: ['audit.activity'],
        }],
      })
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(listenerDiscoveryErrorRoot)).rejects.toThrow('boom')
    })

    const malformedRoot = await createTempProject()
    tempDirs.push(malformedRoot)
    await writeProjectFile(malformedRoot, 'server/jobs/malformed.mjs', `
export default {
  tries: 1.5,
  async handle() {},
}
`)
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(malformedRoot)).rejects.toThrow('Job tries must be an integer when provided.')
    })

    const fallbackRoot = await createTempDirectory()
    tempDirs.push(fallbackRoot)
    await linkWorkspaceQueue(fallbackRoot)
    await writeProjectFile(fallbackRoot, 'server/jobs/fallback.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(fallbackRoot)).resolves.toMatchObject({
        jobs: [{
          sourcePath: 'server/jobs/fallback.mjs',
          name: 'fallback',
          connection: 'sync',
          queue: 'default',
        }],
      })
    })

    const authorizationFallbackRoot = await createTempProject()
    tempDirs.push(authorizationFallbackRoot)
    await writeProjectFile(authorizationFallbackRoot, 'server/policies/FallbackPolicy.mjs', 'export default {}\n')
    await writeProjectFile(authorizationFallbackRoot, 'server/abilities/fallback.mjs', 'export default {}\n')

    vi.resetModules()
    const authorizationState = {
      policiesByName: new Map<string, unknown>(),
      abilitiesByName: new Map<string, unknown>(),
    }
    const resetAuthorizationRuntimeState = vi.fn(() => {
      authorizationState.policiesByName.clear()
      authorizationState.abilitiesByName.clear()
    })
    vi.doMock('../src/project/runtime', async () => {
      const actual = await vi.importActual('../src/project/runtime') as typeof ProjectRuntimeInternalModule
      return {
        ...actual,
        loadAuthorizationDiscoveryModule: vi.fn(async () => ({
          isAuthorizationPolicyDefinition: (value: unknown) => !!value
            && typeof value === 'object'
            && 'kind' in value
            && (value as { kind?: string }).kind === 'policy',
          isAuthorizationAbilityDefinition: (value: unknown) => !!value
            && typeof value === 'object'
            && 'kind' in value
            && (value as { kind?: string }).kind === 'ability',
          authorizationInternals: {
            getAuthorizationRuntimeState: () => authorizationState,
            resetAuthorizationRuntimeState,
          },
        })),
        importProjectModule: vi.fn(async (_projectRoot: string, filePath: string) => {
          if (filePath.endsWith('FallbackPolicy.mjs')) {
            authorizationState.policiesByName.set('posts', {})
            return {
              default: {
                kind: 'policy',
                name: 'posts',
                target: {},
              },
            }
          }

          if (filePath.endsWith('fallback.mjs')) {
            authorizationState.abilitiesByName.set('reports.export', {})
            return {
              default: {
                kind: 'ability',
                name: 'reports.export',
              },
            }
          }

          return await actual.importProjectModule(_projectRoot, filePath)
        }),
      }
    })

    try {
      const isolatedDiscovery = await import('../src/project/discovery')
      await expect(isolatedDiscovery.prepareProjectDiscovery(authorizationFallbackRoot, {
        ...defaultProjectConfig(),
        paths: {
          ...defaultProjectConfig().paths,
          authorizationPolicies: undefined as never,
          authorizationAbilities: undefined as never,
        },
      })).resolves.toMatchObject({
        paths: {
          authorizationPolicies: 'server/policies',
          authorizationAbilities: 'server/abilities',
        },
        authorizationPolicies: [{
          sourcePath: 'server/policies/FallbackPolicy.mjs',
          name: 'posts',
          target: 'Object',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/fallback.mjs',
          name: 'reports.export',
        }],
      })
      expect(resetAuthorizationRuntimeState).toHaveBeenCalled()
    } finally {
      vi.doUnmock('../src/project/runtime')
      vi.resetModules()
    }

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(duplicateRoot)).rejects.toThrow('Discovered duplicate job "shared.job"')
    })

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
    await withFakeBun(async () => {
      await expect(prepareProjectDiscovery(duplicateEventRoot)).rejects.toThrow('Discovered duplicate event "shared.event"')
    })
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

    await withFakeBun(async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.paths.commands).toBe('server/commands')
      await expect(discoverAppCommands(projectRoot, loaded.config)).resolves.toEqual([])
    })

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

    await withFakeBun(async () => {
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
    })
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

    await withFakeBun(async () => {
      const defaultIo = createIo(projectRoot)
      await expect(import('../src/cli').then(module => module.runCli([], defaultIo.io))).resolves.toBe(0)
      expect(defaultIo.read().stdout).toContain('Internal Commands')

      const listedIo = createIo(projectRoot)
      await expect(cliInternals.findCommand([], 'missing')).toBeUndefined()
      await expect(import('../src/cli').then(module => module.runCli(['list'], listedIo.io))).resolves.toBe(0)
      expect(listedIo.read().stdout).toContain('Internal Commands')
      expect(listedIo.read().stdout).toContain('holo courses:reindex')

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
    })
  })

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

    await withFakeBun(async () => {
      const duplicateIo = createIo(duplicateRoot)
      await expect(import('../src/cli').then(module => module.runCli(['list'], duplicateIo.io))).resolves.toBe(1)
      expect(duplicateIo.read().stderr).toContain('conflicts with internal command')

      const failingIo = createIo(failingRoot)
      await expect(import('../src/cli').then(module => module.runCli(['explode'], failingIo.io))).resolves.toBe(1)
      expect(failingIo.read().stderr).toContain('boom')
    })
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

    await withFakeBun(async () => {
      const duplicateAliasIo = createIo(duplicateAliasRoot)
      await expect(import('../src/cli').then(module => module.runCli(['shared'], duplicateAliasIo.io))).resolves.toBe(1)
      expect(duplicateAliasIo.read().stderr).toContain('duplicate command token')
      expect(duplicateAliasIo.read().stderr).toContain('shared')

      const duplicateNameIo = createIo(duplicateNameRoot)
      await expect(import('../src/cli').then(module => module.runCli(['shared:name'], duplicateNameIo.io))).resolves.toBe(1)
      expect(duplicateNameIo.read().stderr).toContain('duplicate command')
      expect(duplicateNameIo.read().stderr).toContain('shared:name')
    })
  })

  it('covers CLI parsing and registry helpers in-process', async () => {
    const command = defineCommand({
      aliases: ['sample'],
      description: 'Example command.',
      usage: 'holo example',
      async run() {},
    })
    const appDefinition = cliInternals.createAppCommandDefinition({
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
    expect(cliInternals.parseTokens(['name', '--step', '2', '--quietly', '-f'])).toEqual({
      args: ['name'],
      flags: {
        step: '2',
        quietly: true,
        f: true,
      },
    })
    expect(cliInternals.parseTokens(['--only=roles', '--only', 'users', '--only', 'teachers', '-o', 'admins', '-abc', '--', '--literal'])).toEqual({
      args: ['--literal'],
      flags: {
        only: ['roles', 'users', 'teachers'],
        o: 'admins',
        a: true,
        b: true,
        c: true,
      },
    })
    expect(cliInternals.parseTokens(['--step', '-1'])).toEqual({
      args: [],
      flags: {
        step: '-1',
      },
    })
    expect(cliInternals.parseTokens(['-s', '-1'])).toEqual({
      args: [],
      flags: {
        s: '-1',
      },
    })
    expect(cliInternals.resolveStringFlag({ only: ['roles', 'users'] }, 'only')).toBe('users')
    expect(cliInternals.resolveStringFlag({ o: 'roles' }, 'only', 'o')).toBe('roles')
    expect(cliInternals.resolveStringFlag({ step: 2 }, 'step')).toBeUndefined()
    expect(cliInternals.resolveBooleanFlag({ force: 'true' }, 'force')).toBe(true)
    expect(cliInternals.resolveBooleanFlag({ force: ['false', 'true'] }, 'force')).toBe(true)
    expect(cliInternals.resolveBooleanFlag({ f: 'false' }, 'force', 'f')).toBe(false)
    expect(cliInternals.parseNumberFlag({ step: '3' }, 'step')).toBe(3)
    expect(() => cliInternals.parseNumberFlag({ step: '-1' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    expect(cliInternals.parseNumberFlag({}, 'step')).toBeUndefined()
    expect(() => cliInternals.parseNumberFlag({ step: 'abc' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    expect(() => cliInternals.parseNumberFlag({ step: '1abc' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    const parseIntSpy = vi.spyOn(Number, 'parseInt').mockReturnValue(Number.POSITIVE_INFINITY)
    expect(() => cliInternals.parseNumberFlag({ step: '7' }, 'step')).toThrow('Flag "--step" must be a non-negative integer.')
    parseIntSpy.mockRestore()
    expect(cliInternals.splitCsv('roles, users')).toEqual(['roles', 'users'])
    expect(cliInternals.splitCsv(undefined)).toBeUndefined()
    expect(cliInternals.isInteractive(io.io, {})).toBe(false)
    expect(cliInternals.isInteractive(createIo('/tmp/project', { tty: true }).io, {})).toBe(true)
    expect(cliInternals.isInteractive(createIo('/tmp/project', { tty: true }).io, { 'no-interactive': true })).toBe(false)
    expect(cliInternals.findCommand([appDefinition], 'sample')).toBe(appDefinition)
    expect(cliInternals.collectMultiStringFlag({ only: ['users', 'roles'] }, 'only')).toEqual(['users', 'roles'])
    expect(cliInternals.collectMultiStringFlag({ only: 'users' }, 'only')).toEqual(['users'])
    expect(cliInternals.collectMultiStringFlag({ o: 'users' }, 'only', 'o')).toEqual(['users'])
    expect(cliInternals.collectMultiStringFlag({ only: '   ' }, 'only')).toBeUndefined()
    expect(cliInternals.createRuntimeInvocation('console.log(1)')).toEqual({
      command: 'node',
      args: ['--input-type=module', '--eval', 'console.log(1)'],
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
    const executed: string[] = []
    let foreignKeysScoped = false
    await cliInternals.dropAllTablesForFresh(
      {
        getDialect: () => ({
          name: 'postgres',
          quoteIdentifier: (value: string) => `"${value}"`,
        }),
        getSchemaName: () => 'tenant_app',
        async executeCompiled(statement: { sql: string }) {
          executed.push(statement.sql)
          return { affectedRows: 0 }
        },
      } as never,
      {
        async getTables() {
          return ['roles', 'users']
        },
        async dropTable() {
          throw new Error('Postgres fresh should not call schema.dropTable() directly.')
        },
        async withoutForeignKeyConstraints<T>(callback: () => Promise<T>) {
          foreignKeysScoped = true
          return callback()
        },
      } as never,
    )
    expect(foreignKeysScoped).toBe(false)
    expect(executed).toEqual([
      'DROP TABLE IF EXISTS "tenant_app"."roles" CASCADE',
      'DROP TABLE IF EXISTS "tenant_app"."users" CASCADE',
    ])
    const defaultSchemaExecuted: string[] = []
    await cliInternals.dropAllTablesForFresh(
      {
        getDialect: () => ({
          name: 'postgres',
          quoteIdentifier: (value: string) => `"${value}"`,
        }),
        getSchemaName: () => undefined,
        async executeCompiled(statement: { sql: string }) {
          defaultSchemaExecuted.push(statement.sql)
          return { affectedRows: 0 }
        },
      } as never,
      {
        async getTables() {
          return ['users']
        },
        async dropTable() {
          throw new Error('Postgres fresh should not call schema.dropTable() directly.')
        },
        async withoutForeignKeyConstraints<T>(callback: () => Promise<T>) {
          return callback()
        },
      } as never,
    )
    expect(defaultSchemaExecuted).toEqual([
      'DROP TABLE IF EXISTS "users" CASCADE',
    ])
    const droppedTables: string[] = []
    let scopedDrops = 0
    await cliInternals.dropAllTablesForFresh(
      {
        getDialect: () => ({
          name: 'sqlite',
          quoteIdentifier: (value: string) => `"${value}"`,
        }),
        getSchemaName: () => undefined,
        async executeCompiled() {
          throw new Error('Non-Postgres fresh should use schema.dropTable().')
        },
      } as never,
      {
        async getTables() {
          return ['roles', 'users']
        },
        async dropTable(tableName: string) {
          droppedTables.push(tableName)
        },
        async withoutForeignKeyConstraints<T>(callback: () => Promise<T>) {
          scopedDrops += 1
          return callback()
        },
      } as never,
    )
    expect(scopedDrops).toBe(1)
    expect(droppedTables).toEqual(['roles', 'users'])
    expect(cliInternals.inferRuntimeMigrationName('file:///tmp/2026_01_01_000001_create_sessions_table.js')).toBe('2026_01_01_000001_create_sessions_table')
    expect(() => cliInternals.inferRuntimeMigrationName('file:///tmp/create_sessions_table.js')).toThrow(
      'Registered migration "file:///tmp/create_sessions_table.js" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.',
    )
    expect(cliInternals.normalizeRuntimeMigration(
      'file:///tmp/2026_01_01_000001_create_sessions_table.js',
      { up() {} },
    )).toMatchObject({ name: '2026_01_01_000001_create_sessions_table' })
    expect(cliInternals.normalizeRuntimeMigration(
      'file:///tmp/ignored.js',
      { name: 'custom_name', up() {} },
    )).toMatchObject({ name: 'custom_name' })
    expect(cliInternals.getRuntimeFailureMessage('prune', {
      status: null,
      error: { code: 'ENOENT' },
      stdout: undefined,
      stderr: undefined,
    })).toContain('Failed to launch runtime command "prune"')
    expect(cliInternals.getRuntimeFailureMessage('seed', {
      status: 1,
      stdout: '',
      stderr: 'seed failed\n',
    })).toBe('seed failed')
    expect(cliInternals.getRuntimeFailureMessage('seed', {
      status: 1,
      stdout: 'seed output\n',
      stderr: '',
    })).toBe('seed output')
    expect(cliInternals.getRuntimeFailureMessage('migrate', {
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
    expect(cliInternals.getRuntimeFailureMessage('seed', {
      status: 1,
      stdout: undefined,
      stderr: undefined,
      error: undefined,
    })).toBe('Runtime command "seed" failed.')

    cliInternals.printCommandList(io.io, [
      { ...appDefinition, source: 'internal', usage: 'holo list' },
      appDefinition,
    ])
    cliInternals.printCommandHelp(io.io, appDefinition)

    const listed = io.read().stdout
    expect(listed).toContain('Internal Commands')
    expect(listed).toContain('App Commands')
    expect(listed).toContain('holo example')
  })

  it('covers env, file, and internal command preparation helpers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const notePath = join(projectRoot, 'note.txt')
    await writeTextFile(notePath, 'ready')

    process.env.DB_DRIVER = 'postgres'
    process.env.DB_SSL = 'true'
    process.env.DB_LOGGING = 'false'
    expect(cliInternals.parseBooleanEnv(undefined)).toBeUndefined()
    expect(cliInternals.parseBooleanEnv('true')).toBe(true)
    expect(cliInternals.parseBooleanEnv('false')).toBe(false)
    expect(cliInternals.parseBooleanEnv('wat')).toBeUndefined()
    expect(cliInternals.getRegistryMigrationSlug('2026_01_01_000000_create_users_table')).toBe('create_users_table')
    expect(() => cliInternals.getRegistryMigrationSlug('2026_01_01_000000_!!!')).toThrow()
    expect(cliInternals.hasRegisteredMigrationSlug({
      migrations: [
        { name: '2026_01_01_000000_create_users_table' },
        { name: '2026_01_01_000000_!!!' },
      ],
    } as never, 'create_users_table')).toBe(true)
    expect(cliInternals.hasRegisteredMigrationSlug({
      migrations: [
        { name: '2026_01_01_000000_!!!' },
      ],
    } as never, 'create_users_table')).toBe(false)
    expect(cliInternals.hasRegisteredCreateTableMigration({
      migrations: [
        { name: '2026_01_01_000000_create_users_table' },
        { name: '2026_01_01_000001_add_status_to_users_table' },
        { name: '2026_01_01_000002_create_table' },
        { name: '2026_01_01_000003_!!!' },
      ],
    } as never, 'users')).toBe(true)
    expect(cliInternals.hasRegisteredCreateTableMigration({
      migrations: [
        { name: '2026_01_01_000001_add_status_to_users_table' },
        { name: '2026_01_01_000002_create_table' },
        { name: '2026_01_01_000003_!!!' },
      ],
    } as never, 'users')).toBe(false)
    expect(cliInternals.resolvePackageManagerInstallCommand('pnpm')).toBe('pnpm install')
    expect(cliInternals.resolvePackageManagerDevCommand('pnpm')).toBe('pnpm dev')
    expect(cliInternals.resolvePackageManagerInstallCommand('yarn')).toBe('yarn install')
    expect(cliInternals.resolvePackageManagerDevCommand('yarn')).toBe('yarn dev')
    expect(projectInternals.resolveNamedExport('nope', (_value): _value is { ok: true } => false)).toBeUndefined()
    expect(projectInternals.resolveNamedExportEntry('nope', (_value): _value is { ok: true } => false)).toBeUndefined()
    expect(cliInternals.createEnvRuntimeConfig()).toMatchObject({
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
    expect(cliInternals.mergeRuntimeDatabaseConfig(undefined, cliInternals.createEnvRuntimeConfig())).toEqual(
      cliInternals.createEnvRuntimeConfig().db,
    )
    expect(cliInternals.mergeRuntimeDatabaseConfig({
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
    expect(cliInternals.mergeRuntimeDatabaseConfig({
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
    expect(cliInternals.mergeRuntimeDatabaseConfig({}, {
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
    expect(cliInternals.mergeRuntimeDatabaseConfig({
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
    expect(cliInternals.mergeRuntimeDatabaseConfig({
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
    expect(cliInternals.resolveConfigModuleUrl()).toContain('/config/dist/index.mjs')
    expect(cliInternals.resolveConfigModuleUrl(specifier => `mock:${specifier}`)).toBe('mock:@holo-js/config')
    expect(cliInternals.resolveConfigModuleUrl(null as never)).toContain('/node_modules/@holo-js/config/dist/index.mjs')
    expect(cliInternals.resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.ts')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    expect(cliInternals.resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.mts')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    expect(cliInternals.resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.js')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    expect(cliInternals.resolveConfigModuleUrl(() => pathToFileURL(join(workspaceRoot, 'packages/config/src/index.mjs')).href))
      .toBe(pathToFileURL(join(workspaceRoot, 'packages/config/dist/index.mjs')).href)
    await expect(cliInternals.resolvePackageManagerInstallInvocation(projectRoot)).resolves.toEqual({
      command: 'bun',
      args: ['install'],
    })
    const installIo = createIo(projectRoot)
    const spawnInstall = vi.fn(() => ({
      status: 0,
      stdout: 'installed ok\n',
      stderr: 'warning\n',
    }))
    await expect(cliInternals.runProjectDependencyInstall(installIo.io, projectRoot, spawnInstall as never)).resolves.toBeUndefined()
    expect(installIo.read().stdout).toContain('installed ok')
    expect(installIo.read().stderr).toContain('warning')
    const spawnInstallFailure = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'install failed',
    }))
    await expect(cliInternals.runProjectDependencyInstall(installIo.io, projectRoot, spawnInstallFailure as never))
      .rejects.toThrow('install failed')
    const spawnInstallSilentFailure = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: '',
    }))
    await expect(cliInternals.runProjectDependencyInstall(installIo.io, projectRoot, spawnInstallSilentFailure as never))
      .rejects.toThrow('Project dependency installation failed.')

    await expect(cliInternals.fileExists(notePath)).resolves.toBe(true)
    await expect(cliInternals.fileExists(join(projectRoot, 'missing.txt'))).resolves.toBe(false)
    await expect(cliInternals.hasProjectDependency(join(projectRoot, 'missing-project'), '@holo-js/queue')).resolves.toBe(false)
    await writeFile(join(projectRoot, 'package.json'), '{ invalid json', 'utf8')
    await expect(cliInternals.hasProjectDependency(projectRoot, '@holo-js/queue')).resolves.toBe(false)
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      dependencies: {
        '@holo-js/queue': outdatedHoloPackageRange,
      },
    }), 'utf8')
    await expect(cliInternals.hasProjectDependency(projectRoot, '@holo-js/queue')).resolves.toBe(true)
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      devDependencies: {
        '@holo-js/queue': outdatedHoloPackageRange,
      },
    }), 'utf8')
    await expect(cliInternals.hasProjectDependency(projectRoot, '@holo-js/queue')).resolves.toBe(true)
    await expect(cliInternals.ensureAbsent(join(projectRoot, 'missing.txt'))).resolves.toBeUndefined()
    await expect(cliInternals.ensureAbsent(notePath)).rejects.toThrow('Refusing to overwrite existing file')

    const migrationsDir = join(projectRoot, 'server/db/migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20000101000000_create_users_table.ts'), '')
    const template = await cliInternals.nextMigrationTemplate('create_users_table', migrationsDir)
    expect(template.fileName).toMatch(/create_users_table/)

    const collisionNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(collisionNow)
    try {
      const firstCollisionTemplate = await cliInternals.nextMigrationTemplate('create_posts_table', migrationsDir)
      await writeFile(join(migrationsDir, firstCollisionTemplate.fileName), '')
      const collisionTemplate = await cliInternals.nextMigrationTemplate('create_posts_table', migrationsDir)
      expect(collisionTemplate.fileName).not.toBe(firstCollisionTemplate.fileName)
    } finally {
      nowSpy.mockRestore()
    }

    const listIo = createIo(projectRoot)
    const registry: Array<ReturnType<typeof cliInternals.createAppCommandDefinition>> = []
    const runtimeCalls: Array<{ kind: string, options: Record<string, unknown> }> = []
    const context = {
      ...listIo.io,
      projectRoot,
      registry,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const runtimeExecutor = async <T>(
      _projectRoot: string,
      kind: 'migrate' | 'fresh' | 'rollback' | 'seed' | 'prune',
      options: Record<string, unknown>,
      callback: (stdout: string) => Promise<T>,
    ): Promise<T> => {
      runtimeCalls.push({ kind, options })
      return callback(
        kind === 'prune'
          ? 'User: deleted 2\nTotal deleted: 2'
          : kind === 'fresh'
            ? 'Dropped all tables\nRe-ran all migrations'
            : '',
      )
    }
    const internal = cliInternals.createInternalCommands(context, runtimeExecutor)
    registry.push(...internal)

    await expect(internal.find(command => command.name === 'list')?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: context.loadProject,
    } as never)).resolves.toBeUndefined()

    await expect(internal.find(command => command.name === 'make:factory')!.prepare!({ args: [], flags: {} }, context))
      .rejects.toThrow('Missing required argument: Factory name.')

    const makeModelPrepared = await internal.find(command => command.name === 'make:model')!.prepare!(
      { args: ['Course'], flags: {} },
      context,
    )
    expect(makeModelPrepared).toEqual({
      args: ['Course'],
      flags: {
        migration: false,
        observer: false,
        seeder: false,
        factory: false,
      },
    })

    const makeModelPreparedWithAliases = await internal.find(command => command.name === 'make:model')!.prepare!(
      { args: ['Admin'], flags: { table: 'users', m: true, o: true, s: true, f: true } },
      context,
    )
    expect(makeModelPreparedWithAliases).toEqual({
      args: ['Admin'],
      flags: {
        table: 'users',
        migration: true,
        observer: true,
        seeder: true,
        factory: true,
      },
    })

    const migratePrepared = await internal.find(command => command.name === 'migrate')!.prepare!({ args: [], flags: { step: '2' } }, context)
    await internal.find(command => command.name === 'migrate')!.run({
      projectRoot,
      cwd: projectRoot,
      args: migratePrepared.args,
      flags: migratePrepared.flags,
      loadProject: context.loadProject,
    })

    const freshPrepared = await internal.find(command => command.name === 'migrate:fresh')!.prepare!(
      { args: [], flags: { seed: true, only: 'roles,users', quietly: true, force: true } },
      context,
    )
    await internal.find(command => command.name === 'migrate:fresh')!.run({
      projectRoot,
      cwd: projectRoot,
      args: freshPrepared.args,
      flags: freshPrepared.flags,
      loadProject: context.loadProject,
    })

    const previousAppEnv = process.env.APP_ENV
    process.env.APP_ENV = 'staging'
    try {
      const freshPreparedWithoutOnly = await internal.find(command => command.name === 'migrate:fresh')!.prepare!(
        { args: [], flags: { seed: true } },
        context,
      )
      await internal.find(command => command.name === 'migrate:fresh')!.run({
        projectRoot,
        cwd: projectRoot,
        args: freshPreparedWithoutOnly.args,
        flags: freshPreparedWithoutOnly.flags,
        loadProject: context.loadProject,
      })
    } finally {
      if (typeof previousAppEnv === 'undefined') {
        delete process.env.APP_ENV
      } else {
        process.env.APP_ENV = previousAppEnv
      }
    }

    const rollbackPrepared = await internal.find(command => command.name === 'migrate:rollback')!.prepare!({ args: [], flags: { step: '1', batch: '3' } }, context)
    await internal.find(command => command.name === 'migrate:rollback')!.run({
      projectRoot,
      cwd: projectRoot,
      args: rollbackPrepared.args,
      flags: rollbackPrepared.flags,
      loadProject: context.loadProject,
    })

    const seedPrepared = await internal.find(command => command.name === 'seed')!.prepare!({ args: [], flags: { only: 'roles,users', quietly: true, force: true } }, context)
    const seedPreparedRepeated = await internal.find(command => command.name === 'seed')!.prepare!({ args: [], flags: { only: ['users', 'roles'], quietly: true, force: true } }, context)
    await internal.find(command => command.name === 'seed')!.run({
      projectRoot,
      cwd: projectRoot,
      args: seedPrepared.args,
      flags: seedPrepared.flags,
      loadProject: context.loadProject,
    })
    expect(seedPreparedRepeated.flags.only).toEqual(['users', 'roles'])

    const prunePrepared = await internal.find(command => command.name === 'prune')!.prepare!({ args: ['User'], flags: {} }, context)
    await internal.find(command => command.name === 'prune')!.run({
      projectRoot,
      cwd: projectRoot,
      args: prunePrepared.args,
      flags: prunePrepared.flags,
      loadProject: context.loadProject,
    })

    const emptyRuntimeCalls: Array<{ kind: string, options: Record<string, unknown> }> = []
    const emptyOutputIo = createIo(projectRoot)
    const fallbackContext = {
      ...emptyOutputIo.io,
      projectRoot,
      registry: [] as typeof registry,
      loadProject: context.loadProject,
    }
    const fallbackInternal = cliInternals.createInternalCommands(
      fallbackContext,
      async <T>(
        _projectRoot: string,
        kind: 'migrate' | 'fresh' | 'rollback' | 'seed' | 'prune',
        options: Record<string, unknown>,
        callback: (stdout: string) => Promise<T>,
      ): Promise<T> => {
        emptyRuntimeCalls.push({ kind, options })
        return callback('')
      },
    )
    delete process.env.APP_ENV
    delete process.env.NODE_ENV

    const migratePreparedWithoutFlags = await fallbackInternal.find(command => command.name === 'migrate')!.prepare!({ args: [], flags: {} }, fallbackContext)
    await fallbackInternal.find(command => command.name === 'migrate')!.run({
      projectRoot,
      cwd: projectRoot,
      args: migratePreparedWithoutFlags.args,
      flags: migratePreparedWithoutFlags.flags,
      loadProject: context.loadProject,
    })

    const freshPreparedWithoutFlags = await fallbackInternal.find(command => command.name === 'migrate:fresh')!.prepare!({ args: [], flags: {} }, fallbackContext)
    await fallbackInternal.find(command => command.name === 'migrate:fresh')!.run({
      projectRoot,
      cwd: projectRoot,
      args: freshPreparedWithoutFlags.args,
      flags: freshPreparedWithoutFlags.flags,
      loadProject: context.loadProject,
    })

    const freshPreparedWithSeedWithoutEnv = await fallbackInternal.find(command => command.name === 'migrate:fresh')!.prepare!({ args: [], flags: { seed: true } }, fallbackContext)
    await fallbackInternal.find(command => command.name === 'migrate:fresh')!.run({
      projectRoot,
      cwd: projectRoot,
      args: freshPreparedWithSeedWithoutEnv.args,
      flags: freshPreparedWithSeedWithoutEnv.flags,
      loadProject: context.loadProject,
    })

    const rollbackPreparedWithoutFlags = await fallbackInternal.find(command => command.name === 'migrate:rollback')!.prepare!({ args: [], flags: {} }, fallbackContext)
    await fallbackInternal.find(command => command.name === 'migrate:rollback')!.run({
      projectRoot,
      cwd: projectRoot,
      args: rollbackPreparedWithoutFlags.args,
      flags: rollbackPreparedWithoutFlags.flags,
      loadProject: context.loadProject,
    })

    const seedPreparedWithoutFlags = await fallbackInternal.find(command => command.name === 'seed')!.prepare!({ args: [], flags: {} }, fallbackContext)
    await fallbackInternal.find(command => command.name === 'seed')!.run({
      projectRoot,
      cwd: projectRoot,
      args: seedPreparedWithoutFlags.args,
      flags: seedPreparedWithoutFlags.flags,
      loadProject: context.loadProject,
    })

    const pruneAllPrepared = await fallbackInternal.find(command => command.name === 'prune')!.prepare!({ args: [], flags: {} }, fallbackContext)
    await fallbackInternal.find(command => command.name === 'prune')!.run({
      projectRoot,
      cwd: projectRoot,
      args: pruneAllPrepared.args,
      flags: pruneAllPrepared.flags,
      loadProject: context.loadProject,
    })

    expect(runtimeCalls).toEqual([
      { kind: 'migrate', options: { step: 2 } },
      { kind: 'fresh', options: { seed: false } },
      { kind: 'seed', options: { only: ['roles', 'users'], quietly: true, force: true, environment: 'test' } },
      { kind: 'fresh', options: { seed: false } },
      { kind: 'seed', options: { quietly: false, force: false, environment: 'staging' } },
      { kind: 'rollback', options: { step: 1, batch: 3 } },
      { kind: 'seed', options: { only: ['roles', 'users'], quietly: true, force: true, environment: 'test' } },
      { kind: 'prune', options: { models: ['User'] } },
    ])
    expect(emptyRuntimeCalls).toEqual([
      { kind: 'migrate', options: {} },
      { kind: 'fresh', options: { seed: false } },
      { kind: 'fresh', options: { seed: false } },
      { kind: 'seed', options: { quietly: false, force: false, environment: 'development' } },
      { kind: 'rollback', options: {} },
      { kind: 'seed', options: { quietly: false, force: false, environment: 'development' } },
      { kind: 'prune', options: { models: [] } },
    ])
    expect(listIo.read().stdout).toContain('Internal Commands')
    expect(listIo.read().stdout).toContain('holo migrate:fresh [--seed] [--only a,b,c] [--quietly] [--force]')
    expect(listIo.read().stdout).toContain('Dropped all tables')
    expect(listIo.read().stdout).toContain('Re-ran all migrations')
    expect(emptyOutputIo.read().stdout).toContain('No migrations were executed.')
    expect(emptyOutputIo.read().stdout).toContain('No seeders were executed.')

    await expect(cliInternals.cacheProjectConfig(projectRoot, async () => {
      throw new Error('cache failed')
    })).rejects.toThrow('cache failed')
    await expect(cliInternals.cacheProjectConfig(projectRoot, async () => {
      throw 'cache failed from stdout'
    })).rejects.toThrow('Failed to cache config.')

    const configClear = internal.find(command => command.name === 'config:clear')
    await writeProjectFile(projectRoot, '.holo-js/generated/config-cache.json', '{}')
    await configClear!.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: context.loadProject,
    })
    await configClear!.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: context.loadProject,
    })
    expect(listIo.read().stdout).toContain('Config cache cleared:')
    expect(listIo.read().stdout).toContain('Config cache was already clear:')
  })

  it('runs generator internals in-process', async () => {
    const modelProjectRoot = await createTempProject()
    tempDirs.push(modelProjectRoot)
    await linkWorkspaceDb(modelProjectRoot)

    const modelIo = createIo(modelProjectRoot)
    await withFakeBun(async () => {
      await cliInternals.runMakeModel(modelIo.io, modelProjectRoot, {
        args: ['courses/Course'],
        flags: {
          migration: true,
          observer: true,
          seeder: true,
          factory: true,
        },
      })
    })
    expect(modelIo.read().stdout).toContain('Created model: server/models/courses/Course.ts')

    await expect(withFakeBun(async () => {
      await cliInternals.runMakeModel(modelIo.io, modelProjectRoot, {
        args: ['courses/Course'],
        flags: {
          migration: true,
          observer: true,
          seeder: true,
          factory: true,
        },
      })
    })).rejects.toThrow('Model with the same name already exists')

    const plainModelProjectRoot = await createTempProject()
    tempDirs.push(plainModelProjectRoot)
    await linkWorkspaceDb(plainModelProjectRoot)
    const plainModelIo = createIo(plainModelProjectRoot)
    await withFakeBun(async () => {
      await cliInternals.runMakeModel(plainModelIo.io, plainModelProjectRoot, {
        args: ['Lesson'],
        flags: {
          migration: false,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })
    await expect(readFile(join(plainModelProjectRoot, 'server/models/Lesson.ts'), 'utf8')).resolves.not.toContain('observers:')

    const sharedTableProjectRoot = await createTempProject()
    tempDirs.push(sharedTableProjectRoot)
    await linkWorkspaceDb(sharedTableProjectRoot)
    const sharedTableIo = createIo(sharedTableProjectRoot)
    await withFakeBun(async () => {
      await cliInternals.runMakeModel(sharedTableIo.io, sharedTableProjectRoot, {
        args: ['User'],
        flags: {
          migration: true,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })
    await expect(withFakeBun(async () => {
      await cliInternals.runMakeModel(sharedTableIo.io, sharedTableProjectRoot, {
        args: ['Admin'],
        flags: {
          table: 'users',
          migration: false,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })).rejects.toThrow('Discovered duplicate model "User"')
    await expect(withFakeBun(async () => {
      await cliInternals.runMakeModel(sharedTableIo.io, sharedTableProjectRoot, {
        args: ['Person'],
        flags: {
          table: 'users',
          migration: true,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })).rejects.toThrow('A migration for table "users" already exists.')

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
    await expect(withFakeBun(async () => {
      await cliInternals.runMakeModel(createIo(duplicateMigrationModelRoot).io, duplicateMigrationModelRoot, {
        args: ['Lesson'],
        flags: {
          migration: true,
          observer: false,
          seeder: false,
          factory: false,
        },
      })
    })).rejects.toThrow('A migration for table "lessons" already exists.')

    const modelCommandRoot = await createTempProject()
    tempDirs.push(modelCommandRoot)
    await linkWorkspaceDb(modelCommandRoot)
    const modelCommandIo = createIo(modelCommandRoot)
    const modelCommandContext = {
      ...modelCommandIo.io,
      projectRoot: modelCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const modelCommands = cliInternals.createInternalCommands(modelCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
    const makeModel = modelCommands.find(command => command.name === 'make:model')
    await expect(withFakeBun(async () => makeModel?.run({
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
    } as never))).resolves.toBeUndefined()
    expect(modelCommandIo.read().stdout).toContain('Created model: server/models/Course.ts')

    const migrationProjectRoot = await createTempProject()
    tempDirs.push(migrationProjectRoot)
    await linkWorkspaceDb(migrationProjectRoot)
    const migrationIo = createIo(migrationProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeMigration(migrationIo.io, migrationProjectRoot, {
      args: ['create_roles_table'],
      flags: {},
    }))
    expect(migrationIo.read().stdout).toContain('Created migration: server/db/migrations/')

    await expect(withFakeBun(async () => cliInternals.runMakeMigration(migrationIo.io, migrationProjectRoot, {
      args: ['create_roles_table'],
      flags: {},
    }))).rejects.toThrow('A migration named "create_roles_table" already exists')

    const createMigrationProjectRoot = await createTempProject()
    tempDirs.push(createMigrationProjectRoot)
    await linkWorkspaceDb(createMigrationProjectRoot)
    const createMigrationIo = createIo(createMigrationProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeMigration(createMigrationIo.io, createMigrationProjectRoot, {
      args: ['create_audit_logs_table'],
      flags: { create: 'audit_logs' },
    }))
    expect(createMigrationIo.read().stdout).toContain('Created migration: server/db/migrations/')
    await expect(withFakeBun(async () => cliInternals.runMakeMigration(createMigrationIo.io, createMigrationProjectRoot, {
      args: ['create_audit_logs_table'],
      flags: { create: 'audit_logs' },
    }))).rejects.toThrow('A migration for table "audit_logs" already exists')
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
    await withFakeBun(async () => cliInternals.runMakeMigration(createMigrationScanIo.io, createMigrationScanRoot, {
      args: ['create_projects_table'],
      flags: { create: 'projects' },
    }))
    expect(createMigrationScanIo.read().stdout).toContain('Created migration: server/db/migrations/')

    const alterMigrationProjectRoot = await createTempProject()
    tempDirs.push(alterMigrationProjectRoot)
    await linkWorkspaceDb(alterMigrationProjectRoot)
    const alterMigrationIo = createIo(alterMigrationProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeMigration(alterMigrationIo.io, alterMigrationProjectRoot, {
      args: ['add_status_to_users_table'],
      flags: { table: 'users' },
    }))
    expect(alterMigrationIo.read().stdout).toContain('Created migration: server/db/migrations/')
    await expect(withFakeBun(async () => cliInternals.runMakeMigration(alterMigrationIo.io, alterMigrationProjectRoot, {
      args: ['add_status_to_users_table'],
      flags: { table: 'users' },
    }))).rejects.toThrow('A migration named "add_status_to_users_table" already exists')
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
    await withFakeBun(async () => cliInternals.runMakeSeeder(seederIo.io, seederProjectRoot, {
      args: ['RoleSeeder'],
      flags: {},
    }))
    expect(seederIo.read().stdout).toContain('Created seeder: server/db/seeders/RoleSeeder.ts')

    const markdownMailProjectRoot = await createTempProject()
    tempDirs.push(markdownMailProjectRoot)
    const markdownMailIo = createIo(markdownMailProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeMail(markdownMailIo.io, markdownMailProjectRoot, {
      args: ['auth/verify-email'],
      flags: { type: 'markdown' },
    }))
    expect(markdownMailIo.read().stdout).toContain('Created mail: server/mail/auth/verify-email.ts')
    await expect(readFile(join(markdownMailProjectRoot, 'server/mail/auth/verify-email.ts'), 'utf8')).resolves.toContain('defineMail')
    await expect(withFakeBun(async () => cliInternals.runMakeMail(markdownMailIo.io, markdownMailProjectRoot, {
      args: ['auth/verify-email'],
      flags: { type: 'markdown' },
    }))).rejects.toThrow('Refusing to overwrite existing file')

    const viewMailProjectRoot = await createTempProject()
    tempDirs.push(viewMailProjectRoot)
    const viewMailIo = createIo(viewMailProjectRoot)
    await expect(withFakeBun(async () => cliInternals.runMakeMail(viewMailIo.io, viewMailProjectRoot, {
      args: ['billing/invoice-paid'],
      flags: { type: 'view' },
    }))).rejects.toThrow('View-backed mail scaffolding requires a renderView runtime binding')
    await expect(stat(join(viewMailProjectRoot, 'server/mail/billing/invoice-paid.ts'))).rejects.toThrow()
    await expect(stat(join(viewMailProjectRoot, 'server/mail/billing/invoice-paid.view.ts'))).rejects.toThrow()
    expect(renderNuxtMailViewTemplate('ExampleMailInput', './example')).toContain('defineProps<ExampleMailInput>()')
    expect(renderSvelteMailViewTemplate('ExampleMailInput', './example')).toContain('export let to: ExampleMailInput[\'to\']')
    expect(renderGenericMailViewTemplate('ExampleMail', 'ExampleMailInput', './example')).toContain('ExampleMailInput')

    const brokenPackageMailProjectRoot = await createTempProject()
    tempDirs.push(brokenPackageMailProjectRoot)
    await writeProjectFile(brokenPackageMailProjectRoot, 'package.json', '{')
    await expect(generatorInternals.resolveProjectMailViewFramework(brokenPackageMailProjectRoot)).resolves.toBe('generic')

    const nuxtMailProjectRoot = await createTempProject()
    tempDirs.push(nuxtMailProjectRoot)
    await writeProjectFile(nuxtMailProjectRoot, 'package.json', JSON.stringify({
      name: 'nuxt-mail-fixture',
      private: true,
      dependencies: {
        nuxt: expectedNuxtPackageRange,
      },
    }, null, 2))
    await expect(generatorInternals.resolveProjectMailViewFramework(nuxtMailProjectRoot)).resolves.toBe('nuxt')

    const nextMailProjectRoot = await createTempProject()
    tempDirs.push(nextMailProjectRoot)
    await writeProjectFile(nextMailProjectRoot, 'package.json', JSON.stringify({
      name: 'next-mail-fixture',
      private: true,
      dependencies: {
        next: expectedNextPackageRange,
      },
    }, null, 2))
    await expect(generatorInternals.resolveProjectMailViewFramework(nextMailProjectRoot)).resolves.toBe('next')

    const svelteMailProjectRoot = await createTempProject()
    tempDirs.push(svelteMailProjectRoot)
    await writeProjectFile(svelteMailProjectRoot, 'package.json', JSON.stringify({
      name: 'svelte-mail-fixture',
      private: true,
      dependencies: {
        '@sveltejs/kit': expectedSvelteKitPackageRange,
      },
    }, null, 2))
    await expect(generatorInternals.resolveProjectMailViewFramework(svelteMailProjectRoot)).resolves.toBe('sveltekit')

    const genericMailProjectRoot = await createTempProject()
    tempDirs.push(genericMailProjectRoot)
    await writeProjectFile(genericMailProjectRoot, 'package.json', JSON.stringify({
      name: 'generic-mail-fixture',
      private: true,
      dependencies: {},
      devDependencies: {},
    }, null, 2))
    await expect(generatorInternals.resolveProjectMailViewFramework(genericMailProjectRoot)).resolves.toBe('generic')

    const genericMailProjectNoDepsRoot = await createTempProject()
    tempDirs.push(genericMailProjectNoDepsRoot)
    await writeProjectFile(genericMailProjectNoDepsRoot, 'package.json', JSON.stringify({
      name: 'generic-mail-no-deps-fixture',
      private: true,
    }, null, 2))
    await expect(generatorInternals.resolveProjectMailViewFramework(genericMailProjectNoDepsRoot)).resolves.toBe('generic')

    const jobProjectRoot = await createTempProject()
    tempDirs.push(jobProjectRoot)
    const jobIo = createIo(jobProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeJob(jobIo.io, jobProjectRoot, {
      args: ['media/GenerateConversions'],
      flags: {},
    }))
    expect(jobIo.read().stdout).toContain('Created job: server/jobs/media/generate-conversions.ts')
    await expect(readFile(join(jobProjectRoot, 'server/jobs/media/generate-conversions.ts'), 'utf8')).resolves.toContain('defineJob')
    await expect(withFakeBun(async () => cliInternals.runMakeJob(jobIo.io, jobProjectRoot, {
      args: ['media/generate-conversions'],
      flags: {},
    }))).rejects.toThrow('Job with the same name already exists: media.generate-conversions.')
    await withFakeBun(async () => cliInternals.runMakeJob(jobIo.io, jobProjectRoot, {
      args: ['SendDigest'],
      flags: {},
    }))
    expect(jobIo.read().stdout).toContain('Created job: server/jobs/send-digest.ts')
    await expect(withFakeBun(async () => cliInternals.runMakeJob(jobIo.io, jobProjectRoot, {
      args: [],
      flags: {},
    }))).rejects.toThrow('A name is required.')

    const eventProjectRoot = await createTempProject()
    tempDirs.push(eventProjectRoot)
    const eventIo = createIo(eventProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeEvent(eventIo.io, eventProjectRoot, {
      args: ['user/registered'],
      flags: {},
    }))
    expect(eventIo.read().stdout).toContain('Created event: server/events/user/registered.ts')
    await expect(readFile(join(eventProjectRoot, 'server/events/user/registered.ts'), 'utf8')).resolves.toContain('defineEvent')
    await expect(withFakeBun(async () => cliInternals.runMakeEvent(eventIo.io, eventProjectRoot, {
      args: ['user/registered'],
      flags: {},
    }))).rejects.toThrow('Event with the same name already exists: user.registered.')
    await expect(withFakeBun(async () => cliInternals.runMakeEvent(eventIo.io, eventProjectRoot, {
      args: [],
      flags: {},
    }))).rejects.toThrow('A name is required.')
    await withFakeBun(async () => cliInternals.runMakeEvent(eventIo.io, eventProjectRoot, {
      args: ['OrderPlaced'],
      flags: {},
    }))
    expect(eventIo.read().stdout).toContain('Created event: server/events/order-placed.ts')

    const broadcastProjectRoot = await createTempProject()
    tempDirs.push(broadcastProjectRoot)
    await linkWorkspaceBroadcast(broadcastProjectRoot)
    const broadcastIo = createIo(broadcastProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: ['orders/shipment-updated'],
      flags: {},
    }))
    expect(broadcastIo.read().stdout).toContain('Created broadcast: server/broadcast/orders/shipment-updated.ts')
    await expect(readFile(join(broadcastProjectRoot, 'server/broadcast/orders/shipment-updated.ts'), 'utf8')).resolves.toContain('defineBroadcast')
    await expect(withFakeBun(async () => cliInternals.runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: ['orders/shipment-updated'],
      flags: {},
    }))).rejects.toThrow('Broadcast with the same name already exists: orders.shipment-updated.')
    await withFakeBun(async () => cliInternals.runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: ['ShipmentUpdated'],
      flags: {},
    }))
    expect(broadcastIo.read().stdout).toContain('Created broadcast: server/broadcast/shipment-updated.ts')
    await expect(withFakeBun(async () => cliInternals.runMakeBroadcast(broadcastIo.io, broadcastProjectRoot, {
      args: [],
      flags: {},
    }))).rejects.toThrow('A name is required.')

    const channelProjectRoot = await createTempProject()
    tempDirs.push(channelProjectRoot)
    await linkWorkspaceBroadcast(channelProjectRoot)
    const channelIo = createIo(channelProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.{orderId}'],
      flags: {},
    }))
    expect(channelIo.read().stdout).toContain('Created channel: server/channels/orders-order-id.ts')
    await expect(readFile(join(channelProjectRoot, 'server/channels/orders-order-id.ts'), 'utf8')).resolves.toContain('defineChannel')
    await withFakeBun(async () => cliInternals.runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.{id}'],
      flags: {},
    }))
    await withFakeBun(async () => cliInternals.runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.id'],
      flags: {},
    }))
    const generatedChannelFiles = await readdir(join(channelProjectRoot, 'server/channels'))
    expect(generatedChannelFiles).toHaveLength(3)
    await expect(Promise.all(generatedChannelFiles.map(async (fileName) => {
      return await readFile(join(channelProjectRoot, 'server/channels', fileName), 'utf8')
    }))).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining("defineChannel('orders.{orderId}'"),
      expect.stringContaining("defineChannel('orders.{id}'"),
      expect.stringContaining("defineChannel('orders.id'"),
    ]))
    await expect(withFakeBun(async () => cliInternals.runMakeChannel(channelIo.io, channelProjectRoot, {
      args: ['orders.{orderId}'],
      flags: {},
    }))).rejects.toThrow('Channel with the same pattern already exists: orders.{orderId}.')
    await expect(withFakeBun(async () => cliInternals.runMakeChannel(channelIo.io, channelProjectRoot, {
      args: [],
      flags: {},
    }))).rejects.toThrow('A channel pattern is required.')
    expect(generatorInternals.toChannelTemplateFileStem('{}')).toBe('channel')
    expect(generatorInternals.toChannelTemplateFileStem('{orderId}')).not.toBe(generatorInternals.toChannelTemplateFileStem('{order-id}'))
    await expect(withFakeBun(async () => cliInternals.runMakeChannel(channelIo.io, channelProjectRoot, {
      args: [''],
      flags: {},
    }))).rejects.toThrow('A channel pattern is required.')

    const listenerProjectRoot = await createTempProject()
    tempDirs.push(listenerProjectRoot)
    await linkWorkspaceDb(listenerProjectRoot)
    const listenerIo = createIo(listenerProjectRoot)
    await writeProjectFile(listenerProjectRoot, 'server/events/user/registered.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`)
    await withFakeBun(async () => prepareProjectDiscovery(listenerProjectRoot))
    await writeProjectFile(listenerProjectRoot, 'server/events/audit/activity.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'audit.activity' })
`)
    await withFakeBun(async () => prepareProjectDiscovery(listenerProjectRoot))
    await withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/send-welcome-email'],
      flags: { event: 'user.registered' },
    }))
    expect(listenerIo.read().stdout).toContain('Created listener: server/listeners/user/send-welcome-email.ts')
    await expect(readFile(join(listenerProjectRoot, 'server/listeners/user/send-welcome-email.ts'), 'utf8')).resolves.toContain('defineListener')
    await expect(withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/send-welcome-email'],
      flags: { event: 'user.registered' },
    }))).rejects.toThrow('Listener with the same id already exists: user.send-welcome-email.')
    await expect(withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/other'],
      flags: { event: 'missing.event' },
    }))).rejects.toThrow('Unknown event: missing.event.')
    await expect(withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: [],
      flags: { event: 'user.registered' },
    }))).rejects.toThrow('A name is required.')
    await expect(withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: [],
      flags: {},
    }))).rejects.toThrow('A name is required.')
    await withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/audit-user-events'],
      flags: { event: ['user.registered', 'audit.activity'] },
    }))
    await expect(readFile(join(listenerProjectRoot, 'server/listeners/user/audit-user-events.ts'), 'utf8')).resolves.toContain(
      'listensTo: [RegisteredEvent1, ActivityEvent2]',
    )
    await writeProjectFile(listenerProjectRoot, 'server/events/audit/activity-named.ts', `
import { defineEvent } from '@holo-js/events'
export const ActivityRecorded = defineEvent({ name: 'audit.activity.named' })
`)
    await withFakeBun(async () => prepareProjectDiscovery(listenerProjectRoot))
    await withFakeBun(async () => cliInternals.runMakeListener(listenerIo.io, listenerProjectRoot, {
      args: ['user/audit-named-event'],
      flags: { event: 'audit.activity.named' },
    }))
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
    await withFakeBun(async () => cliInternals.runMakeListener(listenerFallbackIo.io, listenerFallbackProjectRoot, {
      args: ['SendInline'],
      flags: { event: 'user.registered' },
    }))
    expect(listenerFallbackIo.read().stdout).toContain('Created listener: server/listeners/send-inline.ts')

    const observerProjectRoot = await createTempProject()
    tempDirs.push(observerProjectRoot)
    await linkWorkspaceDb(observerProjectRoot)
    const observerIo = createIo(observerProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeObserver(observerIo.io, observerProjectRoot, {
      args: ['RoleObserver'],
      flags: {},
    }))
    expect(observerIo.read().stdout).toContain('Created observer: server/db/observers/RoleObserver.ts')

    const factoryProjectRoot = await createTempProject()
    tempDirs.push(factoryProjectRoot)
    await linkWorkspaceDb(factoryProjectRoot)
    const factoryIo = createIo(factoryProjectRoot)
    await withFakeBun(async () => cliInternals.runMakeFactory(factoryIo.io, factoryProjectRoot, {
      args: ['RoleFactory'],
      flags: {},
    }))
    expect(factoryIo.read().stdout).toContain('Created factory: server/db/factories/RoleFactory.ts')

    const migrationCommandRoot = await createTempProject()
    tempDirs.push(migrationCommandRoot)
    await linkWorkspaceDb(migrationCommandRoot)
    const migrationCommandIo = createIo(migrationCommandRoot)
    const migrationCommandContext = {
      ...migrationCommandIo.io,
      projectRoot: migrationCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const migrationCommands = cliInternals.createInternalCommands(migrationCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
    const makeMigration = migrationCommands.find(command => command.name === 'make:migration')
    const preparedMigration = await makeMigration?.prepare?.({ args: ['create_lessons_table'], flags: {} }, migrationCommandContext as never)
    const preparedCreateMigration = await makeMigration?.prepare?.({ args: ['create_audits_table'], flags: { create: 'audits' } }, migrationCommandContext as never)
    const preparedAlterMigration = await makeMigration?.prepare?.({ args: ['add_status_to_lessons_table'], flags: { table: 'lessons' } }, migrationCommandContext as never)
    await expect(withFakeBun(async () => makeMigration?.run({
      projectRoot: migrationCommandRoot,
      cwd: migrationCommandRoot,
      args: preparedMigration?.args ?? [],
      flags: preparedMigration?.flags ?? {},
      loadProject: migrationCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()
    expect(preparedCreateMigration?.flags).toMatchObject({ create: 'audits' })
    expect(preparedAlterMigration?.flags).toMatchObject({ table: 'lessons' })
    await expect(makeMigration?.prepare?.({
      args: ['bad'],
      flags: { create: 'users', table: 'users' },
    }, migrationCommandContext as never)).rejects.toThrow('Use either "--create" or "--table", not both.')
    await expect(withFakeBun(async () => cliInternals.runMakeMigration(migrationCommandIo.io, migrationCommandRoot, {
      args: ['bad'],
      flags: { create: 'users', table: 'users' },
    }))).rejects.toThrow('Use either "--create" or "--table", not both.')

    const seederCommandRoot = await createTempProject()
    tempDirs.push(seederCommandRoot)
    await linkWorkspaceDb(seederCommandRoot)
    const seederCommandIo = createIo(seederCommandRoot)
    const seederCommandContext = {
      ...seederCommandIo.io,
      projectRoot: seederCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const seederCommands = cliInternals.createInternalCommands(seederCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
    const makeSeeder = seederCommands.find(command => command.name === 'make:seeder')
    const preparedSeeder = await makeSeeder?.prepare?.({ args: ['LessonSeeder'], flags: {} }, seederCommandContext as never)
    await expect(withFakeBun(async () => makeSeeder?.run({
      projectRoot: seederCommandRoot,
      cwd: seederCommandRoot,
      args: preparedSeeder?.args ?? [],
      flags: preparedSeeder?.flags ?? {},
      loadProject: seederCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()

    const jobCommandRoot = await createTempProject()
    tempDirs.push(jobCommandRoot)
    await linkWorkspaceBroadcast(jobCommandRoot)
    const jobCommandIo = createIo(jobCommandRoot)
    const jobCommandContext = {
      ...jobCommandIo.io,
      projectRoot: jobCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const jobCommands = cliInternals.createInternalCommands(jobCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
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
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const promptedMakeMail = cliInternals.createInternalCommands(
      promptedMailContext,
      async (_projectRoot, _kind, _options, callback) => callback(''),
    ).find(command => command.name === 'make:mail')
    const preparedPromptedMail = await promptedMakeMail?.prepare?.({ args: ['prompted-mail'], flags: {} }, promptedMailContext as never)
    const preparedListener = await makeListener?.prepare?.({
      args: ['SendWelcomeEmail'],
      flags: { event: ['user.registered', 'audit.activity'] },
    }, jobCommandContext as never)
    await expect(withFakeBun(async () => makeEvent?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedEvent?.args ?? [],
      flags: preparedEvent?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()
    await expect(withFakeBun(async () => makeJob?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedJob?.args ?? [],
      flags: preparedJob?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()
    await expect(withFakeBun(async () => makeBroadcast?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedBroadcast?.args ?? [],
      flags: preparedBroadcast?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()
    await expect(withFakeBun(async () => makeChannel?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedChannel?.args ?? [],
      flags: preparedChannel?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()
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
    await expect(withFakeBun(async () => makeMail?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedDefaultMail?.args ?? [],
      flags: preparedDefaultMail?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()
    const interactiveMailIo = createIo(jobCommandRoot, {
      tty: true,
      input: 'view\n',
    })
    const interactiveMailContext = {
      ...interactiveMailIo.io,
      projectRoot: jobCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
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
    await expect(withFakeBun(async () => cliInternals.runMakeListener(jobCommandIo.io, jobCommandRoot, {
      args: ['SendWelcomeEmail'],
      flags: { event: 'missing.event' },
    }))).rejects.toThrow('Unknown event: missing.event.')
    await expect(withFakeBun(async () => cliInternals.runMakeJob(jobCommandIo.io, jobCommandRoot, {
      args: [],
      flags: {},
    }))).rejects.toThrow('A name is required.')
    await expect(withFakeBun(async () => cliInternals.runMakeMail(jobCommandIo.io, jobCommandRoot, {
      args: [],
      flags: { type: 'markdown' },
    }))).rejects.toThrow('A name is required.')
    await writeProjectFile(jobCommandRoot, 'server/events/audit/activity.ts', `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'audit.activity' })
`)
    await withFakeBun(async () => prepareProjectDiscovery(jobCommandRoot))
    await expect(withFakeBun(async () => makeListener?.run({
      projectRoot: jobCommandRoot,
      cwd: jobCommandRoot,
      args: preparedListener?.args ?? [],
      flags: preparedListener?.flags ?? {},
      loadProject: jobCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()

    const observerCommandRoot = await createTempProject()
    tempDirs.push(observerCommandRoot)
    await linkWorkspaceDb(observerCommandRoot)
    const observerCommandIo = createIo(observerCommandRoot)
    const observerCommandContext = {
      ...observerCommandIo.io,
      projectRoot: observerCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const observerCommands = cliInternals.createInternalCommands(observerCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
    const makeObserver = observerCommands.find(command => command.name === 'make:observer')
    const preparedObserver = await makeObserver?.prepare?.({ args: ['CourseObserver'], flags: {} }, observerCommandContext as never)
    await expect(withFakeBun(async () => makeObserver?.run({
      projectRoot: observerCommandRoot,
      cwd: observerCommandRoot,
      args: preparedObserver?.args ?? [],
      flags: preparedObserver?.flags ?? {},
      loadProject: observerCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()

    const factoryCommandRoot = await createTempProject()
    tempDirs.push(factoryCommandRoot)
    await linkWorkspaceDb(factoryCommandRoot)
    const factoryCommandIo = createIo(factoryCommandRoot)
    const factoryCommandContext = {
      ...factoryCommandIo.io,
      projectRoot: factoryCommandRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const factoryCommands = cliInternals.createInternalCommands(factoryCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
    const makeFactory = factoryCommands.find(command => command.name === 'make:factory')
    const preparedFactory = await makeFactory?.prepare?.({ args: ['CourseFactory'], flags: {} }, factoryCommandContext as never)
    await expect(withFakeBun(async () => makeFactory?.run({
      projectRoot: factoryCommandRoot,
      cwd: factoryCommandRoot,
      args: preparedFactory?.args ?? [],
      flags: preparedFactory?.flags ?? {},
      loadProject: factoryCommandContext.loadProject,
    } as never))).resolves.toBeUndefined()

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
      scripts: {
        'holo:build': 'node -e "console.log(\'build script ran\')"',
      },
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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })
    const registry = await withFakeBun(async () => loadGeneratedProjectRegistry(projectRoot))
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

    const pnpmResolution = await cliInternals.resolvePackageManagerCommand(projectRoot, 'holo:build')
    expect(pnpmResolution).toEqual({ command: 'pnpm', args: ['run', 'holo:build'] })

    const yarnRoot = await createTempDirectory()
    tempDirs.push(yarnRoot)
    await writeProjectFile(yarnRoot, 'package.json', JSON.stringify({ name: 'fixture', private: true }, null, 2))
    await writeProjectFile(yarnRoot, 'yarn.lock', '')
    await expect(cliInternals.resolvePackageManagerCommand(yarnRoot, 'holo:dev')).resolves.toEqual({
      command: 'yarn',
      args: ['run', 'holo:dev'],
    })

    const npmRoot = await createTempDirectory()
    tempDirs.push(npmRoot)
    await writeProjectFile(npmRoot, 'package.json', '{ invalid json')
    await writeProjectFile(npmRoot, 'package-lock.json', '')
    await expect(cliInternals.resolvePackageManagerCommand(npmRoot, 'holo:dev')).resolves.toEqual({
      command: 'npm',
      args: ['run', 'holo:dev'],
    })

    const defaultRoot = await createTempDirectory()
    tempDirs.push(defaultRoot)
    await expect(cliInternals.resolvePackageManagerCommand(defaultRoot, 'holo:dev')).resolves.toEqual({
      command: 'bun',
      args: ['run', 'holo:dev'],
    })

    const bunLockRoot = await createTempDirectory()
    tempDirs.push(bunLockRoot)
    await writeProjectFile(bunLockRoot, 'bun.lock', '')
    await expect(cliInternals.resolvePackageManagerCommand(bunLockRoot, 'holo:dev')).resolves.toEqual({
      command: 'bun',
      args: ['run', 'holo:dev'],
    })

    const pnpmLockRoot = await createTempDirectory()
    tempDirs.push(pnpmLockRoot)
    await writeProjectFile(pnpmLockRoot, 'pnpm-lock.yaml', '')
    await expect(cliInternals.resolvePackageManagerCommand(pnpmLockRoot, 'holo:dev')).resolves.toEqual({
      command: 'pnpm',
      args: ['run', 'holo:dev'],
    })

    const lifecycleIo = createIo(projectRoot)
    await expect(cliInternals.runProjectLifecycleScript(lifecycleIo.io, projectRoot, 'holo:build', () => ({
      status: 0,
      stdout: 'built\n',
      stderr: 'warned\n',
      output: [],
      pid: 1,
      signal: null,
    } as never))).resolves.toBeUndefined()
    expect(lifecycleIo.read().stdout).toContain('built')
    expect(lifecycleIo.read().stderr).toContain('warned')
    await expect(cliInternals.runProjectLifecycleScript(lifecycleIo.io, projectRoot, 'holo:build', () => ({
      status: 0,
      stdout: 'built-again\n',
      stderr: '',
      output: [],
      pid: 1,
      signal: null,
    } as never))).resolves.toBeUndefined()
    expect(lifecycleIo.read().stdout).toContain('built-again')
    await expect(cliInternals.runProjectLifecycleScript(lifecycleIo.io, projectRoot, 'holo:build', () => ({
      status: 1,
      stdout: '',
      stderr: '',
      output: [],
      pid: 1,
      signal: null,
    } as never))).rejects.toThrow('Project script "holo:build" failed.')

    const buildCommandContext = {
      ...createIo(projectRoot).io,
      projectRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const buildCommands = cliInternals.createInternalCommands(buildCommandContext, async (_projectRoot, _kind, _options, callback) => callback(''))
    const buildCommand = buildCommands.find(command => command.name === 'build')
    expect(await buildCommand?.prepare?.({ args: [], flags: {} }, buildCommandContext as never)).toEqual({ args: [], flags: {} })

    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'bun@1.3.9',
      scripts: {
        'holo:dev': 'node -e "console.log(\'dev script ran\')"',
        'holo:build': 'node -e "console.log(\'build script ran\')"',
      },
    }, null, 2))
    const lifecycleCommandIo = createIo(projectRoot)
    const runPrepare = vi.fn(async () => {})
    const runDevServer = vi.fn(async () => {})
    const runLifecycleScript = vi.fn(async () => {})
    const lifecycleContext = {
      ...lifecycleCommandIo.io,
      projectRoot,
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
      loadProject: async () => ({ config: defaultProjectConfig() }),
    }
    const lifecycleCommands = cliInternals.createInternalCommands(
      lifecycleContext,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {},
      {
        runProjectPrepare: runPrepare,
        runProjectDevServer: runDevServer,
        runProjectLifecycleScript: runLifecycleScript,
      },
    )
    const prepareCommand = lifecycleCommands.find(command => command.name === 'prepare')
    const devCommand = lifecycleCommands.find(command => command.name === 'dev')
    const buildLifecycleCommand = lifecycleCommands.find(command => command.name === 'build')
    expect(await prepareCommand?.prepare?.({ args: [], flags: {} }, lifecycleContext as never)).toEqual({ args: [], flags: {} })
    expect(await devCommand?.prepare?.({ args: [], flags: {} }, lifecycleContext as never)).toEqual({ args: [], flags: {} })
    await prepareCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: lifecycleContext.loadProject,
    } as never)
    await devCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: lifecycleContext.loadProject,
    } as never)
    await buildLifecycleCommand?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: lifecycleContext.loadProject,
    } as never)
    const lifecycleOutput = lifecycleCommandIo.read().stdout
    expect(lifecycleOutput).toContain('Prepared Holo discovery artifacts.')
    expect(runPrepare).toHaveBeenCalledTimes(2)
    expect(runDevServer).toHaveBeenCalledWith(lifecycleContext, projectRoot)
    expect(runLifecycleScript).toHaveBeenCalledWith(lifecycleContext, projectRoot, 'holo:build')
  })

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    await expect(readFile(join(projectRoot, '.holo-js/generated/queue.d.ts'), 'utf8')).resolves.toContain('"send-email": ExportedQueueJobDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.updated": ExportedBroadcastDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated/broadcast.d.ts'), 'utf8')).resolves.toContain('"orders.{orderId}": ExportedChannelDefinition')
    await expect(readFile(join(projectRoot, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('"posts": {')
    await expect(readFile(join(projectRoot, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('"reports.export": {')
  }, 30000)

  it('preserves manifest connection fields when env overrides are partial', () => {
    expect(cliInternals.mergeRuntimeDatabaseConfig({
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

  it('caches config without shelling out to bun', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    const cacheWriter = vi.fn(async () => '/tmp/config-cache.json')

    await expect(cliInternals.cacheProjectConfig(projectRoot, cacheWriter)).resolves.toBe('/tmp/config-cache.json')
    expect(cacheWriter).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({
        processEnv: process.env,
      }),
    )
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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    const generatedTsconfigPath = join(projectRoot, '.holo-js/generated/tsconfig.json')
    const generatedRegistryPath = join(projectRoot, '.holo-js/generated/registry.json')
    const firstTsconfigStat = await stat(generatedTsconfigPath)
    const firstRegistryStat = await stat(generatedRegistryPath)
    const firstRegistry = JSON.parse(await readFile(generatedRegistryPath, 'utf8')) as { generatedAt: string }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    const secondTsconfigStat = await stat(generatedTsconfigPath)
    const secondRegistryStat = await stat(generatedRegistryPath)
    const secondRegistry = JSON.parse(await readFile(generatedRegistryPath, 'utf8')) as { generatedAt: string }

    expect(secondTsconfigStat.mtimeMs).toBe(firstTsconfigStat.mtimeMs)
    expect(secondRegistryStat.mtimeMs).toBeGreaterThanOrEqual(firstRegistryStat.mtimeMs)
    expect(typeof firstRegistry.generatedAt).toBe('string')
    expect(typeof secondRegistry.generatedAt).toBe('string')
    await expect(readTextFile(join(projectRoot, '.holo-js/generated/config-cache.json'))).resolves.toBeUndefined()
  })

  it('watches discovery paths during holo dev and closes cleanly on process exit', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)

    const io = createIo(projectRoot, { input: 'typed input' })
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const closeWatcher = vi.fn()

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close: closeWatcher } as unknown as FSWatcher
      }) as never,
    ))

    while (!watchCallback || child.listenerCount('close') === 0 || child.listenerCount('error') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    child.stdout.write('dev stdout\n')
    child.stderr.write('dev stderr\n')
    watchCallback?.('change', 'README.md')
    watchCallback?.('change', '.holo-js/generated/index.ts')
    watchCallback?.('change', '.env.local')
    watchCallback?.('change', 'config/app.ts')
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
await new Promise(resolve => setTimeout(resolve, 50))
throw 'string discovery failure'
`)
    watchCallback?.('change', 'server/commands/hello.mjs')
    watchCallback?.('change', 'server/commands/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 50))
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', 'export default { nope: true }')
    watchCallback?.('change', 'server/commands/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 50))
    child.emit('close', 0)
    watchCallback?.('change', 'server/commands/hello.mjs')

    await expect(devPromise).resolves.toBeUndefined()
    expect(io.read().stdout).toContain('dev stdout')
    expect(io.read().stderr).toContain('dev stderr')
    expect(io.read().stderr).toContain('string discovery failure')
    expect(io.read().stderr).toContain('does not export a Holo command')
    expect(closeWatcher).toHaveBeenCalledTimes(1)
  })

  it('refreshes discovery when broadcast, channel, and authorization source files change during holo dev', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/channels/orders.mjs', 'export default {}\n')
    await writeProjectFile(projectRoot, 'server/broadcast/orders.mjs', 'export default {}\n')
    await writeProjectFile(projectRoot, 'server/policies/PostPolicy.mjs', 'export default {}\n')
    await writeProjectFile(projectRoot, 'server/abilities/exportReports.mjs', 'export default {}\n')

    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const prepare = vi.fn(async () => {})
    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || prepare.mock.calls.length === 0 || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/channels/orders.mjs')
    await new Promise(resolve => setTimeout(resolve, 50))
    watchCallback('change', 'server/broadcast/orders.mjs')
    await new Promise(resolve => setTimeout(resolve, 50))
    watchCallback('change', 'server/policies/PostPolicy.mjs')
    await new Promise(resolve => setTimeout(resolve, 50))
    watchCallback('change', 'server/abilities/exportReports.mjs')
    await new Promise(resolve => setTimeout(resolve, 50))
    child.emit('close', 0)

    await expect(devPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(5)
  }, 15000)

  it('marks all discovery roots as relevant and collects existing authorization watch roots', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, 'server/policies/admin'), { recursive: true })
    await mkdir(join(projectRoot, 'server/abilities/reports'), { recursive: true })
    await mkdir(join(projectRoot, 'server/broadcast'), { recursive: true })
    await mkdir(join(projectRoot, 'server/channels'), { recursive: true })
    await mkdir(join(projectRoot, 'server/jobs'), { recursive: true })
    await mkdir(join(projectRoot, 'server/events'), { recursive: true })
    await mkdir(join(projectRoot, 'server/listeners'), { recursive: true })
    await mkdir(join(projectRoot, 'server/commands'), { recursive: true })
    await mkdir(join(projectRoot, 'server/models'), { recursive: true })
    await mkdir(join(projectRoot, 'server/db/migrations'), { recursive: true })
    await mkdir(join(projectRoot, 'server/db/seeders'), { recursive: true })
    const project = { config: defaultProjectConfig() }

    expect(isDiscoveryRelevantPath('config/app.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('.env.local', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('.holo-js/generated/index.ts', project as never)).toBe(false)
    expect(isDiscoveryRelevantPath('.holo-js/generated/schema.generated.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/commands/hello.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/jobs/send-email.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/events/user-registered.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/listeners/send-welcome-email.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/broadcast/orders.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/channels/orders.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/policies/PostPolicy.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/abilities/exportReports.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/models/User.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/db/migrations/2026_01_01_000000_users.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/db/seeders/UserSeeder.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('README.md', project as never)).toBe(false)

    const fallbackProject = {
      config: {
        ...defaultProjectConfig(),
        paths: {
          ...defaultProjectConfig().paths,
          authorizationPolicies: '',
          authorizationAbilities: '',
        },
      },
    }
    expect(isDiscoveryRelevantPath('server/policies/FallbackPolicy.ts', fallbackProject as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/abilities/fallback.ts', fallbackProject as never)).toBe(true)

    const roots = await collectDiscoveryWatchRoots(projectRoot, project as never)
    expect(roots).not.toContain(join(projectRoot, '.holo-js/generated'))
    expect(roots).toContain(join(projectRoot, 'server/policies'))
    expect(roots).toContain(join(projectRoot, 'server/policies/admin'))
    expect(roots).toContain(join(projectRoot, 'server/abilities'))
    expect(roots).toContain(join(projectRoot, 'server/abilities/reports'))

    const fallbackRoots = await collectDiscoveryWatchRoots(projectRoot, fallbackProject as never)
    expect(fallbackRoots).toContain(join(projectRoot, 'server/policies'))
    expect(fallbackRoots).toContain(join(projectRoot, 'server/abilities'))
  }, 20000)

  it('treats package manifests and lockfiles as discovery relevant', () => {
    const project = { config: defaultProjectConfig() }

    expect(isDiscoveryRelevantPath('package.json', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('package-lock.json', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('pnpm-lock.yaml', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('yarn.lock', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('bun.lock', project as never)).toBe(true)
  })

  it('uses configured broadcast and channel paths for holo dev discovery watches', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, 'src/broadcast/orders'), { recursive: true })
    await mkdir(join(projectRoot, 'src/channels/orders'), { recursive: true })
    const project = {
      config: {
        ...defaultProjectConfig(),
        paths: {
          ...defaultProjectConfig().paths,
          broadcast: 'src/broadcast',
          channels: 'src/channels',
        },
      },
    }

    expect(isDiscoveryRelevantPath('src/broadcast/orders/created.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('src/channels/orders/private.ts', project as never)).toBe(true)
    expect(isDiscoveryRelevantPath('server/broadcast/orders.ts', project as never)).toBe(false)
    expect(isDiscoveryRelevantPath('server/channels/orders.ts', project as never)).toBe(false)

    const roots = await collectDiscoveryWatchRoots(projectRoot, project as never)
    expect(roots).toContain(join(projectRoot, 'src/broadcast'))
    expect(roots).toContain(join(projectRoot, 'src/broadcast/orders'))
    expect(roots).toContain(join(projectRoot, 'src/channels'))
    expect(roots).toContain(join(projectRoot, 'src/channels/orders'))
  }, 20000)

  it('ignores generated discovery artifacts during holo dev watch reloads', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const prepare = vi.fn(async () => {})

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    while (prepare.mock.calls.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    prepare.mockClear()

    watchCallback('change', '.holo-js/generated/registry.json')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(prepare).toHaveBeenCalledTimes(0)

    watchCallback('change', '.holo-js/generated/schema.generated.ts')
    while (prepare.mock.calls.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(prepare).toHaveBeenCalledTimes(1)
    prepare.mockClear()

    watchCallback('change', 'config/app.ts')
    while (prepare.mock.calls.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    child.emit('close', 0)
    await expect(devPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(1)
  }, 30000)

  it('skips model files whose generated schema has not been materialized yet', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/admins/User.mjs', `
throw new Error('Model "users" is not present in the generated schema registry. Run "holo migrate" to refresh the internal generated schema metadata.')
`)

    const registry = await withFakeBun(async () => prepareProjectDiscovery(projectRoot))

    expect(registry.models).toEqual([])
  })

  it('skips scaffolded model modules that explicitly mark themselves pending generated schema', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/Course.mjs', `
export const holoModelPendingSchema = true
export default undefined
`)

    const registry = await withFakeBun(async () => prepareProjectDiscovery(projectRoot))

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    await withFakeBun(async () => {
      const registry = await loadGeneratedProjectRegistry(projectRoot)

      expect(registry).toBeDefined()
      if (!registry) {
        throw new Error('Expected generated project registry to exist after prepare.')
      }

      expect(Array.isArray(registry.models)).toBe(true)
      expect(registry.models).toEqual(expect.not.arrayContaining([
        'server/models/Course.ts',
      ]))
    })

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    const generatedTypes = await readFile(join(projectRoot, '.holo-js/generated/config.d.ts'), 'utf8')
    expect(generatedTypes).toContain('"services": typeof')
    expect(generatedTypes).not.toContain('"redis": typeof')
    expect(generatedTypes).not.toContain('"security": typeof')
  })

  it('writes a Nuxt-aware generated tsconfig during prepare', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, '.holo-js/framework/project.json', JSON.stringify({ framework: 'nuxt' }, null, 2))

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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
    await writeProjectFile(projectRoot, 'app/api/auth/clerk/login/route.ts', 'export { GET } from \'../../../../../.holo-js/generated/next/auth-clerk-login-route\'\n')

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    await expect(stat(join(projectRoot, '.holo-js/generated/next/health-route.ts'))).rejects.toThrow()
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/storage-route.ts'), 'utf8')).toContain('createPublicStorageResponse')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/broadcast-auth-route.ts'), 'utf8')).toContain('channelAuth')
    expect(await readFile(join(projectRoot, '.holo-js/generated/next/auth-clerk-login-route.ts'), 'utf8')).toContain('loginWithClerk')
  }, 30000)

  it('manages SvelteKit hook entrypoints during prepare and preserves user hook extensions separately', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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
    expect(generatedServerHooks).toContain('serializeHoloValidationException')
    expect(generatedServerHooks).toContain('adapterSvelteKitInternals.serializeValidationException(cause)')
    expect(generatedServerHooks).toContain('adapterSvelteKitInternals.mapValidationActionResponse(event, response)')
    expect(generatedServerHooks).toContain('adapterSvelteKitInternals.isApiEvent(event)')
    expect(generatedServerHooks).toContain('adapterSvelteKitInternals.rememberValidationActionFailure(input.event, validationPayload)')
    expect(generatedServerHooks).toContain('export const handleError = holoHandleError')
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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

    await expect(readFile(join(projectRoot, 'src/hooks.user.ts'), 'utf8')).resolves.toContain('export const transport')
    await expect(readFile(join(projectRoot, 'src/hooks.server.user.ts'), 'utf8')).resolves.toContain('export const handle')
  }, 30000)

  it('patches compact SvelteKit kit objects without producing invalid config', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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

    await withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })

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

    await expect(withFakeBun(async () => {
      await cliInternals.runProjectPrepare(projectRoot)
    })).rejects.toThrow('Custom SvelteKit hook entrypoints are not supported')
  }, 30000)

  it('fails holo dev when the child process errors or exits non-zero', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)

    const errorChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    errorChild.stdout = new PassThrough()
    errorChild.stderr = new PassThrough()
    errorChild.stdin = new PassThrough()
    const errorWatcherClose = vi.fn()
    const devErrorPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => errorChild as never) as never,
      ((_path: string, _options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => ({ close: errorWatcherClose }) as unknown as FSWatcher) as never,
    ))

    while (errorChild.listenerCount('error') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    errorChild.emit('error', new Error('dev exploded'))
    await expect(devErrorPromise).rejects.toThrow('dev exploded')
    expect(errorWatcherClose).toHaveBeenCalledTimes(1)

    const closeChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    closeChild.stdout = new PassThrough()
    closeChild.stderr = new PassThrough()
    closeChild.stdin = new PassThrough()
    const closeWatcher = vi.fn()
    const devClosePromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => closeChild as never) as never,
      ((_path: string, _options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => ({ close: closeWatcher }) as unknown as FSWatcher) as never,
    ))

    while (closeChild.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    closeChild.emit('close', null)
    await expect(devClosePromise).rejects.toThrow('Project script "holo:dev" failed with exit code unknown.')
    expect(closeWatcher).toHaveBeenCalledTimes(1)
  })

  it('queues one additional discovery prepare while a holo dev prepare is already running', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    let releasePrepare: (() => void) | undefined
    let prepareCalls = 0
    const prepare = vi.fn(async () => {
      prepareCalls += 1
      if (prepareCalls !== 2) {
        return
      }

      await new Promise<void>((resolve) => {
        releasePrepare = resolve
      })
    })

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/commands/hello.mjs')
    watchCallback('change', 'server/commands/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 10))
    releasePrepare?.()
    while (prepareCalls < 3) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    child.emit('close', 0)

    await expect(devPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(3)
  })

  it('restarts the holo dev child after a successful discovery refresh when the child is killable', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
      kill: ReturnType<typeof vi.fn>
    }> = []
    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const prepare = vi.fn(async () => {})

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          stdin: PassThrough
          kill: ReturnType<typeof vi.fn>
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = vi.fn(() => {
          queueMicrotask(() => {
            child.emit('close', 0)
          })
          return true
        })
        spawnedChildren.push(child)
        return child as never
      }) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || (spawnedChildren.at(0)?.listenerCount('close') ?? 0) === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/commands/hello.mjs')
    while (spawnedChildren.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const firstChild = spawnedChildren[0]!
    const restartedChild = spawnedChildren[1]!
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')

    restartedChild.emit('close', 0)
    await expect(devPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('treats child errors during a requested restart as a normal dev-server reload', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
      kill: ReturnType<typeof vi.fn>
    }> = []
    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const prepare = vi.fn(async () => {})

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          stdin: PassThrough
          kill: ReturnType<typeof vi.fn>
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = vi.fn(() => {
          queueMicrotask(() => {
            child.emit('error', new Error('restart handoff'))
          })
          return true
        })
        spawnedChildren.push(child)
        return child as never
      }) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || (spawnedChildren.at(0)?.listenerCount('error') ?? 0) === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/commands/hello.mjs')
    while (spawnedChildren.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const firstChild = spawnedChildren[0]!
    const restartedChild = spawnedChildren[1]!
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')

    restartedChild.emit('close', 0)
    await expect(devPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('refreshes discovery roots after config/app.ts changes during holo dev', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    const watchers = new Map<string, (eventType: string, fileName: string | Buffer | null) => void>()
    let prepareCalls = 0
    const prepare = vi.fn(async () => {
      prepareCalls += 1
      if (prepareCalls === 2) {
        await mkdir(join(projectRoot, 'server/app-models'), { recursive: true })
        await writeProjectFile(projectRoot, 'config/app.ts', `
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  paths: {
    models: 'server/app-models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
})
`)
      }
    })

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        watchers.set(watchPath, callback)
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (watchers.size === 0 || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchers.get(join(projectRoot, 'config'))?.('change', 'app.ts')
    while (prepareCalls < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    while (!watchers.has(join(projectRoot, 'server/app-models'))) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    watchers.get(join(projectRoot, 'server/app-models'))?.('change', 'User.mjs')
    while (prepareCalls < 3) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    child.emit('close', 0)

    await expect(devPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(3)
  }, 15000)

  it('falls back to a non-recursive watcher when recursive fs.watch is unavailable', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    const closeWatcher = vi.fn()
    const watchModes: Array<boolean | undefined> = []
    const watchers = new Map<string, (eventType: string, fileName: string | Buffer | null) => void>()
    const prepare = vi.fn(async () => {})
    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchModes.push(options.recursive)
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        watchers.set(watchPath, callback)
        return { close: closeWatcher, on() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (watchers.size === 0 || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchers.get(projectRoot)?.('change', Buffer.from('server/commands/hello.mjs'))
    watchers.get(projectRoot)?.('change', 'README.md')
    watchers.get(join(projectRoot, 'server/commands'))?.('change', 'hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 5))
    child.emit('close', 0)
    await expect(devPromise).resolves.toBeUndefined()
    expect(watchModes[0]).toBe(true)
    expect(watchModes.slice(1).every(mode => mode === false)).toBe(true)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(closeWatcher).toHaveBeenCalled()
  })

  it('prepares queue command flags and queue helper utilities', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const commandIo = createIo(projectRoot)
    const runQueueWork = vi.fn(async () => {})
    const runQueueListen = vi.fn(async () => {})
    const runQueueRestart = vi.fn(async () => {})
    const runQueueClear = vi.fn(async () => {})
    const runQueueTable = vi.fn(async () => {})
    const runQueueFailedTable = vi.fn(async () => {})
    const runQueueFailed = vi.fn(async () => {})
    const runQueueRetry = vi.fn(async () => {})
    const runQueueForget = vi.fn(async () => {})
    const runQueueFlush = vi.fn(async () => {})
    const commandContext = {
      ...commandIo.io,
      projectRoot,
      loadProject: async () => ({ manifestPath: undefined, config: await loadProjectConfig(projectRoot, { required: true }).then(entry => entry.config) }),
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
    }

    const commands = cliInternals.createInternalCommands(
      commandContext as never,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {
        runQueueTableCommand: runQueueTable as never,
        runQueueFailedTableCommand: runQueueFailedTable as never,
        runQueueWorkCommand: runQueueWork as never,
        runQueueListen: runQueueListen as never,
        runQueueFailedCommand: runQueueFailed as never,
        runQueueRetryCommand: runQueueRetry as never,
        runQueueForgetCommand: runQueueForget as never,
        runQueueFlushCommand: runQueueFlush as never,
        runQueueRestartCommand: runQueueRestart as never,
        runQueueClearCommand: runQueueClear as never,
      },
    )
    const queueTable = commands.find(command => command.name === 'queue:table')
    const queueFailedTable = commands.find(command => command.name === 'queue:failed-table')
    const queueWork = commands.find(command => command.name === 'queue:work')
    const queueListen = commands.find(command => command.name === 'queue:listen')
    const queueFailed = commands.find(command => command.name === 'queue:failed')
    const queueRetry = commands.find(command => command.name === 'queue:retry')
    const queueForget = commands.find(command => command.name === 'queue:forget')
    const queueFlush = commands.find(command => command.name === 'queue:flush')
    const queueClear = commands.find(command => command.name === 'queue:clear')
    const queueRestart = commands.find(command => command.name === 'queue:restart')

    expect(await queueTable?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueFailedTable?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueWork?.prepare?.({
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails,critical', 'default'],
        once: true,
        'stop-when-empty': true,
        sleep: '3',
        tries: '5',
        timeout: '9',
        'max-jobs': '11',
        'max-time': '13',
      },
    }, commandContext as never)).toEqual({
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails', 'critical', 'default'],
        once: true,
        'stop-when-empty': true,
        sleep: 3,
        tries: 5,
        timeout: 9,
        'max-jobs': 11,
        'max-time': 13,
      },
    })
    expect(await queueListen?.prepare?.({
      args: [],
      flags: {
        c: 'database',
        q: ['reports,nightly'],
        sleep: '2',
      },
    }, commandContext as never)).toEqual({
      args: [],
      flags: {
        connection: 'database',
        queue: ['reports', 'nightly'],
        sleep: 2,
      },
    })
    expect(await queueFailed?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueRetry?.prepare?.({ args: ['all'], flags: {} }, commandContext as never)).toEqual({
      args: ['all'],
      flags: {},
    })
    expect(await queueForget?.prepare?.({ args: ['failed-1'], flags: {} }, commandContext as never)).toEqual({
      args: ['failed-1'],
      flags: {},
    })
    expect(await queueFlush?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueClear?.prepare?.({
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails,critical'],
      },
    }, commandContext as never)).toEqual({
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails', 'critical'],
      },
    })
    expect(await queueRestart?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })

    expect(cliInternals.buildQueueWorkArgs({
      connection: 'redis',
      queue: ['emails', 'critical'],
      once: true,
      sleep: 3,
    })).toEqual([
      'queue:work',
      '--connection',
      'redis',
      '--queue',
      'emails',
      '--queue',
      'critical',
      '--once',
      '--sleep',
      '3',
    ])
    expect(cliInternals.isQueueListenRelevantPath('server/jobs/send-email.ts', await loadProjectConfig(projectRoot, { required: true }))).toBe(true)
    expect(cliInternals.isQueueListenRelevantPath('server/services/mail/send.ts', await loadProjectConfig(projectRoot, { required: true }))).toBe(true)
    expect(cliInternals.isQueueListenRelevantPath('.holo-js/generated/jobs.ts', await loadProjectConfig(projectRoot, { required: true }))).toBe(true)
    expect(cliInternals.isQueueListenRelevantPath('.holo-js/runtime/cli/bundle/report.mjs', await loadProjectConfig(projectRoot, { required: true }))).toBe(false)
    expect(cliInternals.isQueueListenRelevantPath('.holo-js\\runtime\\cli\\bundle\\report.mjs', await loadProjectConfig(projectRoot, { required: true }))).toBe(false)
    expect(cliInternals.isQueueListenRelevantPath('.env.test', await loadProjectConfig(projectRoot, { required: true }))).toBe(true)
    expect(cliInternals.isQueueListenRelevantPath('node_modules/example/index.js', await loadProjectConfig(projectRoot, { required: true }))).toBe(false)
    expect(cliInternals.isQueueListenRelevantPath('README.md', await loadProjectConfig(projectRoot, { required: true }))).toBe(false)
    expect(cliInternals.resolveModuleExport({ default: { ok: true } }, (value): value is { ok: true } => Boolean((value as { ok?: boolean } | undefined)?.ok))).toEqual({ ok: true })
    expect(cliInternals.resolveModuleExport({ named: { ok: true } }, (value): value is { ok: true } => Boolean((value as { ok?: boolean } | undefined)?.ok))).toEqual({ ok: true })
    expect(cliInternals.resolveModuleExport('nope', (_value): _value is { ok: true } => false)).toBeUndefined()

    await queueTable?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueFailedTable?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueWork?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails'],
        once: true,
        'stop-when-empty': true,
        sleep: 3,
        tries: 5,
        timeout: 9,
        'max-jobs': 11,
        'max-time': 13,
      },
      loadProject: commandContext.loadProject,
    })
    await queueListen?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails'],
      },
      loadProject: commandContext.loadProject,
    })
    await queueFailed?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueRetry?.run({
      projectRoot,
      cwd: projectRoot,
      args: ['all'],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueForget?.run({
      projectRoot,
      cwd: projectRoot,
      args: ['failed-1'],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueFlush?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueRestart?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueClear?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        connection: 'redis',
        queue: ['emails'],
      },
      loadProject: commandContext.loadProject,
    })

    expect(runQueueTable).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueFailedTable).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueWork).toHaveBeenCalledWith(expect.anything(), projectRoot, {
      connection: 'redis',
      queueNames: ['emails'],
      once: true,
      stopWhenEmpty: true,
      sleep: 3,
      tries: 5,
      timeout: 9,
      maxJobs: 11,
      maxTime: 13,
    })
    expect(runQueueListen).toHaveBeenCalledWith(expect.anything(), projectRoot, {
      connection: 'redis',
      queue: ['emails'],
    })
    expect(runQueueFailed).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueRetry).toHaveBeenCalledWith(expect.anything(), projectRoot, 'all')
    expect(runQueueForget).toHaveBeenCalledWith(expect.anything(), projectRoot, 'failed-1')
    expect(runQueueFlush).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueRestart).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueClear).toHaveBeenCalledWith(expect.anything(), projectRoot, 'redis', ['emails'])
  })

  it('prepares cache command flags and routes cache executors through the internal command registry', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const commandIo = createIo(projectRoot)
    const runCacheTable = vi.fn(async () => {})
    const runCacheClear = vi.fn(async () => {})
    const runCacheForget = vi.fn(async () => {})
    const commandContext = {
      ...commandIo.io,
      projectRoot,
      loadProject: async () => ({ manifestPath: undefined, config: await loadProjectConfig(projectRoot, { required: true }).then(entry => entry.config) }),
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
    }

    const commands = cliInternals.createInternalCommands(
      commandContext as never,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {},
      {},
      {},
      {},
      {
        runCacheTableCommand: runCacheTable as never,
        runCacheClearCommand: runCacheClear as never,
        runCacheForgetCommand: runCacheForget as never,
      },
    )
    const cacheTable = commands.find(command => command.name === 'cache:table')
    const cacheClear = commands.find(command => command.name === 'cache:clear')
    const cacheForget = commands.find(command => command.name === 'cache:forget')

    expect(await cacheTable?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await cacheClear?.prepare?.({ args: [], flags: { d: 'redis' } }, commandContext as never)).toEqual({
      args: [],
      flags: {
        driver: 'redis',
      },
    })
    expect(await cacheClear?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await cacheForget?.prepare?.({ args: ['users'], flags: {} }, commandContext as never)).toEqual({
      args: ['users'],
      flags: {},
    })
    expect(await cacheForget?.prepare?.({ args: ['users'], flags: { driver: 'memory' } }, commandContext as never)).toEqual({
      args: ['users'],
      flags: {
        driver: 'memory',
      },
    })
    await expect(cacheForget?.prepare?.({ args: [], flags: {} }, commandContext as never)).rejects.toThrow('Missing required argument: Cache key.')

    await cacheTable?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await cacheClear?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        driver: 'redis',
      },
      loadProject: commandContext.loadProject,
    })
    await cacheForget?.run({
      projectRoot,
      cwd: projectRoot,
      args: ['users'],
      flags: {
        driver: 'memory',
      },
      loadProject: commandContext.loadProject,
    })

    expect(runCacheTable).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runCacheClear).toHaveBeenCalledWith(expect.anything(), projectRoot, 'redis')
    expect(runCacheForget).toHaveBeenCalledWith(expect.anything(), projectRoot, 'users', 'memory')
  })

  it('prepares media table command and routes the media executor through the internal command registry', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const commandIo = createIo(projectRoot)
    const runMediaTable = vi.fn(async () => {})
    const commandContext = {
      ...commandIo.io,
      projectRoot,
      loadProject: async () => ({ manifestPath: undefined, config: await loadProjectConfig(projectRoot, { required: true }).then(entry => entry.config) }),
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
    }

    const commands = cliInternals.createInternalCommands(
      commandContext as never,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {},
      {},
      {},
      {},
      {},
      {
        runMediaTableCommand: runMediaTable as never,
      },
    )
    const mediaTable = commands.find(command => command.name === 'media:table')

    expect(await mediaTable?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })

    await mediaTable?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })

    expect(runMediaTable).toHaveBeenCalledWith(expect.anything(), projectRoot)
  })

  it('loads cache command executors lazily and falls back when cache command inputs are missing or non-string', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const runCacheClearCommand = vi.fn(async () => {})
    const runCacheForgetCommand = vi.fn(async () => {})

    vi.resetModules()
    vi.doMock('../src/cache', async () => {
      const actual = await vi.importActual('../src/cache') as typeof CacheInternalModule
      return {
        ...actual,
        runCacheClearCommand,
        runCacheForgetCommand,
      }
    })

    try {
      const isolatedCli = await import('../src/cli')
      const commands = isolatedCli.createInternalCommands({
        ...io.io,
        projectRoot,
        registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
        loadProject: async () => ({ config: defaultProjectConfig() }),
      } as never)

      await commands.find(command => command.name === 'cache:clear')!.run({
        ...io.io,
        projectRoot,
        cwd: projectRoot,
        args: [],
        flags: {
          driver: true,
        },
        loadProject: async () => ({ config: defaultProjectConfig() }),
      } as never)
      await commands.find(command => command.name === 'cache:forget')!.run({
        ...io.io,
        projectRoot,
        cwd: projectRoot,
        args: [],
        flags: {
          driver: true,
        },
        loadProject: async () => ({ config: defaultProjectConfig() }),
      } as never)

      expect(runCacheClearCommand).toHaveBeenCalledWith(expect.anything(), projectRoot, undefined)
      expect(runCacheForgetCommand).toHaveBeenCalledWith(expect.anything(), projectRoot, '', undefined)
    } finally {
      vi.doUnmock('../src/cache')
      vi.resetModules()
    }
  })

  it('covers queue command defaults, skipped worker flags, and built CLI entry resolution', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const commandIo = createIo(projectRoot)
    const runQueueWork = vi.fn(async () => {})
    const runQueueListen = vi.fn(async () => {})
    const runQueueRestart = vi.fn(async () => {})
    const runQueueClear = vi.fn(async () => {})
    const runQueueTable = vi.fn(async () => {})
    const runQueueFailedTable = vi.fn(async () => {})
    const runQueueFailed = vi.fn(async () => {})
    const runQueueRetry = vi.fn(async () => {})
    const runQueueForget = vi.fn(async () => {})
    const runQueueFlush = vi.fn(async () => {})
    const commandContext = {
      ...commandIo.io,
      projectRoot,
      loadProject: async () => ({ manifestPath: undefined, config: await loadProjectConfig(projectRoot, { required: true }).then(entry => entry.config) }),
      registry: [] as Array<ReturnType<typeof cliInternals.createAppCommandDefinition>>,
    }

    const commands = cliInternals.createInternalCommands(
      commandContext as never,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {
        runQueueTableCommand: runQueueTable as never,
        runQueueFailedTableCommand: runQueueFailedTable as never,
        runQueueWorkCommand: runQueueWork as never,
        runQueueListen: runQueueListen as never,
        runQueueFailedCommand: runQueueFailed as never,
        runQueueRetryCommand: runQueueRetry as never,
        runQueueForgetCommand: runQueueForget as never,
        runQueueFlushCommand: runQueueFlush as never,
        runQueueRestartCommand: runQueueRestart as never,
        runQueueClearCommand: runQueueClear as never,
      },
    )
    const queueTable = commands.find(command => command.name === 'queue:table')
    const queueFailedTable = commands.find(command => command.name === 'queue:failed-table')
    const queueWork = commands.find(command => command.name === 'queue:work')
    const queueListen = commands.find(command => command.name === 'queue:listen')
    const queueFailed = commands.find(command => command.name === 'queue:failed')
    const queueRetry = commands.find(command => command.name === 'queue:retry')
    const queueForget = commands.find(command => command.name === 'queue:forget')
    const queueFlush = commands.find(command => command.name === 'queue:flush')
    const queueClear = commands.find(command => command.name === 'queue:clear')
    const queueRestart = commands.find(command => command.name === 'queue:restart')

    expect(await queueTable?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueFailedTable?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueWork?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {
        once: false,
        'stop-when-empty': false,
      },
    })
    expect(await queueListen?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueFailed?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueClear?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(await queueFlush?.prepare?.({ args: [], flags: {} }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    await expect(queueRetry?.prepare?.({ args: [], flags: {} }, commandContext as never)).rejects.toThrow('Missing required argument: Failed job id.')
    await expect(queueForget?.prepare?.({ args: [], flags: {} }, commandContext as never)).rejects.toThrow('Missing required argument: Failed job id.')
    expect(await queueWork?.prepare?.({
      args: [],
      flags: {
        queue: [''],
      },
    }, commandContext as never)).toEqual({
      args: [],
      flags: {
        once: false,
        'stop-when-empty': false,
      },
    })
    expect(await queueListen?.prepare?.({
      args: [],
      flags: {
        queue: [''],
        tries: '4',
        timeout: '8',
        'max-jobs': '12',
        'max-time': '16',
      },
    }, commandContext as never)).toEqual({
      args: [],
      flags: {
        tries: 4,
        timeout: 8,
        'max-jobs': 12,
        'max-time': 16,
      },
    })
    expect(await queueClear?.prepare?.({
      args: [],
      flags: {
        queue: [''],
      },
    }, commandContext as never)).toEqual({
      args: [],
      flags: {},
    })
    expect(cliInternals.buildQueueWorkArgs({
      help: true,
      h: true,
      once: true,
      dry: false,
      c: 'redis',
      queue: ['emails'],
    })).toEqual([
      'queue:work',
      '--once',
      '-c',
      'redis',
      '--queue',
      'emails',
    ])

    await queueWork?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {
        once: false,
        'stop-when-empty': false,
      },
      loadProject: commandContext.loadProject,
    })
    await queueTable?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueFailedTable?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueFailed?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueRetry?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueForget?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueFlush?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueListen?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueClear?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })
    await queueRestart?.run({
      projectRoot,
      cwd: projectRoot,
      args: [],
      flags: {},
      loadProject: commandContext.loadProject,
    })

    expect(runQueueTable).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueFailedTable).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueWork).toHaveBeenCalledWith(expect.anything(), projectRoot, {
      once: false,
      stopWhenEmpty: false,
    })
    expect(runQueueFailed).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueRetry).toHaveBeenCalledWith(expect.anything(), projectRoot, '')
    expect(runQueueForget).toHaveBeenCalledWith(expect.anything(), projectRoot, '')
    expect(runQueueFlush).toHaveBeenCalledWith(expect.anything(), projectRoot)
    expect(runQueueListen).toHaveBeenCalledWith(expect.anything(), projectRoot, {})
    expect(runQueueClear).toHaveBeenCalledWith(expect.anything(), projectRoot, undefined, undefined)
    expect(runQueueRestart).toHaveBeenCalledWith(expect.anything(), projectRoot)

    const builtEntrypointPath = resolve(workspaceRoot, 'packages/cli/src/bin/holo.mjs')
    await writeFile(builtEntrypointPath, '#!/usr/bin/env node\n', 'utf8')
    try {
      expect(cliInternals.resolveCliEntrypointPath()).toBe(builtEntrypointPath)
      const runnableEntrypoint = await cliInternals.resolveRunnableCliEntrypoint()
      try {
        expect(runnableEntrypoint.path).toBe(builtEntrypointPath)
      } finally {
        await runnableEntrypoint.cleanup()
      }
    } finally {
      await rm(builtEntrypointPath, { force: true })
    }
  }, 20000)

  it('spawns a runnable bundled entry for queue:listen when only the TS source entry exists', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }> = []
    const spawnProcess = vi.fn((
      _command: string,
      _args?: readonly string[],
      _options?: unknown,
    ) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        stdin: PassThrough
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      spawnedChildren.push(child)
      return child as never
    })
    const watcherClose = vi.fn()
    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      spawnProcess as never,
      ((_path: string, _options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => ({ close: watcherClose }) as unknown as FSWatcher) as never,
      async () => {},
    ))

    while (spawnedChildren.length === 0 || spawnedChildren[0]!.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(spawnProcess.mock.calls[0]?.[1]?.[0]).toMatch(/holo\.mjs$/)
    expect(spawnProcess.mock.calls[0]?.[1]?.[0]).not.toMatch(/holo\.ts$/)

    spawnedChildren[0]!.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
    expect(watcherClose).toHaveBeenCalledTimes(1)
  }, 20000)

  it('writes and detects queue restart signals and reports unsupported sync workers clearly', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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

    await expect(cliInternals.readQueueRestartSignal(projectRoot)).resolves.toBeUndefined()
    const signalPath = await cliInternals.writeQueueRestartSignal(projectRoot, 1234)
    expect(signalPath).toBe(cliInternals.resolveQueueRestartSignalPath(projectRoot))
    await expect(cliInternals.readQueueRestartSignal(projectRoot)).resolves.toBe(1234)
    await expect(cliInternals.hasQueueRestartSignalSince(projectRoot, 1200)).resolves.toBe(true)
    await expect(cliInternals.hasQueueRestartSignalSince(projectRoot, 1300)).resolves.toBe(false)
    await writeFile(cliInternals.resolveQueueRestartSignalPath(projectRoot), 'NaN\n', 'utf8')
    await expect(cliInternals.readQueueRestartSignal(projectRoot)).resolves.toBeUndefined()

    await expect(withFakeBun(async () => cliInternals.runQueueRestartCommand(io.io, projectRoot))).resolves.toBeUndefined()
    expect(io.read().stdout).toContain('Restart signal written')

    await expect(withFakeBun(async () => cliInternals.runQueueWorkCommand(io.io, projectRoot, {
      once: true,
    }))).rejects.toThrow('requires an async-capable driver')

    await expect(withFakeBun(async () => cliInternals.runQueueClearCommand(io.io, projectRoot, undefined, undefined))).resolves.toBeUndefined()
    expect(io.read().stdout).toContain('Cleared 0 pending job(s).')
  })

  it('boots queued job runtime environments and cleans up bundled jobs on success and failure', async () => {
    const successRoot = await createTempProject()
    tempDirs.push(successRoot)
    ;(globalThis as typeof globalThis & { __holoQueueModelLoaded__?: number }).__holoQueueModelLoaded__ = 0
    await writeProjectFile(successRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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

    vi.resetModules()
    vi.doMock('@holo-js/core', async () => {
      const actual = await vi.importActual('@holo-js/core') as typeof HoloCoreModule
      return {
        ...actual,
        initializeHolo: vi.fn(async () => mockedRuntime),
      }
    })

    const mockedRuntime = {
      shutdown: vi.fn(async () => {}),
    } as unknown as Awaited<ReturnType<typeof initializeHolo>>

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      const queueModule = await import('@holo-js/queue')
      mockedRuntime.shutdown = vi.fn(async () => {
        queueModule.resetQueueRuntime()
      })

      await withFakeBun(async () => {
        await prepareProjectDiscovery(successRoot)
        const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(successRoot)
        try {
          expect(environment.project.config.paths.jobs).toBe('server/jobs')
          expect(environment.bundledJobs).toHaveLength(1)
          expect(queueModule.listRegisteredQueueJobs().map(job => job.name)).toContain('reports.send')
          expect((globalThis as typeof globalThis & { __holoQueueModelLoaded__?: number }).__holoQueueModelLoaded__).toBeGreaterThanOrEqual(1)
        } finally {
          await environment.cleanup()
        }
      })
      expect(mockedRuntime.shutdown).toHaveBeenCalledTimes(1)

      const customJobsRoot = await createTempProject()
      tempDirs.push(customJobsRoot)
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

      await withFakeBun(async () => {
        await prepareProjectDiscovery(
          customJobsRoot,
          (await loadProjectConfig(customJobsRoot, { required: true })).config,
        )
        const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(customJobsRoot)
        try {
          expect(environment.project.config.paths.jobs).toBe('queue')
          expect(environment.bundledJobs).toHaveLength(1)
          expect(queueModule.listRegisteredQueueJobs().map(job => job.name)).toContain('send-email')
          expect(queueModule.listRegisteredQueueJobs().map(job => job.name)).not.toContain('queue.send-email')
        } finally {
          await environment.cleanup()
        }
      })
      expect(mockedRuntime.shutdown).toHaveBeenCalledTimes(2)

      const emptyRoot = await createTempProject()
      tempDirs.push(emptyRoot)
      await writeProjectFile(emptyRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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

      await withFakeBun(async () => {
        await prepareProjectDiscovery(emptyRoot)
        const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(emptyRoot)
        try {
          expect(environment.bundledJobs).toEqual([])
        } finally {
          await environment.cleanup()
        }
      })
      expect(mockedRuntime.shutdown).toHaveBeenCalledTimes(3)

      const failingRoot = await createTempProject()
      tempDirs.push(failingRoot)
      await writeProjectFile(failingRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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

      await withFakeBun(async () => {
        await prepareProjectDiscovery(failingRoot)
        await writeProjectFile(failingRoot, 'server/jobs/broken.mjs', 'export default { nope: true }\n')
        await expect(isolatedCliInternals.getQueueRuntimeEnvironment(failingRoot)).rejects.toThrow('does not export a Holo job')
      })
      expect(mockedRuntime.shutdown).toHaveBeenCalledTimes(3)
    } finally {
      vi.doUnmock('@holo-js/core')
      vi.resetModules()
    }
  })

  it('runs queue worker helpers with injected dependencies and reports failures and summaries', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const cleanup = vi.fn(async () => {})
    const onJobFailed = vi.fn()

    await expect(cliInternals.runQueueWorkCommand(io.io, projectRoot, {
      onJobFailed,
    }, {
      getEnvironment: async () => ({
        runtime: {} as never,
        project: await loadProjectConfig(projectRoot, { required: true }),
        bundledJobs: [],
        cleanup,
      }),
      hasRestartSignal: async () => true,
      runWorker: async (options?: QueueWorkerRunOptions) => {
        expect(options).toBeDefined()
        expect(await options?.shouldStop?.()).toBe(true)
        await options?.onJobFailed?.({
          jobId: 'job-1',
          jobName: 'reports.send',
          connection: 'redis',
          queue: 'default',
          attempt: 1,
          maxAttempts: 3,
          error: new Error('boom'),
        })
        return {
          processed: 1,
          released: 2,
          failed: 3,
          stoppedBecause: 'signal',
        }
      },
    })).resolves.toBeUndefined()

    expect(onJobFailed).toHaveBeenCalledWith(expect.objectContaining({
      jobName: 'reports.send',
    }))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(io.read().stderr).toContain('Failed reports.send (job-1): boom')
    expect(io.read().stdout).toContain('Stopped (signal). processed=1 released=2 failed=3')
  })

  it('falls back to restart signals when queue work shouldStop does not request an immediate shutdown', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const cleanup = vi.fn(async () => {})

    await expect(cliInternals.runQueueWorkCommand(io.io, projectRoot, {
      shouldStop: async () => false,
    }, {
      getEnvironment: async () => ({
        runtime: {} as never,
        project: await loadProjectConfig(projectRoot, { required: true }),
        bundledJobs: [],
        cleanup,
      }),
      hasRestartSignal: async () => false,
      runWorker: async (options?: QueueWorkerRunOptions) => {
        expect(options).toBeDefined()
        expect(await options?.shouldStop?.()).toBe(false)
        await options?.onJobFailed?.({
          jobId: 'job-2',
          jobName: 'reports.retry',
          connection: 'redis',
          queue: 'critical',
          attempt: 2,
          maxAttempts: 5,
          error: new Error('retry later'),
        })
        return {
          processed: 0,
          released: 1,
          failed: 0,
          stoppedBecause: 'empty',
        }
      },
    })).resolves.toBeUndefined()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(io.read().stderr).toContain('Failed reports.retry (job-2): retry later')
    expect(io.read().stdout).toContain('Stopped (empty). processed=0 released=1 failed=0')
  })

  it('stops queue work immediately when the caller shouldStop hook returns true', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const cleanup = vi.fn(async () => {})

    await expect(cliInternals.runQueueWorkCommand(io.io, projectRoot, {
      shouldStop: async () => true,
    }, {
      getEnvironment: async () => ({
        runtime: {} as never,
        project: await loadProjectConfig(projectRoot, { required: true }),
        bundledJobs: [],
        cleanup,
      }),
      runWorker: async (options?: QueueWorkerRunOptions) => {
        expect(options).toBeDefined()
        expect(await options?.shouldStop?.()).toBe(true)
        return {
          processed: 2,
          released: 0,
          failed: 0,
          stoppedBecause: 'signal',
        }
      },
    })).resolves.toBeUndefined()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(io.read().stdout).toContain('Stopped (signal). processed=2 released=0 failed=0')
  })

  it('uses the restart signal file when queue work falls back to the default signal lookup', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const cleanup = vi.fn(async () => {})
    await cliInternals.writeQueueRestartSignal(projectRoot, Date.now() + 1000)

    await expect(cliInternals.runQueueWorkCommand(io.io, projectRoot, {}, {
      getEnvironment: async () => ({
        runtime: {} as never,
        project: await loadProjectConfig(projectRoot, { required: true }),
        bundledJobs: [],
        cleanup,
      }),
      runWorker: async (options?: QueueWorkerRunOptions) => {
        expect(options).toBeDefined()
        expect(await options?.shouldStop?.()).toBe(true)
        return {
          processed: 0,
          released: 0,
          failed: 0,
          stoppedBecause: 'signal',
        }
      },
    })).resolves.toBeUndefined()

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('runs queue clear helpers with injected runtime dependencies', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const shutdown = vi.fn(async () => {})
    const clear = vi.fn(async () => 4)

    await expect(cliInternals.runQueueClearCommand(io.io, projectRoot, 'redis', undefined, {
      initialize: async () => ({ shutdown }) as never,
      clear: clear as never,
    })).resolves.toBeUndefined()

    expect(clear).toHaveBeenCalledWith('redis', {})
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(io.read().stdout).toContain('Cleared 4 pending job(s).')
  })

  it('passes explicit queue-name edge cases through queue clear helpers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const shutdown = vi.fn(async () => {})
    const clear = vi.fn(async () => 1)

    await expect(cliInternals.runQueueClearCommand(io.io, projectRoot, 'redis', [], {
      initialize: async () => ({ shutdown }) as never,
      clear: clear as never,
    })).resolves.toBeUndefined()

    expect(clear).toHaveBeenCalledWith('redis', {})
    expect(shutdown).toHaveBeenCalledTimes(1)

    await expect(cliInternals.runQueueClearCommand(io.io, projectRoot, 'redis', ['emails'], {
      initialize: async () => ({ shutdown }) as never,
      clear: clear as never,
    })).resolves.toBeUndefined()

    expect(clear).toHaveBeenLastCalledWith('redis', {
      queueNames: ['emails'],
    })
  })

  it('falls back to the queue clear facade when only an injected runtime is provided', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const shutdown = vi.fn(async () => {})
    const queueModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')

    vi.resetModules()
    vi.doMock(queueModuleSpecifier, async () => {
      const actual = await vi.importActual('@holo-js/queue') as typeof HoloQueueModule
      return {
        ...actual,
        clearQueueConnection: vi.fn(async () => 6),
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(isolatedCliInternals.runQueueClearCommand(io.io, projectRoot, 'redis', undefined, {
        initialize: async () => ({ shutdown }) as never,
      })).resolves.toBeUndefined()

      const queueModule = await import(queueModuleSpecifier)
      expect(vi.mocked(queueModule.clearQueueConnection)).toHaveBeenCalledWith('redis', {})
      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(io.read().stdout).toContain('Cleared 6 pending job(s).')
    } finally {
      vi.doUnmock(queueModuleSpecifier)
      vi.resetModules()
    }
  }, 30000)

  it('boots queue maintenance commands without registering project queue jobs', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const shutdown = vi.fn(async () => {})

    vi.resetModules()
    vi.doMock('@holo-js/core', async () => {
      const actual = await vi.importActual('@holo-js/core') as typeof HoloCoreModule
      return {
        ...actual,
        initializeHolo: vi.fn(async () => ({ shutdown }) as unknown as Awaited<ReturnType<typeof initializeHolo>>),
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      const clear = vi.fn(async () => 0)
      const list = vi.fn(async () => [])
      const retry = vi.fn(async () => 0)
      const forget = vi.fn(async () => false)
      const flush = vi.fn(async () => 0)

      await isolatedCliInternals.runQueueClearCommand(io.io, projectRoot, 'redis', undefined, {
        clear: clear as never,
      })
      await isolatedCliInternals.runQueueFailedCommand(io.io, projectRoot, {
        list: list as never,
      })
      await isolatedCliInternals.runQueueRetryCommand(io.io, projectRoot, 'all', {
        retry: retry as never,
      })
      await isolatedCliInternals.runQueueForgetCommand(io.io, projectRoot, 'failed-1', {
        forget: forget as never,
      })
      await isolatedCliInternals.runQueueFlushCommand(io.io, projectRoot, {
        flush: flush as never,
      })

      const coreModule = await import('@holo-js/core') as typeof HoloCoreModule
      const initializeMock = vi.mocked(coreModule.initializeHolo)

      expect(initializeMock).toHaveBeenCalledTimes(4)
      expect(initializeMock).toHaveBeenNthCalledWith(1, projectRoot, { registerProjectQueueJobs: false })
      expect(initializeMock).toHaveBeenNthCalledWith(2, projectRoot, { registerProjectQueueJobs: false })
      expect(initializeMock).toHaveBeenNthCalledWith(3, projectRoot, { registerProjectQueueJobs: false })
      expect(initializeMock).toHaveBeenNthCalledWith(4, projectRoot, { registerProjectQueueJobs: false })
      expect(shutdown).toHaveBeenCalledTimes(4)
    } finally {
      vi.doUnmock('@holo-js/core')
      vi.resetModules()
    }
  }, 30000)

  it('clears Redis-backed queues without booting the full Holo runtime', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const queueModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')

    vi.resetModules()
    vi.doMock('@holo-js/core', async () => ({
      initializeHolo: vi.fn(async () => {
        throw new Error('queue:clear should not initialize the Holo runtime')
      }),
    }))
    vi.doMock('@holo-js/config', async (importOriginal) => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          queue: {
            default: 'redis',
            failed: false,
            connections: {
              redis: {
                name: 'redis',
                driver: 'redis',
                queue: 'default',
                retryAfter: 90,
                blockFor: 5,
                redis: {
                  host: '127.0.0.1',
                  port: 6379,
                  db: 0,
                },
              },
            },
          },
          database: {
            defaultConnection: 'default',
            connections: {},
          },
        })),
      }
    })
    vi.doMock(queueModuleSpecifier, async () => {
      const actual = await vi.importActual('@holo-js/queue') as typeof HoloQueueModule
      return {
        ...actual,
        clearQueueConnection: vi.fn(async () => 2),
        configureQueueRuntime: vi.fn(),
        shutdownQueueRuntime: vi.fn(async () => {}),
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(isolatedCliInternals.runQueueClearCommand(io.io, projectRoot, 'redis', ['emails'])).resolves.toBeUndefined()

      const queueModule = await import(queueModuleSpecifier)
      const configModule = await import('@holo-js/config') as typeof HoloConfigModule
      expect(vi.mocked(configModule.loadConfigDirectory)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(queueModule.configureQueueRuntime)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(queueModule.clearQueueConnection)).toHaveBeenCalledWith('redis', {
        queueNames: ['emails'],
      })
      expect(vi.mocked(queueModule.shutdownQueueRuntime)).toHaveBeenCalledTimes(1)
      expect(io.read().stdout).toContain('Cleared 2 pending job(s).')
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.doUnmock('@holo-js/core')
      vi.doUnmock(queueModuleSpecifier)
      vi.resetModules()
    }
  }, 30000)

  it('boots only the database queue connection for queue:clear when the selected queue driver is database', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const queueModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')
    const queueDbModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue-db')
    const initializeAll = vi.fn(async () => {})
    const disconnectAll = vi.fn(async () => {})
    const manager = {
      initializeAll,
      disconnectAll,
    }

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          queue: {
            default: 'database',
            failed: false,
            connections: {
              database: {
                name: 'database',
                driver: 'database',
                connection: 'primary',
                table: 'jobs',
                queue: 'default',
                retryAfter: 90,
                sleep: 1,
              },
            },
          },
          database: {
            defaultConnection: 'primary',
            connections: {
              primary: {
                driver: 'sqlite',
                url: './storage/database.sqlite',
              },
            },
          },
        })),
      }
    })
    vi.doMock('@holo-js/db', async () => {
      const actual = await vi.importActual('@holo-js/db') as typeof HoloDbModule
      return {
        ...actual,
        configureDB: vi.fn(),
        resetDB: vi.fn(),
        resolveRuntimeConnectionManagerOptions: vi.fn(() => manager),
      }
    })
    vi.doMock(queueModuleSpecifier, async () => {
      const actual = await vi.importActual('@holo-js/queue') as typeof HoloQueueModule
      return {
        ...actual,
        clearQueueConnection: vi.fn(async () => 3),
        configureQueueRuntime: vi.fn(),
        shutdownQueueRuntime: vi.fn(async () => {}),
      }
    })
    vi.doMock(queueDbModuleSpecifier, async () => ({
      createQueueDbRuntimeOptions: vi.fn(() => ({
        driverFactories: [],
        failedJobStore: undefined,
      })),
    }))

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(isolatedCliInternals.runQueueClearCommand(io.io, projectRoot, 'database', undefined)).resolves.toBeUndefined()

      const dbModule = await import('@holo-js/db') as typeof HoloDbModule
      const queueModule = await import(queueModuleSpecifier)
      const queueDbModule = await import(queueDbModuleSpecifier) as typeof HoloQueueDbModule

      expect(vi.mocked(queueDbModule.createQueueDbRuntimeOptions)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(dbModule.resolveRuntimeConnectionManagerOptions)).toHaveBeenCalledWith({
        db: {
          defaultConnection: 'primary',
          connections: {
            primary: {
              driver: 'sqlite',
              url: './storage/database.sqlite',
            },
          },
        },
      })
      expect(vi.mocked(dbModule.configureDB)).toHaveBeenCalledWith(manager)
      expect(initializeAll).toHaveBeenCalledTimes(1)
      expect(vi.mocked(queueModule.clearQueueConnection)).toHaveBeenCalledWith('database', {})
      expect(disconnectAll).toHaveBeenCalledTimes(1)
      expect(vi.mocked(dbModule.resetDB)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(queueModule.shutdownQueueRuntime)).toHaveBeenCalledTimes(1)
      expect(io.read().stdout).toContain('Cleared 3 pending job(s).')
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.doUnmock('@holo-js/db')
      vi.doUnmock(queueModuleSpecifier)
      vi.doUnmock(queueDbModuleSpecifier)
      vi.resetModules()
    }
  }, 30000)

  it('cleans up queue runtime state when database queue initialization fails during queue:clear', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const queueModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')
    const queueDbModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue-db')
    const initializeAll = vi.fn(async () => {
      throw new Error('database queue init failed')
    })
    const disconnectAll = vi.fn(async () => {})
    const manager = {
      initializeAll,
      disconnectAll,
    }

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          queue: {
            default: 'database',
            failed: false,
            connections: {
              database: {
                name: 'database',
                driver: 'database',
                connection: 'primary',
                table: 'jobs',
                queue: 'default',
                retryAfter: 90,
                sleep: 1,
              },
            },
          },
          database: {
            defaultConnection: 'primary',
            connections: {
              primary: {
                driver: 'sqlite',
                url: './storage/database.sqlite',
              },
            },
          },
        })),
      }
    })
    vi.doMock('@holo-js/db', async () => {
      const actual = await vi.importActual('@holo-js/db') as typeof HoloDbModule
      return {
        ...actual,
        configureDB: vi.fn(),
        resetDB: vi.fn(),
        resolveRuntimeConnectionManagerOptions: vi.fn(() => manager),
      }
    })
    vi.doMock(queueModuleSpecifier, async () => {
      const actual = await vi.importActual('@holo-js/queue') as typeof HoloQueueModule
      return {
        ...actual,
        clearQueueConnection: vi.fn(async () => 3),
        configureQueueRuntime: vi.fn(),
        shutdownQueueRuntime: vi.fn(async () => {}),
      }
    })
    vi.doMock(queueDbModuleSpecifier, async () => ({
      createQueueDbRuntimeOptions: vi.fn(() => ({
        driverFactories: [],
        failedJobStore: undefined,
      })),
    }))

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(
        isolatedCliInternals.runQueueClearCommand(io.io, projectRoot, 'database', undefined),
      ).rejects.toThrow('database queue init failed')

      const dbModule = await import('@holo-js/db') as typeof HoloDbModule
      const queueModule = await import(queueModuleSpecifier)
      expect(vi.mocked(queueModule.clearQueueConnection)).not.toHaveBeenCalled()
      expect(disconnectAll).toHaveBeenCalledTimes(1)
      expect(vi.mocked(dbModule.resetDB)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(queueModule.shutdownQueueRuntime)).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.doUnmock('@holo-js/db')
      vi.doUnmock(queueModuleSpecifier)
      vi.doUnmock(queueDbModuleSpecifier)
      vi.resetModules()
    }
  }, 30000)

  it('configures cache runtime for cache maintenance commands and reports clear/forget results', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const cacheModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/cache')
    const flush = vi.fn(async () => {})
    const forget = vi.fn(async (key: string) => key === 'present')
    const driver = vi.fn((name: string) => ({
      flush: vi.fn(async () => {}),
      forget: vi.fn(async () => false),
      driver: vi.fn(),
    }))

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          cache: {
            default: 'file',
            prefix: '',
            drivers: {
              file: {
                name: 'file',
                driver: 'file',
                path: './storage/framework/cache/data',
                prefix: '',
              },
            },
          },
          database: {
            defaultConnection: 'default',
            connections: {},
          },
          redis: {
            default: 'default',
            connections: {},
          },
        })),
      }
    })
    vi.doMock(cacheModuleSpecifier, async () => ({
      default: {
        configureCacheRuntime: vi.fn(),
        resetCacheRuntime: vi.fn(),
        flush,
        forget,
        driver,
      },
    }))

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')

      await isolatedCliInternals.runCacheClearCommand(io.io, projectRoot)
      await isolatedCliInternals.runCacheForgetCommand(io.io, projectRoot, 'present')
      await isolatedCliInternals.runCacheClearCommand(io.io, projectRoot, 'memory')
      await isolatedCliInternals.runCacheForgetCommand(io.io, projectRoot, 'missing', 'memory')

      const configModule = await import('@holo-js/config') as typeof HoloConfigModule
      const cacheModule = await import(cacheModuleSpecifier) as {
        default: {
          configureCacheRuntime: ReturnType<typeof vi.fn>
          resetCacheRuntime: ReturnType<typeof vi.fn>
        }
      }

      expect(vi.mocked(configModule.loadConfigDirectory)).toHaveBeenCalledTimes(4)
      expect(vi.mocked(cacheModule.default.configureCacheRuntime)).toHaveBeenCalledTimes(4)
      expect(flush).toHaveBeenCalledTimes(1)
      expect(forget).toHaveBeenCalledWith('present')
      expect(driver).toHaveBeenCalledWith('memory')
      expect(io.read().stdout).toContain('Cleared the default cache store.')
      expect(io.read().stdout).toContain('Forgot key "present".')
      expect(io.read().stdout).toContain('Cleared cache store "memory".')
      expect(io.read().stdout).toContain('Key "missing" was not present.')
      expect(vi.mocked(cacheModule.default.resetCacheRuntime)).toHaveBeenCalledTimes(4)
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.doUnmock(cacheModuleSpecifier)
      vi.resetModules()
    }
  }, 30_000)

  it('supports cache maintenance modules that export repository methods without a default facade', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const cacheModuleSpecifier = projectInternals.resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/cache')
    const flush = vi.fn(async () => {})

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          cache: {
            default: 'file',
            prefix: '',
            drivers: {
              file: {
                name: 'file',
                driver: 'file',
                path: './storage/framework/cache/data',
                prefix: '',
              },
            },
          },
          database: {
            defaultConnection: 'default',
            connections: {},
          },
          redis: {
            default: 'default',
            connections: {},
          },
        })),
      }
    })
    vi.doMock(cacheModuleSpecifier, async () => ({
      default: undefined,
      configureCacheRuntime: vi.fn(),
      resetCacheRuntime: vi.fn(),
      flush,
      forget: vi.fn(async () => true),
      driver: vi.fn(),
    }))

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await isolatedCliInternals.runCacheClearCommand(io.io, projectRoot)
      expect(flush).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.doUnmock(cacheModuleSpecifier)
      vi.resetModules()
    }
  }, 30_000)

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
import { defineCacheConfig } from '@holo-js/config'

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
import { defineCacheConfig } from '@holo-js/config'

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

  it('generates queue table migrations and runs failed-job helper commands with injected dependencies', async () => {
    const defaultProjectRoot = await createTempProject()
    tempDirs.push(defaultProjectRoot)

    await withFakeBun(async () => cliInternals.runQueueTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))
    await expect(withFakeBun(async () => cliInternals.runQueueTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))).rejects.toThrow('A migration for table "jobs" already exists.')
    await withFakeBun(async () => cliInternals.runQueueFailedTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))
    await expect(withFakeBun(async () => cliInternals.runQueueFailedTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))).rejects.toThrow('A migration for table "failed_jobs" already exists.')

    const defaultMigrationFiles = await readdir(join(defaultProjectRoot, 'server/db/migrations'))
    const jobsMigrationPath = join(defaultProjectRoot, 'server/db/migrations', defaultMigrationFiles.find(name => name.endsWith('create_jobs_table.ts'))!)
    const failedMigrationPath = join(defaultProjectRoot, 'server/db/migrations', defaultMigrationFiles.find(name => name.endsWith('create_failed_jobs_table.ts'))!)
    expect(await readFile(jobsMigrationPath, 'utf8')).toContain('table.string(\'reservation_id\').nullable()')
    expect(await readFile(failedMigrationPath, 'utf8')).toContain('table.text(\'exception\')')

    const customProjectRoot = await createTempProject()
    tempDirs.push(customProjectRoot)
    await writeProjectFile(customProjectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/config'

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

    expect(cliInternals.resolveDatabaseQueueTables(await loadConfigDirectory(customProjectRoot).then(config => config.queue))).toEqual(['jobs', 'report_jobs'])
    await withFakeBun(async () => cliInternals.runQueueTableCommand(createIo(customProjectRoot).io, customProjectRoot))
    await withFakeBun(async () => cliInternals.runQueueFailedTableCommand(createIo(customProjectRoot).io, customProjectRoot))
    const customMigrations = await readdir(join(customProjectRoot, 'server/db/migrations'))
    expect(customMigrations.some(name => name.endsWith('create_jobs_table.ts'))).toBe(true)
    expect(customMigrations.some(name => name.endsWith('create_report_jobs_table.ts'))).toBe(true)
    expect(customMigrations.some(name => name.endsWith('create_queue_failed_jobs_table.ts'))).toBe(true)
    expect(cliInternals.renderQueueTableMigration('jobs')).toContain('table.bigInteger(\'available_at\')')
    expect(cliInternals.renderFailedJobsTableMigration('failed_jobs')).toContain('table.bigInteger(\'failed_at\')')

    const failedOnlyProjectRoot = await createTempProject()
    tempDirs.push(failedOnlyProjectRoot)
    await withFakeBun(async () => cliInternals.runQueueFailedTableCommand(createIo(failedOnlyProjectRoot).io, failedOnlyProjectRoot))
    expect((await readdir(join(failedOnlyProjectRoot, 'server/db/migrations'))).some(name => name.endsWith('create_failed_jobs_table.ts'))).toBe(true)

    const disabledFailedProjectRoot = await createTempProject()
    tempDirs.push(disabledFailedProjectRoot)
    await writeProjectFile(disabledFailedProjectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/config'

export default defineQueueConfig({
  failed: false,
})
`)
    await withFakeBun(async () => cliInternals.runQueueFailedTableCommand(createIo(disabledFailedProjectRoot).io, disabledFailedProjectRoot))
    expect((await readdir(join(disabledFailedProjectRoot, 'server/db/migrations'))).some(name => name.endsWith('create_failed_jobs_table.ts'))).toBe(true)

    const queueIo = createIo(customProjectRoot)
    const shutdown = vi.fn(async () => {})
    const initialize = vi.fn(async () => ({ shutdown }) as never)
    const list = vi.fn(async () => [
      {
        id: 'failed-1',
        jobId: 'job-1',
        job: {
          id: 'job-1',
          name: 'reports.send',
          connection: 'database',
          queue: 'reports',
          payload: { ok: true },
          attempts: 1,
          maxAttempts: 3,
          createdAt: 100,
        },
        exception: 'boom',
        failedAt: 200,
      },
    ])
    const retry = vi.fn(async () => 2)
    const forget = vi.fn(async () => true)
    const flush = vi.fn(async () => 3)

    await cliInternals.runQueueFailedCommand(queueIo.io, customProjectRoot, {
      initialize,
      list: list as never,
    })
    await cliInternals.runQueueRetryCommand(queueIo.io, customProjectRoot, 'all', {
      initialize,
      retry: retry as never,
    })
    await cliInternals.runQueueForgetCommand(queueIo.io, customProjectRoot, 'failed-1', {
      initialize,
      forget: forget as never,
    })
    await cliInternals.runQueueFlushCommand(queueIo.io, customProjectRoot, {
      initialize,
      flush: flush as never,
    })

    expect(initialize).toHaveBeenCalledTimes(4)
    expect(list).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('all')
    expect(forget).toHaveBeenCalledWith('failed-1')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(4)
    expect(queueIo.read().stdout).toContain('failed-1 reports.send connection=database queue=reports failedAt=200')
    expect(queueIo.read().stdout).toContain('Retried 2 failed job(s).')
    expect(queueIo.read().stdout).toContain('Forgot failed job failed-1.')
    expect(queueIo.read().stdout).toContain('Flushed 3 failed job(s).')

    const emptyIo = createIo(customProjectRoot)
    await cliInternals.runQueueFailedCommand(emptyIo.io, customProjectRoot, {
      initialize,
      list: vi.fn(async () => []),
    })
    expect(emptyIo.read().stdout).toContain('No failed jobs.')

    const actualFlushProjectRoot = await createTempProject()
    tempDirs.push(actualFlushProjectRoot)
    const sqlitePath = join(actualFlushProjectRoot, 'queue.sqlite')
    await writeProjectFile(actualFlushProjectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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
import { defineQueueConfig } from '@holo-js/config'

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
    await cliInternals.runQueueFailedCommand(actualFailedIo.io, actualFlushProjectRoot)
    expect(actualFailedIo.read().stdout).toContain('failed-2 reports.send connection=database queue=default failedAt=300')
    await cliInternals.runQueueFlushCommand(actualFlushIo.io, actualFlushProjectRoot)
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
    await cliInternals.runQueueRetryCommand(actualRetryIo.io, actualFlushProjectRoot, 'failed-3')
    expect(actualRetryIo.read().stdout).toContain('Retried 1 failed job(s).')

    const actualForgetIo = createIo(actualFlushProjectRoot)
    await cliInternals.runQueueForgetCommand(actualForgetIo.io, actualFlushProjectRoot, 'missing')
    expect(actualForgetIo.read().stdout).toContain('Failed job missing was not found.')
  })

  it('generates cache table migrations with default and configured database cache tables', async () => {
    const defaultProjectRoot = await createTempProject()
    tempDirs.push(defaultProjectRoot)
    await writeProjectFile(defaultProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/config'

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

    await withFakeBun(async () => cliInternals.runCacheTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))
    await expect(withFakeBun(async () => cliInternals.runCacheTableCommand(createIo(defaultProjectRoot).io, defaultProjectRoot))).rejects.toThrow('A migration for cache tables "cache" and "cache_locks" already exists.')

    const defaultMigrationFiles = await readdir(join(defaultProjectRoot, 'server/db/migrations'))
    const defaultMigrationPath = join(defaultProjectRoot, 'server/db/migrations', defaultMigrationFiles.find(name => name.endsWith('create_cache_cache_table.ts'))!)
    const defaultMigration = await readFile(defaultMigrationPath, 'utf8')
    expect(defaultMigration).toContain('table.string(\'key\').primaryKey()')
    expect(defaultMigration).toContain('await schema.createTable(\'cache_locks\'')

    const customProjectRoot = await createTempProject()
    tempDirs.push(customProjectRoot)
    await writeProjectFile(customProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/config'

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

    expect(cliInternals.resolveDatabaseCacheTables(await loadConfigDirectory(customProjectRoot).then(config => config.cache))).toEqual([
      { table: 'cache_entries', lockTable: 'cache_entry_locks' },
      { table: 'report_cache', lockTable: 'report_cache_locks' },
    ])

    await withFakeBun(async () => cliInternals.runCacheTableCommand(createIo(customProjectRoot).io, customProjectRoot))
    const customMigrations = await readdir(join(customProjectRoot, 'server/db/migrations'))
    expect(customMigrations.some(name => name.endsWith('create_cache_entries_cache_table.ts'))).toBe(true)
    expect(customMigrations.some(name => name.endsWith('create_report_cache_cache_table.ts'))).toBe(true)
    expect(cliInternals.renderCacheTableMigration('cache_entries', 'cache_entry_locks')).toContain('table.bigInteger(\'expires_at\').nullable()')
    expect(cliInternals.renderCacheTableMigration(`cache'entries`, `cache\\locks`)).toContain('cache\\\'entries')
    expect(cliInternals.renderCacheTableMigration(`cache'entries`, `cache\\locks`)).toContain('cache\\\\locks')

    const fileOnlyProjectRoot = await createTempProject()
    tempDirs.push(fileOnlyProjectRoot)
    await writeProjectFile(fileOnlyProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/config'

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
      withFakeBun(async () => cliInternals.runCacheTableCommand(createIo(fileOnlyProjectRoot).io, fileOnlyProjectRoot)),
    ).rejects.toThrow('The configured cache drivers do not use the database driver.')

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          cache: null,
        })),
      }
    })
    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(isolatedCliInternals.loadCacheConfig(fileOnlyProjectRoot)).rejects.toThrow('Cache config is missing or malformed')
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.resetModules()
    }

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof HoloConfigModule
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          cache: {
            drivers: {
              database: {
                driver: 'database',
                table: 'cache',
                lockTable: '',
              },
            },
          },
        })),
      }
    })
    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(isolatedCliInternals.loadCacheConfig(fileOnlyProjectRoot)).rejects.toThrow('must define non-empty "table" and "lockTable" strings')
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.resetModules()
    }

    const duplicateProjectRoot = await createTempProject()
    tempDirs.push(duplicateProjectRoot)
    await writeProjectFile(duplicateProjectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/config'

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
      withFakeBun(async () => cliInternals.runCacheTableCommand(createIo(duplicateProjectRoot).io, duplicateProjectRoot)),
    ).rejects.toThrow('A migration for cache tables "report_cache" and "other_cache_locks" already exists.')
  })

  it('boots queue runtime environments without a generated registry when project discovery returns no jobs', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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

    vi.resetModules()
    vi.doMock('../src/project', async () => {
      const actual = await vi.importActual('../src/project') as typeof ProjectModule
      return {
        ...actual,
        loadGeneratedProjectRegistry: vi.fn(async () => undefined),
        prepareProjectDiscovery: vi.fn(async () => undefined),
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      const environment = await withFakeBun(async () => isolatedCliInternals.getQueueRuntimeEnvironment(projectRoot))
      expect(environment.bundledJobs).toEqual([])
      await environment.cleanup()
    } finally {
      vi.doUnmock('../src/project')
      vi.resetModules()
    }
  })

  it('runs rate-limit clear with lightweight security runtime dependencies', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const configureSecurityRuntime = vi.fn()
    const resetSecurityRuntime = vi.fn()
    const clearRateLimit = vi.fn(async () => 3)
    const createRateLimitStoreFromConfig = vi.fn(() => ({
      hit: vi.fn(),
      clear: vi.fn(),
      clearByPrefix: vi.fn(),
      clearAll: vi.fn(),
    }))

    await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
      limiter: 'login',
    }, {
      loadConfig: async () => ({
        security: {
          csrf: {
            enabled: true,
            field: '_token',
            header: 'X-CSRF-TOKEN',
            cookie: 'XSRF-TOKEN',
            except: [],
          },
          rateLimit: {
            driver: 'file',
            memory: { driver: 'memory' },
            file: { path: './storage/framework/rate-limits' },
            redis: { host: '127.0.0.1', port: 6379, db: 0, connection: 'default', prefix: 'holo:rate-limit:' },
            limiters: {},
          },
        },
      } as never),
      loadSecurityModule: async () => ({
        configureSecurityRuntime,
        resetSecurityRuntime,
        createRateLimitStoreFromConfig,
        clearRateLimit,
      } as never),
    })).resolves.toBeUndefined()

    expect(createRateLimitStoreFromConfig).toHaveBeenCalled()
    expect(configureSecurityRuntime).toHaveBeenCalledTimes(1)
    expect(clearRateLimit).toHaveBeenCalledWith({
      limiter: 'login',
    })
    expect(resetSecurityRuntime).toHaveBeenCalledTimes(1)
    expect(io.read().stdout).toContain('Cleared 3 rate-limit bucket(s).')
  })

  it('formats boolean rate-limit clear results as bucket counts', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const createDependencies = (cleared: boolean) => ({
      loadConfig: async () => ({
        security: {
          csrf: {
            enabled: true,
            field: '_token',
            header: 'X-CSRF-TOKEN',
            cookie: 'XSRF-TOKEN',
            except: [],
          },
          rateLimit: {
            driver: 'file',
            memory: { driver: 'memory' },
            file: { path: './storage/framework/rate-limits' },
            redis: { host: '127.0.0.1', port: 6379, db: 0, connection: 'default', prefix: 'holo:rate-limit:' },
            limiters: {},
          },
        },
      } as never),
      loadSecurityModule: async () => ({
        configureSecurityRuntime: vi.fn(),
        resetSecurityRuntime: vi.fn(),
        createRateLimitStoreFromConfig: vi.fn(() => ({
          hit: vi.fn(),
          clear: vi.fn(),
          clearByPrefix: vi.fn(),
          clearAll: vi.fn(),
        })),
        clearRateLimit: vi.fn(async () => cleared),
      } as never),
    })

    await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
      limiter: 'login',
    }, createDependencies(true))).resolves.toBeUndefined()
    expect(io.read().stdout).toContain('Cleared 1 rate-limit bucket(s).')

    const emptyIo = createIo(projectRoot)
    await expect(cliInternals.runRateLimitClearCommand(emptyIo.io, projectRoot, {
      limiter: 'login',
    }, createDependencies(false))).resolves.toBeUndefined()
    expect(emptyIo.read().stdout).toContain('Cleared 0 rate-limit bucket(s).')
  })

  it('rejects CLI rate-limit clearing for unsupported driver modes and validates the internal command flags', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)

    await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
      limiter: 'login',
    }, {
      loadConfig: async () => ({
        security: {
          csrf: {
            enabled: true,
            field: '_token',
            header: 'X-CSRF-TOKEN',
            cookie: 'XSRF-TOKEN',
            except: [],
          },
          rateLimit: {
            driver: 'memory',
            memory: { driver: 'memory' },
            file: { path: './storage/framework/rate-limits' },
            redis: { host: '127.0.0.1', port: 6379, db: 0, connection: 'default', prefix: 'holo:rate-limit:' },
            limiters: {},
          },
        },
      } as never),
      loadSecurityModule: async () => ({
        configureSecurityRuntime: vi.fn(),
        resetSecurityRuntime: vi.fn(),
        createRateLimitStoreFromConfig: vi.fn(),
        clearRateLimit: vi.fn(),
      } as never),
    })).rejects.toThrow('memory rate-limit driver is process-local')

    const internalContext = {
      ...io.io,
      projectRoot,
      registry: [] as never[],
      loadProject: vi.fn(async () => await loadProjectConfig(projectRoot, { required: true })),
    }
    const rateLimitExecutor = vi.fn(async () => {})
    const commands = cliInternals.createInternalCommands(
      internalContext as never,
      undefined,
      {},
      {},
      {},
      { runRateLimitClearCommand: rateLimitExecutor as never },
    )
    const rateLimitClear = commands.find(command => command.name === 'rate-limit:clear')

    await expect(rateLimitClear?.prepare?.({ args: [], flags: {} } as never, internalContext as never)).rejects.toThrow(
      'rate-limit:clear requires --limiter <name> unless --all is used.',
    )

    const prepared = await rateLimitClear!.prepare!({
      args: [],
      flags: {
        limiter: 'login',
        key: 'user-1',
      },
    } as never, internalContext as never)
    await rateLimitClear!.run({
      projectRoot,
      cwd: projectRoot,
      args: prepared.args,
      flags: prepared.flags,
      loadProject: internalContext.loadProject,
    })

    expect(rateLimitExecutor).toHaveBeenCalledWith(internalContext, projectRoot, {
      limiter: 'login',
      key: 'user-1',
    })

    await expect(rateLimitClear?.prepare?.({
      args: [],
      flags: {
        all: true,
      },
    } as never, internalContext as never)).resolves.toEqual({
      args: [],
      flags: {
        all: true,
      },
    })
  })

  it('loads the security module through createInternalCommands when no executor override is provided', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const runRateLimitClearCommand = vi.fn(async () => {})

    vi.resetModules()
    vi.doMock('../src/security', () => ({
      runRateLimitClearCommand,
    }))

    try {
      const { createInternalCommands } = await import('../src/cli')
      const internalContext = {
        ...io.io,
        projectRoot,
        registry: [] as never[],
        loadProject: vi.fn(async () => await loadProjectConfig(projectRoot, { required: true })),
      }
      const commands = createInternalCommands(internalContext as never)
      const rateLimitClear = commands.find(command => command.name === 'rate-limit:clear')

      await rateLimitClear!.run({
        projectRoot,
        cwd: projectRoot,
        args: [],
        flags: {
          all: true,
        },
        loadProject: internalContext.loadProject,
      })

      expect(runRateLimitClearCommand).toHaveBeenCalledWith(internalContext, projectRoot, {
        all: true,
      })
    } finally {
      vi.doUnmock('../src/security')
      vi.resetModules()
    }
  })

  it('reports when security support is already installed through createInternalCommands', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const installSecurityIntoProject = vi.fn(async () => ({
      updatedPackageJson: false,
      createdSecurityConfig: false,
      createdCorsConfig: false,
    }))

    vi.resetModules()
    vi.doMock('../src/project/scaffold', async () => {
      const actual = await vi.importActual('../src/project/scaffold') as typeof ProjectScaffoldInternalModule
      return {
        ...actual,
        installSecurityIntoProject,
      }
    })

    try {
      const isolatedCli = await import('../src/cli')
      const commands = isolatedCli.createInternalCommands({
        ...io.io,
        projectRoot,
        registry: [] as never[],
        loadProject: vi.fn(async () => ({ config: defaultProjectConfig() })),
      } as never)
      const install = commands.find(command => command.name === 'install')

      await install!.run({
        projectRoot,
        cwd: projectRoot,
        args: ['security'],
        flags: {},
        loadProject: async () => ({ config: defaultProjectConfig() }),
      } as never)

      expect(installSecurityIntoProject).toHaveBeenCalledWith(projectRoot)
      expect(io.read().stdout).toContain('Security support is already installed.')
    } finally {
      vi.doUnmock('../src/project/scaffold')
      vi.resetModules()
    }
  })

  it('closes the redis adapter when rate-limit clear setup fails before runtime cleanup starts', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const connect = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const resetSecurityRuntime = vi.fn()

    await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
      limiter: 'login',
    }, {
      loadConfig: async () => ({
        security: {
          csrf: {
            enabled: true,
            field: '_token',
            header: 'X-CSRF-TOKEN',
            cookie: 'XSRF-TOKEN',
            except: [],
          },
          rateLimit: {
            driver: 'redis',
            memory: { driver: 'memory' },
            file: { path: './storage/framework/rate-limits' },
            redis: { host: '127.0.0.1', port: 6379, db: 0, connection: 'default', prefix: 'holo:rate-limit:' },
            limiters: {},
          },
        },
      } as never),
      loadSecurityModule: async () => ({
        configureSecurityRuntime: vi.fn(),
        resetSecurityRuntime,
        createRateLimitStoreFromConfig: vi.fn(() => {
          throw new Error('store setup failed')
        }),
        clearRateLimit: vi.fn(),
      } as never),
      loadRedisAdapter: async () => ({
        createSecurityRedisAdapter: vi.fn(() => ({
          connect,
          close,
        })),
      }),
    } as never)).rejects.toThrow('store setup failed')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(resetSecurityRuntime).toHaveBeenCalledTimes(1)
  }, 30000)

  it('closes the redis adapter when rate-limit clear fails during redis connect', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const connect = vi.fn(async () => {
      throw new Error('redis connect failed')
    })
    const close = vi.fn(async () => {})
    const resetSecurityRuntime = vi.fn()

    await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
      limiter: 'login',
    }, {
      loadConfig: async () => ({
        security: {
          csrf: {
            enabled: true,
            field: '_token',
            header: 'X-CSRF-TOKEN',
            cookie: 'XSRF-TOKEN',
            except: [],
          },
          rateLimit: {
            driver: 'redis',
            memory: { driver: 'memory' },
            file: { path: './storage/framework/rate-limits' },
            redis: { host: '127.0.0.1', port: 6379, db: 0, connection: 'default', prefix: 'holo:rate-limit:' },
            limiters: {},
          },
        },
      } as never),
      loadSecurityModule: async () => ({
        configureSecurityRuntime: vi.fn(),
        resetSecurityRuntime,
        createRateLimitStoreFromConfig: vi.fn(),
        clearRateLimit: vi.fn(),
      } as never),
      loadRedisAdapter: async () => ({
        createSecurityRedisAdapter: vi.fn(() => ({
          connect,
          close,
        })),
      }),
    } as never)).rejects.toThrow('redis connect failed')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(resetSecurityRuntime).toHaveBeenCalledTimes(1)
  }, 30000)

  it('resets the security runtime when redis adapter close fails after rate-limit clearing', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const connect = vi.fn(async () => {})
    const close = vi.fn(async () => {
      throw new Error('redis close failed')
    })
    const resetSecurityRuntime = vi.fn()

    await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
      limiter: 'login',
    }, {
      loadConfig: async () => ({
        security: {
          csrf: {
            enabled: true,
            field: '_token',
            header: 'X-CSRF-TOKEN',
            cookie: 'XSRF-TOKEN',
            except: [],
          },
          rateLimit: {
            driver: 'redis',
            memory: { driver: 'memory' },
            file: { path: './storage/framework/rate-limits' },
            redis: { host: '127.0.0.1', port: 6379, db: 0, connection: 'default', prefix: 'holo:rate-limit:' },
            limiters: {},
          },
        },
      } as never),
      loadSecurityModule: async () => ({
        configureSecurityRuntime: vi.fn(),
        resetSecurityRuntime,
        createRateLimitStoreFromConfig: vi.fn(() => ({
          hit: vi.fn(),
          clear: vi.fn(),
          clearByPrefix: vi.fn(),
          clearAll: vi.fn(),
        })),
        clearRateLimit: vi.fn(async () => 1),
      } as never),
      loadRedisAdapter: async () => ({
        createSecurityRedisAdapter: vi.fn(() => ({
          connect,
          close,
        })),
      }),
    } as never)).rejects.toThrow('redis close failed')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(resetSecurityRuntime).toHaveBeenCalledTimes(1)
  }, 30000)

  it('loads the default security package entrypoints when clearing redis rate limits', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/redis.ts', `
export default {
  default: 'default',
  connections: {
    default: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
}
`)
    const io = createIo(projectRoot)

    await writeProjectFile(projectRoot, 'config/security.ts', `
export default {
  csrf: {
    enabled: true,
  },
  rateLimit: {
    driver: 'redis',
    redis: {
      connection: 'default',
      prefix: 'holo:rate-limit:',
    },
    limiters: {},
  },
}
`)

    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/package.json', JSON.stringify({
      name: '@holo-js/security',
      type: 'module',
      exports: {
        '.': './index.mjs',
        './drivers/redis-adapter': './drivers/redis-adapter.mjs',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/index.mjs', `
globalThis.__holoCliSecurityCalls ??= []

export function configureSecurityRuntime(options) {
  globalThis.__holoCliSecurityCalls.push({ type: 'configure', options })
}

export function resetSecurityRuntime() {
  globalThis.__holoCliSecurityCalls.push({ type: 'reset' })
}

export function createRateLimitStoreFromConfig(config, options) {
  globalThis.__holoCliSecurityCalls.push({ type: 'store', config, options })
  return {
    async hit() { return { limited: false, snapshot: { attempts: 1, expiresAt: new Date() }, retryAfterSeconds: 0 } },
    async clear() { return true },
    async clearByPrefix() { return 0 },
    async clearAll() { return 0 },
  }
}

export async function clearRateLimit(options) {
  globalThis.__holoCliSecurityCalls.push({ type: 'clear', options })
  return 2
}
`)
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/drivers/redis-adapter.mjs', `
globalThis.__holoCliSecurityCalls ??= []

export function createSecurityRedisAdapter(config) {
  globalThis.__holoCliSecurityCalls.push({ type: 'adapter', config })
  return {
    async connect() {
      globalThis.__holoCliSecurityCalls.push({ type: 'connect' })
    },
    async close() {
      globalThis.__holoCliSecurityCalls.push({ type: 'close' })
    },
  }
}
`)

    vi.stubGlobal('__holoCliSecurityCalls', [])

    try {
      await expect(cliInternals.runRateLimitClearCommand(io.io, projectRoot, {
        limiter: 'login',
        key: 'user-1',
      })).resolves.toBeUndefined()

      expect(io.read().stdout).toContain('Cleared 2 rate-limit bucket(s).')
      expect((globalThis as typeof globalThis & { __holoCliSecurityCalls?: Array<{ type: string, options?: unknown }> }).__holoCliSecurityCalls).toEqual([
        {
          type: 'adapter',
          config: expect.objectContaining({
            prefix: 'holo:rate-limit:',
          }),
        },
        { type: 'connect' },
        {
          type: 'store',
          config: expect.objectContaining({
            rateLimit: expect.objectContaining({
              driver: 'redis',
            }),
          }),
          options: expect.objectContaining({
            projectRoot,
          }),
        },
        {
          type: 'configure',
          options: expect.objectContaining({
            config: expect.objectContaining({
              rateLimit: expect.objectContaining({
                driver: 'redis',
              }),
            }),
          }),
        },
        {
          type: 'clear',
          options: {
            limiter: 'login',
            key: 'user-1',
          },
        },
        { type: 'close' },
        { type: 'reset' },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('refreshes project discovery for queue runtime environments even when a registry already exists', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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

    await withFakeBun(async () => {
      const environment = await cliInternals.getQueueRuntimeEnvironment(projectRoot)
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
    })
  }, 30000)

  it('refreshes project discovery for broadcast workers even when a registry already exists', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const staleRegistry = {
      version: 1 as const,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
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
      channels: [{
        sourcePath: 'server/channels/stale.mjs',
        pattern: 'orders.{orderId}',
        type: 'private' as const,
        params: ['orderId'],
        whispers: [],
      }],
      authorizationPolicies: [],
      authorizationAbilities: [],
    }
    const freshRegistry = {
      ...staleRegistry,
      channels: [{
        sourcePath: 'server/channels/fresh.mjs',
        pattern: 'orders.{orderId}',
        type: 'private' as const,
        params: ['orderId'],
        whispers: ['typing.start'],
      }],
    }
    const prepareProjectDiscovery = vi.fn(async () => freshRegistry)
    const loadProjectConfig = vi.fn(async () => ({
      config: defaultProjectConfig(),
    }))
    const stop = vi.fn(async () => {})
    const startBroadcastWorker = vi.fn(async () => ({
      host: '0.0.0.0',
      port: 8080,
      stop,
    }))

    vi.resetModules()
    vi.doMock('../src/project', async () => {
      const actual = await vi.importActual('../src/project') as typeof ProjectModule
      return {
        ...actual,
        loadProjectConfig,
        prepareProjectDiscovery,
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      const io = createIo(projectRoot)
      let sigintHandler: (() => void) | undefined
      const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'SIGINT') {
          sigintHandler = listener as () => void
        }
        return process
      }) as typeof process.on)
      try {
        const workPromise = withFakeBun(async () => isolatedCliInternals.runBroadcastWorkCommand(io.io, projectRoot, {
          loadConfig: async () => ({
            broadcast: { default: 'null', connections: {}, worker: {} },
            queue: { default: 'default', connections: {} },
          }) as never,
          loadModule: async () => ({
            startBroadcastWorker,
          }),
          loadRegistry: async () => staleRegistry as never,
        }))

        while (startBroadcastWorker.mock.calls.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 5))
        }

        expect(sigintHandler).toBeTypeOf('function')
        sigintHandler?.()
        await expect(workPromise).resolves.toBeUndefined()
        expect(prepareProjectDiscovery).toHaveBeenCalledTimes(1)
        expect(startBroadcastWorker).toHaveBeenCalledWith(expect.objectContaining({
          channelAuth: {
            registry: {
              projectRoot,
              channels: freshRegistry.channels,
            },
            importModule: expect.any(Function),
          },
        }))
        expect(stop).toHaveBeenCalledTimes(1)
      } finally {
        processOnSpy.mockRestore()
      }
    } finally {
      vi.doUnmock('../src/project')
      vi.resetModules()
    }
  })

  it('shuts down the runtime and cleans bundled job artifacts when a discovered bundled job stops exporting a Holo job', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/broken.mjs', 'export default { nope: true }\n')

    const cleanup = vi.fn(async () => {})
    const shutdown = vi.fn(async () => {})

    vi.resetModules()
    vi.doMock('@holo-js/core', async () => {
      const actual = await vi.importActual('@holo-js/core') as typeof HoloCoreModule
      return {
        ...actual,
        initializeHolo: vi.fn(async () => ({ shutdown }) as unknown as Awaited<ReturnType<typeof initializeHolo>>),
      }
    })
    vi.doMock('../src/project', async () => {
      const actual = await vi.importActual('../src/project') as typeof ProjectModule
      return {
        ...actual,
        prepareProjectDiscovery: vi.fn(async () => undefined),
        loadGeneratedProjectRegistry: vi.fn(async () => ({
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
          jobs: [{
            sourcePath: 'server/jobs/broken.mjs',
            name: 'broken',
            queue: 'default',
          }],
          authorizationPolicies: [],
          authorizationAbilities: [],
        })),
        bundleProjectModule: vi.fn(async () => ({
          path: join(projectRoot, 'server/jobs/broken.mjs'),
          cleanup,
        })),
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await expect(isolatedCliInternals.getQueueRuntimeEnvironment(projectRoot)).rejects.toThrow(
        'Discovered job "server/jobs/broken.mjs" does not export a Holo job.',
      )
      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@holo-js/core')
      vi.doUnmock('../src/project')
      vi.resetModules()
    }
  }, 30000)

  it('does not re-import queue job modules that were already registered during runtime initialization', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/config'

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
    await writeProjectFile(projectRoot, 'server/jobs/reports/send.mjs', `
import { defineJob } from '@holo-js/queue'

globalThis.__holoQueueJobLoaded__ = (globalThis.__holoQueueJobLoaded__ ?? 0) + 1

export default defineJob({
  async handle() {},
})
`)

    vi.resetModules()
    vi.doMock('@holo-js/core', async () => {
      const actual = await vi.importActual('@holo-js/core') as typeof HoloCoreModule
      return {
        ...actual,
        initializeHolo: vi.fn(async () => {
          const queueModule = await import('@holo-js/queue')
          if (!queueModule.getRegisteredQueueJob('reports.send')) {
            queueModule.registerQueueJob({
              async handle() {},
            }, {
              name: 'reports.send',
              sourcePath: 'server/jobs/reports/send.mjs',
            })
          }

          return {
            shutdown: vi.fn(async () => {
              queueModule.resetQueueRuntime()
            }),
          } as unknown as Awaited<ReturnType<typeof initializeHolo>>
        }),
      }
    })

    try {
      const { cliInternals: isolatedCliInternals } = await import('../src/cli-internals')
      await withFakeBun(async () => {
        const environment = await isolatedCliInternals.getQueueRuntimeEnvironment(projectRoot)
        try {
          expect((globalThis as typeof globalThis & { __holoQueueJobLoaded__?: number }).__holoQueueJobLoaded__ ?? 0).toBe(1)
        } finally {
          await environment.cleanup()
        }
      })
    } finally {
      delete (globalThis as typeof globalThis & { __holoQueueJobLoaded__?: number }).__holoQueueJobLoaded__
      vi.doUnmock('@holo-js/core')
      vi.resetModules()
    }
  })

  it('restarts queue:listen workers after job changes and refreshes non-recursive watch roots', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
      kill: ReturnType<typeof vi.fn>
    }> = []
    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const prepare = vi.fn(async () => {})

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {
        connection: 'redis',
        queue: ['emails'],
      },
      (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          stdin: PassThrough
          kill: ReturnType<typeof vi.fn>
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = vi.fn(() => {
          queueMicrotask(() => {
            child.emit('close', 0)
          })
          return true
        })
        spawnedChildren.push(child)
        return child as never
      }) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || (spawnedChildren.at(0)?.listenerCount('close') ?? 0) === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/jobs/hello.mjs')
    for (let attempts = 0; attempts < 300 && spawnedChildren.length < 2; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (let attempts = 0; attempts < 300 && (spawnedChildren[1]?.listenerCount('close') ?? 0) === 0; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(spawnedChildren).toHaveLength(2)
    expect(spawnedChildren[1]?.listenerCount('close')).toBeGreaterThan(0)
    expect(spawnedChildren[0]?.kill).toHaveBeenCalledWith('SIGTERM')
    spawnedChildren[1]?.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('queues one additional queue:listen prepare while a queue refresh is already running', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    let releasePrepare: (() => void) | undefined
    let prepareCalls = 0
    const prepare = vi.fn(async () => {
      prepareCalls += 1
      if (prepareCalls !== 2) {
        return
      }

      await new Promise<void>((resolve) => {
        releasePrepare = resolve
      })
    })

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/jobs/hello.mjs')
    watchCallback('change', 'server/jobs/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 10))
    releasePrepare?.()
    while (prepareCalls < 3) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    child.emit('close', 0)

    await expect(listenPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(3)
  })

  it('does not rerun queued queue:listen prepares after shutdown begins', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    let releasePrepare: (() => void) | undefined
    let prepareCalls = 0
    const prepare = vi.fn(async () => {
      prepareCalls += 1
      if (prepareCalls !== 2) {
        return
      }

      await new Promise<void>((resolve) => {
        releasePrepare = resolve
      })
    })

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/jobs/hello.mjs')
    watchCallback('change', 'server/jobs/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 10))
    child.emit('close', 0)
    releasePrepare?.()

    await expect(listenPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('logs queue:listen prepare failures and ignores irrelevant recursive watch events after shutdown', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = vi.fn(() => true)

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    let prepareCalls = 0
    const prepare = vi.fn(async () => {
      prepareCalls += 1
      if (prepareCalls === 2) {
        throw new Error('queue prepare failed')
      }
    })

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', Buffer.from('server/jobs/hello.mjs'))
    watchCallback('change', 'README.md')
    watchCallback('change', 'server/jobs/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(io.read().stderr).toContain('queue prepare failed')

    child.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()

    watchCallback('change', 'server/jobs/hello.mjs')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('logs non-Error queue:listen prepare failures', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    let prepareCalls = 0
    const prepare = vi.fn(async () => {
      prepareCalls += 1
      if (prepareCalls === 2) {
        throw 'queue prepare string failure'
      }
    })

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => child as never) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/jobs/hello.mjs')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(io.read().stderr).toContain('queue prepare string failure')

    child.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
  })

  it('includes empty queue source roots in non-recursive watch roots', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, 'server/jobs'), { recursive: true })
    await mkdir(join(projectRoot, 'server/models'), { recursive: true })

    const roots = await cliInternals.collectQueueWatchRoots(
      projectRoot,
      await loadProjectConfig(projectRoot, { required: true }),
    )

    expect(roots).toContain(projectRoot)
    expect(roots).toContain(join(projectRoot, 'server/jobs'))
    expect(roots).toContain(join(projectRoot, 'server/models'))
  }, 30000)

  it('tracks imported helper directories in queue watch roots', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/reports/send.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)
    await writeProjectFile(projectRoot, 'server/services/mail/send.mjs', 'export const sendMail = () => true\n')
    await writeProjectFile(projectRoot, 'node_modules/example/index.js', 'export default true\n')
    await writeProjectFile(projectRoot, '.holo-js/runtime/cli/bundle/generated.mjs', 'export default true\n')
    await writeProjectFile(projectRoot, 'storage/app/media/originals/image.txt', 'binary\n')

    const roots = await cliInternals.collectQueueWatchRoots(projectRoot, await loadProjectConfig(projectRoot, { required: true }))
    expect(roots).toContain(projectRoot)
    expect(roots).toContain(join(projectRoot, 'server/jobs'))
    expect(roots).toContain(join(projectRoot, 'server/services/mail'))
    expect(roots).not.toContain(join(projectRoot, '.holo-js/runtime'))
    expect(roots).not.toContain(join(projectRoot, 'storage'))
    expect(roots).not.toContain(join(projectRoot, 'storage/app'))
    expect(roots).not.toContain(join(projectRoot, 'storage/app/media'))
    expect(roots).not.toContain(join(projectRoot, 'node_modules'))
  }, 30000)

  it('returns no queue watch roots when the requested project root is not a directory', async () => {
    const tempDir = await createTempDirectory()
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'project.txt')
    await writeFile(filePath, 'not a directory\n', 'utf8')

    await expect(cliInternals.collectQueueWatchRoots(filePath, {} as never)).resolves.toEqual([])
  })

  it('ignores invalid non-recursive queue:listen events and watcher registration errors', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/reports/send.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    const watchers = new Map<string, (eventType: string, fileName: string | Buffer | null) => void>()
    const prepare = vi.fn(async () => {})

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        if (watchPath === join(projectRoot, '.holo-js/generated')) {
          throw Object.assign(new Error('watch blocked'), { code: 'EPERM' })
        }

        watchers.set(watchPath, callback)
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (watchers.size === 0 || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchers.get(projectRoot)?.('change', 'README.md')
    watchers.get(join(projectRoot, 'server/jobs/reports'))?.('change', Buffer.from('send.mjs'))
    watchers.get(join(projectRoot, 'server/jobs/reports'))?.('change', null)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(prepare).toHaveBeenCalledTimes(1)

    child.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
  })

  it('fails queue:listen when the watcher setup or worker process fails outside restart flow', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const failingWatcherChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    failingWatcherChild.stdout = new PassThrough()
    failingWatcherChild.stderr = new PassThrough()
    failingWatcherChild.stdin = new PassThrough()

    await expect(withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => failingWatcherChild as never) as never,
      (() => {
        throw new Error('watch exploded')
      }) as never,
    ))).rejects.toThrow('watch exploded')

    const errorChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    errorChild.stdout = new PassThrough()
    errorChild.stderr = new PassThrough()
    errorChild.stdin = new PassThrough()
    const errorWatcherClose = vi.fn()
    const errorPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => errorChild as never) as never,
      ((_path: string, _options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => ({ close: errorWatcherClose }) as unknown as FSWatcher) as never,
    ))

    while (errorChild.listenerCount('error') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    errorChild.emit('error', new Error('queue exploded'))
    await expect(errorPromise).rejects.toThrow('queue exploded')
    expect(errorWatcherClose).toHaveBeenCalledTimes(1)

    const closeChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    closeChild.stdout = new PassThrough()
    closeChild.stderr = new PassThrough()
    closeChild.stdin = new PassThrough()
    const closeWatcher = vi.fn()
    const closePromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => closeChild as never) as never,
      ((_path: string, _options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => ({ close: closeWatcher }) as unknown as FSWatcher) as never,
    ))

    while (closeChild.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    closeChild.emit('close', null)
    await expect(closePromise).rejects.toThrow('Queue worker failed with exit code unknown.')
    expect(closeWatcher).toHaveBeenCalledTimes(1)
  })

  it('treats queue:listen child errors during a requested restart as a normal reload', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
      kill: ReturnType<typeof vi.fn>
    }> = []
    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined
    const prepare = vi.fn(async () => {})

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          stdin: PassThrough
          kill: ReturnType<typeof vi.fn>
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = vi.fn(() => {
          queueMicrotask(() => {
            child.emit('error', new Error('restart handoff'))
          })
          return true
        })
        spawnedChildren.push(child)
        return child as never
      }) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (!watchCallback || (spawnedChildren.at(0)?.listenerCount('error') ?? 0) === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    watchCallback('change', 'server/jobs/hello.mjs')
    while (spawnedChildren.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(spawnedChildren[0]?.kill).toHaveBeenCalledWith('SIGTERM')
    spawnedChildren[1]?.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('restarts queue:listen after an external queue:restart signal stops the child worker', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }> = []
    let watchCallback: ((eventType: string, fileName: string | Buffer | null) => void) | undefined

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          stdin: PassThrough
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        spawnedChildren.push(child)
        return child as never
      }) as never,
      ((_path: string, _options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        watchCallback = callback
        return { close() {} } as unknown as FSWatcher
      }) as never,
      async () => {},
    ))

    while (!watchCallback || (spawnedChildren.at(0)?.listenerCount('close') ?? 0) === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    await new Promise(resolve => setTimeout(resolve, 10))
    await cliInternals.writeQueueRestartSignal(projectRoot)
    spawnedChildren[0]?.emit('close', 0)

    for (let attempts = 0; attempts < 300 && spawnedChildren.length < 2; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (let attempts = 0; attempts < 300 && (spawnedChildren[1]?.listenerCount('close') ?? 0) === 0; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(spawnedChildren).toHaveLength(2)
    spawnedChildren[1]?.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
  }, 15000)

  it('watches model directories and restarts queue:listen workers after model changes', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/Post.mjs', `
export default {
  definition: { kind: 'model', name: 'Post', prunable: false },
  async prune() { return 0 },
}
`)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const spawnedChildren: Array<EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
      kill: ReturnType<typeof vi.fn>
    }> = []
    const watchers = new Map<string, (eventType: string, fileName: string | Buffer | null) => void>()
    const prepare = vi.fn(async () => {})

    const listenPromise = withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          stdin: PassThrough
          kill: ReturnType<typeof vi.fn>
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = vi.fn(() => {
          queueMicrotask(() => {
            child.emit('close', 0)
          })
          return true
        })
        spawnedChildren.push(child)
        return child as never
      }) as never,
      ((watchPath: string, options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        watchers.set(watchPath, callback)
        return { close() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (watchers.size === 0 || (spawnedChildren.at(0)?.listenerCount('close') ?? 0) === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect([...watchers.keys()]).toContain(join(projectRoot, 'server/models'))

    watchers.get(join(projectRoot, 'server/models'))?.('change', 'Post.mjs')

    for (let attempts = 0; attempts < 100 && spawnedChildren.length < 2; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (let attempts = 0; attempts < 100 && (spawnedChildren[1]?.listenerCount('close') ?? 0) === 0; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(spawnedChildren).toHaveLength(2)
    expect(spawnedChildren[0]?.kill).toHaveBeenCalledWith('SIGTERM')
    spawnedChildren[1]?.emit('close', 0)
    await expect(listenPromise).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('rethrows non-ignorable errors while registering non-recursive queue:listen watchers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/jobs/hello.mjs', `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {},
})
`)

    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    await expect(withFakeBun(async () => cliInternals.runQueueListen(
      io.io,
      projectRoot,
      {},
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        if (watchPath === projectRoot) {
          throw new Error('non-recursive watch exploded')
        }

        return { close() {} } as unknown as FSWatcher
      }) as never,
    ))).rejects.toThrow('non-recursive watch exploded')
  })

  it('ignores ENOENT and EPERM errors while registering non-recursive fallback watchers', async () => {
    expect(cliInternals.isIgnorableWatchError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true)
    expect(cliInternals.isIgnorableWatchError(Object.assign(new Error('denied'), { code: 'EPERM' }))).toBe(true)
    expect(cliInternals.isIgnorableWatchError(Object.assign(new Error('blocked'), { code: 'EACCES' }))).toBe(false)

    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        if (watchPath === join(projectRoot, 'server/commands')) {
          throw Object.assign(new Error('watch missing'), { code: 'ENOENT' })
        }

        return { close() {}, on() {}, callback } as unknown as FSWatcher
      }) as never,
    ))

    while (child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    child.emit('close', 0)
    await expect(devPromise).resolves.toBeUndefined()
  })

  it('rethrows non-ignorable errors while registering non-recursive fallback watchers', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/commands/hello.mjs', `
export default {
  description: 'Hello command.',
  async run() {},
}
`)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    await expect(withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, _callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        if (watchPath === join(projectRoot, 'server/commands')) {
          throw new Error('watch exploded')
        }

        return { close() {}, on() {} } as unknown as FSWatcher
      }) as never,
    ))).rejects.toThrow('watch exploded')
  })

  it('watches nested discovery directories in the non-recursive fallback', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, 'server/commands/nested'), { recursive: true })
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    const closeWatcher = vi.fn()
    const watchers = new Map<string, (eventType: string, fileName: string | Buffer | null) => void>()
    const prepare = vi.fn(async () => {})
    const devPromise = withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      ((watchPath: string, options: { recursive?: boolean }, callback: (eventType: string, fileName: string | Buffer | null) => void) => {
        if (options.recursive) {
          throw Object.assign(new Error('watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }

        watchers.set(watchPath, callback)
        return { close: closeWatcher, on() {} } as unknown as FSWatcher
      }) as never,
      prepare,
    ))

    while (watchers.size === 0 || child.listenerCount('close') === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect([...watchers.keys()]).toEqual(expect.arrayContaining([
      projectRoot,
      join(projectRoot, 'config'),
      join(projectRoot, 'server/commands'),
      join(projectRoot, 'server/commands/nested'),
    ]))

    watchers.get(join(projectRoot, 'server/commands/nested'))?.('change', 'hello.mjs')
    while (prepare.mock.calls.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    child.emit('close', 0)
    await expect(devPromise).resolves.toBeUndefined()
  })

  it('rethrows watcher setup errors that are not recursive-platform limitations', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    const io = createIo(projectRoot)
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      stdin: PassThrough
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()

    await expect(withFakeBun(async () => cliInternals.runProjectDevServer(
      io.io,
      projectRoot,
      (() => child as never) as never,
      (() => {
        throw new Error('watch exploded')
      }) as never,
      async () => {},
    ))).rejects.toThrow('watch exploded')
  })

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

    await withFakeBun(async () => {
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
    })
  })

  it('rejects invalid registered artifacts directly', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/Bad.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'server/db/migrations/Bad.mjs', 'export default {}')
    await writeProjectFile(projectRoot, 'server/db/seeders/Bad.mjs', 'export default {}')

    await withFakeBun(async () => {
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
    })
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

    await withFakeBun(async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toMatchObject({ version: 1 })
    })
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

    await withFakeBun(async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toMatchObject({ version: 1 })
    })

    await writeProjectFile(projectRoot, '.holo-js/generated/index.ts', 'export default 1')
    await withFakeBun(async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toBeUndefined()
    })
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

    await withFakeBun(async () => {
      await expect(loadGeneratedProjectRegistry(projectRoot)).resolves.toMatchObject({ version: 1 })
    })
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
    const accessError = Object.assign(new Error('blocked'), { code: 'EACCES' })
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof FsPromisesModule>()
      return {
        ...actual,
        access: async (path: Parameters<typeof actual.access>[0], mode?: Parameters<typeof actual.access>[1]) => {
          if (path === generatedSchemaPath) {
            throw accessError
          }
          return actual.access(path, mode)
        },
      }
    })
    vi.resetModules()

    try {
      const { writeGeneratedProjectRegistry: writeRegistryWithMockedAccess } = await import('../src/project/registry')
      await expect(writeRegistryWithMockedAccess(projectRoot, {
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
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
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

    await withFakeBun(async () => {
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
    })
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

    await withFakeBun(async () => {
      const commands = await discoverAppCommands(projectRoot, defaultProjectConfig())
      expect(commands.map(command => command.name)).toEqual(['alpha', 'zeta'])
      await expect(commands[0]?.load()).resolves.toMatchObject({ description: 'Alpha command.' })
      await expect(readFile(join(projectRoot, '.holo-js/generated/index.ts'), 'utf8')).resolves.toContain('export default registry')
    })
  })

  it('covers bundleProjectModule failure paths', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'entry.mjs', 'export default 1')

    projectInternals.setProjectModuleBundlerForTesting(async () => {
      throw { errors: [{ text: 'broken build' }] }
    })
    await expect(bundleProjectModule(projectRoot, join(projectRoot, 'entry.mjs'))).rejects.toThrow('broken build')

    projectInternals.setProjectModuleBundlerForTesting(async () => {
      throw { errors: [{ message: 'message-only build failure' }] }
    })
    await expect(bundleProjectModule(projectRoot, join(projectRoot, 'entry.mjs'))).rejects.toThrow('message-only build failure')

    projectInternals.setProjectModuleBundlerForTesting(async () => {
      throw { errors: [{}] }
    })
    await expect(bundleProjectModule(projectRoot, join(projectRoot, 'entry.mjs'))).rejects.toThrow('Unknown build error.')

    projectInternals.setProjectModuleBundlerForTesting(async () => {
      throw new Error('plain failure')
    })
    await expect(bundleProjectModule(projectRoot, join(projectRoot, 'entry.mjs'))).rejects.toThrow('plain failure')

    projectInternals.setProjectModuleBundlerForTesting(async () => {
      throw {}
    })
    await expect(bundleProjectModule(projectRoot, join(projectRoot, 'entry.mjs'))).rejects.toThrow(`Failed to load ${join(projectRoot, 'entry.mjs')}.`)
  })

  it('covers bundleProjectModule success paths and loader tsconfig extension', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: {
        strict: true,
        paths: {
          '#shared/*': ['./shared/*'],
        },
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'entry.mjs', 'export default 1')

    let capturedTsconfig = ''
    projectInternals.setProjectModuleBundlerForTesting(async (options) => {
      if (options.tsconfig) {
        capturedTsconfig = await readFile(options.tsconfig, 'utf8')
      }

      await mkdir(dirname(String(options.outfile)), { recursive: true })
      await writeFile(String(options.outfile), 'export default 1')
      return {
        errors: [],
        warnings: [],
        outputFiles: undefined,
        metafile: undefined,
        mangleCache: undefined,
      } as never
    })

    const bundled = await bundleProjectModule(projectRoot, join(projectRoot, 'entry.mjs'))
    expect(bundled.path).toMatch(/\/\.holo-js\/runtime\/cli\/bundle-[^/]+\/out\/entry\.mjs$/)
    expect(capturedTsconfig).toContain('"#shared/*": [')
    expect(capturedTsconfig).toContain('"./shared/*"')
    await bundled.cleanup()

    const fallbackRoot = await createTempProject()
    tempDirs.push(fallbackRoot)
    await writeProjectFile(fallbackRoot, 'entry.mjs', 'export default 1')

    projectInternals.setProjectModuleBundlerForTesting(async (options) => {
      if (options.tsconfig) {
        capturedTsconfig = await readFile(options.tsconfig, 'utf8')
      }

      await mkdir(dirname(String(options.outfile)), { recursive: true })
      await writeFile(String(options.outfile), 'export default 1')
      return {
        errors: [],
        warnings: [],
        outputFiles: undefined,
        metafile: undefined,
        mangleCache: undefined,
      } as never
    })

    const fallbackBundled = await bundleProjectModule(fallbackRoot, join(fallbackRoot, 'entry.mjs'))
    expect(capturedTsconfig).toContain('"~/*": [')
    expect(capturedTsconfig).toContain('"./*"')
    await fallbackBundled.cleanup()
  })

  it('cleans up successful runtime bundle temp dirs when a sibling bundle fails', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'server/models/Ok.mjs', 'export default { definition: { kind: "model", name: "Ok" }, async prune() { return 0 } }')
    await writeProjectFile(projectRoot, 'server/models/Bad.mjs', 'export default 2')

    projectInternals.setProjectModuleBundlerForTesting(async (options) => {
      const entryPoints = options.entryPoints
      const entry = Array.isArray(entryPoints) ? String(entryPoints[0] ?? '') : ''
      if (entry.endsWith('Bad.mjs')) {
        throw { errors: [{ text: 'boom' }] }
      }

      await mkdir(dirname(String(options.outfile)), { recursive: true })
      await writeFile(String(options.outfile), await readFile(entry, 'utf8'))
      return {
        errors: [],
        warnings: [],
        outputFiles: undefined,
        metafile: undefined,
        mangleCache: undefined,
      } as never
    })

    await expect(cliInternals.getRuntimeEnvironment(projectRoot)).rejects.toThrow('boom')
    await expect(readdir(join(projectRoot, '.holo-js/runtime/cli'))).resolves.toEqual([])
  })

  it('covers fallback manifest resolution and existing project config reuse', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)

    await withFakeBun(async () => {
      const loaded = await loadProjectConfig(projectRoot, { required: true })
      expect(loaded.config.models).toEqual([])

      const ensured = await ensureProjectConfig(projectRoot)
      expect(ensured.manifestPath).toContain('config/app.ts')
    })
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
    expect(executed.stdout).toContain('Internal Commands')
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
    expect(listed.stdout).toContain('Internal Commands')
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

  it('surfaces a helpful install hint when the security package cannot be loaded', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/package.json', JSON.stringify({
      name: '@holo-js/security',
      type: 'module',
      exports: {
        '.': './broken.mjs',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/broken.mjs', `
throw new Error('broken security package')
`)

    await expect(loadSecurityCliModule(projectRoot)).rejects.toThrow(
      `Unable to load @holo-js/security from ${projectRoot}. Install it with "holo install security". broken security package`,
    )
  })

  it('surfaces a helpful install hint when the security package throws a non-Error value', async () => {
    const projectRoot = await createTempProject()
    tempDirs.push(projectRoot)
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/package.json', JSON.stringify({
      name: '@holo-js/security',
      type: 'module',
      exports: {
        '.': './broken.mjs',
      },
    }, null, 2))
    await writeProjectFile(projectRoot, 'node_modules/@holo-js/security/broken.mjs', `
throw 42
`)

    await expect(loadSecurityCliModule(projectRoot)).rejects.toThrow(
      `Unable to load @holo-js/security from ${projectRoot}. Install it with "holo install security". 42`,
    )
  })
})
