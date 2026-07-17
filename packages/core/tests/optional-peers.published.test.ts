import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  linkInstalledDependenciesForPackage,
  stagePublishedPackage,
} from '../../../tests/support/published-package'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')
const tempRoots: string[] = []

type HoloPackageName =
  | 'adapter-next'
  | 'adapter-nuxt'
  | 'adapter-sveltekit'
  | 'auth'
  | 'auth-clerk'
  | 'auth-social'
  | 'auth-social-apple'
  | 'auth-social-discord'
  | 'auth-social-facebook'
  | 'auth-social-github'
  | 'auth-social-google'
  | 'auth-social-linkedin'
  | 'auth-workos'
  | 'authorization'
  | 'broadcast'
  | 'cache'
  | 'cache-db'
  | 'cache-redis'
  | 'config'
  | 'core'
  | 'db'
  | 'db-mysql'
  | 'db-postgres'
  | 'db-sqlite'
  | 'events'
  | 'flux'
  | 'flux-react'
  | 'flux-svelte'
  | 'flux-vue'
  | 'forms'
  | 'mail'
  | 'media'
  | 'notifications'
  | 'queue'
  | 'queue-db'
  | 'queue-redis'
  | 'realtime'
  | 'security'
  | 'session'
  | 'storage'
  | 'storage-s3'
  | 'validation'

type PublishedPackageCase = {
  readonly packageName: HoloPackageName
  readonly imports: readonly string[]
}

type PackageManifest = {
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

type ExecFileError = Error & {
  readonly stdout?: Buffer | string
  readonly stderr?: Buffer | string
}

const cases: readonly PublishedPackageCase[] = [
  {
    packageName: 'adapter-next',
    imports: ['@holo-js/adapter-next', '@holo-js/adapter-next/config'],
  },
  {
    packageName: 'adapter-nuxt',
    imports: ['@holo-js/adapter-nuxt'],
  },
  {
    packageName: 'adapter-sveltekit',
    imports: ['@holo-js/adapter-sveltekit', '@holo-js/adapter-sveltekit/transport'],
  },
  {
    packageName: 'auth',
    imports: ['@holo-js/auth', '@holo-js/auth/client'],
  },
  {
    packageName: 'auth-clerk',
    imports: ['@holo-js/auth-clerk'],
  },
  {
    packageName: 'auth-social',
    imports: ['@holo-js/auth-social'],
  },
  {
    packageName: 'auth-social-apple',
    imports: ['@holo-js/auth-social-apple'],
  },
  {
    packageName: 'auth-social-discord',
    imports: ['@holo-js/auth-social-discord'],
  },
  {
    packageName: 'auth-social-facebook',
    imports: ['@holo-js/auth-social-facebook'],
  },
  {
    packageName: 'auth-social-github',
    imports: ['@holo-js/auth-social-github'],
  },
  {
    packageName: 'auth-social-google',
    imports: ['@holo-js/auth-social-google'],
  },
  {
    packageName: 'auth-social-linkedin',
    imports: ['@holo-js/auth-social-linkedin'],
  },
  {
    packageName: 'auth-workos',
    imports: ['@holo-js/auth-workos'],
  },
  {
    packageName: 'authorization',
    imports: ['@holo-js/authorization', '@holo-js/authorization/contracts'],
  },
  {
    packageName: 'broadcast',
    imports: ['@holo-js/broadcast', '@holo-js/broadcast/auth', '@holo-js/broadcast/contracts', '@holo-js/broadcast/runtime'],
  },
  {
    packageName: 'cache',
    imports: ['@holo-js/cache', '@holo-js/cache/contracts'],
  },
  {
    packageName: 'cache-db',
    imports: ['@holo-js/cache-db'],
  },
  {
    packageName: 'cache-redis',
    imports: ['@holo-js/cache-redis'],
  },
  {
    packageName: 'config',
    imports: ['@holo-js/config'],
  },
  {
    packageName: 'core',
    imports: ['@holo-js/core', '@holo-js/core/runtime'],
  },
  {
    packageName: 'db',
    imports: ['@holo-js/db'],
  },
  {
    packageName: 'db-mysql',
    imports: ['@holo-js/db-mysql'],
  },
  {
    packageName: 'db-postgres',
    imports: ['@holo-js/db-postgres'],
  },
  {
    packageName: 'db-sqlite',
    imports: ['@holo-js/db-sqlite'],
  },
  {
    packageName: 'events',
    imports: ['@holo-js/events'],
  },
  {
    packageName: 'flux',
    imports: ['@holo-js/flux'],
  },
  {
    packageName: 'flux-react',
    imports: ['@holo-js/flux-react'],
  },
  {
    packageName: 'flux-svelte',
    imports: ['@holo-js/flux-svelte'],
  },
  {
    packageName: 'flux-vue',
    imports: ['@holo-js/flux-vue'],
  },
  {
    packageName: 'forms',
    imports: ['@holo-js/forms', '@holo-js/forms/schema', '@holo-js/forms/internal/client'],
  },
  {
    packageName: 'mail',
    imports: ['@holo-js/mail', '@holo-js/mail/contracts'],
  },
  {
    packageName: 'media',
    imports: ['@holo-js/media'],
  },
  {
    packageName: 'notifications',
    imports: ['@holo-js/notifications', '@holo-js/notifications/contracts'],
  },
  {
    packageName: 'queue',
    imports: ['@holo-js/queue'],
  },
  {
    packageName: 'queue-db',
    imports: ['@holo-js/queue-db'],
  },
  {
    packageName: 'queue-redis',
    imports: ['@holo-js/queue-redis'],
  },
  {
    packageName: 'realtime',
    imports: ['@holo-js/realtime', '@holo-js/realtime/client', '@holo-js/realtime/server'],
  },
  {
    packageName: 'security',
    imports: ['@holo-js/security', '@holo-js/security/client', '@holo-js/security/contracts'],
  },
  {
    packageName: 'session',
    imports: ['@holo-js/session'],
  },
  {
    packageName: 'storage',
    imports: ['@holo-js/storage', '@holo-js/storage/runtime'],
  },
  {
    packageName: 'storage-s3',
    imports: ['@holo-js/storage-s3'],
  },
  {
    packageName: 'validation',
    imports: ['@holo-js/validation'],
  },
]

const builtPackageDirs = new Map<HoloPackageName, Promise<string>>()

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function packageSourceDir(packageName: HoloPackageName): string {
  return resolve(repoRoot, 'packages', packageName)
}

function packageSpecifier(packageName: HoloPackageName): string {
  return packageName === 'core' ? '@holo-js/core' : `@holo-js/${packageName}`
}

async function readPackageManifest(packageName: HoloPackageName): Promise<PackageManifest> {
  return JSON.parse(await readFile(join(packageSourceDir(packageName), 'package.json'), 'utf8')) as PackageManifest
}

function isHoloPackageName(value: string): value is HoloPackageName {
  return value.startsWith('@holo-js/')
    && cases.some(packageCase => packageSpecifier(packageCase.packageName) === value)
}

function toHoloPackageName(value: string): HoloPackageName {
  return value.slice('@holo-js/'.length) as HoloPackageName
}

function nonOptionalPeerDependencies(manifest: PackageManifest): readonly string[] {
  const optionalPeers = new Set(
    Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([dependencyName]) => dependencyName),
  )

  return Object.keys(manifest.peerDependencies ?? {})
    .filter(dependencyName => !optionalPeers.has(dependencyName))
}

function workspaceDependencies(manifest: PackageManifest): readonly HoloPackageName[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...nonOptionalPeerDependencies(manifest),
  ]
    .filter(isHoloPackageName)
    .map(toHoloPackageName)
}

function externalPeerDependencies(manifest: PackageManifest): readonly string[] {
  return nonOptionalPeerDependencies(manifest)
    .filter(dependencyName => !dependencyName.startsWith('@holo-js/'))
}

async function buildPackage(packageName: HoloPackageName): Promise<string> {
  let promise = builtPackageDirs.get(packageName)
  if (!promise) {
    promise = (async () => {
      const buildRoot = await createTempRoot(`holo-${packageName}-published-build-`)
      const outDir = join(buildRoot, 'dist')

      execFileSync('bun', ['run', '--filter', packageSpecifier(packageName), 'build'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      })

      return await pathExists(outDir)
        ? outDir
        : join(packageSourceDir(packageName), 'dist')
    })()
    builtPackageDirs.set(packageName, promise)
  }

  return await promise
}

function formatExecOutput(value: Buffer | string | undefined): string {
  if (typeof value === 'undefined') {
    return ''
  }

  return Buffer.isBuffer(value) ? value.toString('utf8') : value
}

function assertPublicEntrypointsImport(appRoot: string, imports: readonly string[]): void {
  const script = imports
    .map(specifier => `await import(${JSON.stringify(specifier)})`)
    .join('\n')

  try {
    execFileSync('node', ['--input-type=module', '--eval', script], {
      cwd: appRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    const execError = error as ExecFileError
    throw new Error([
      execError.message,
      formatExecOutput(execError.stdout),
      formatExecOutput(execError.stderr),
    ].filter(Boolean).join('\n'))
  }
}

function assertCoreInitializes(appRoot: string): void {
  const script = `
import { initializeHolo } from '@holo-js/core'

const runtime = await initializeHolo(process.cwd(), {
  processEnv: {
    ...process.env,
    HOLO_INTERNAL_FRAMEWORK_BUILD: '1',
  },
})
await runtime.shutdown()
`

  try {
    execFileSync('node', ['--input-type=module', '--eval', script], {
      cwd: appRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    const execError = error as ExecFileError
    throw new Error([
      execError.message,
      formatExecOutput(execError.stdout),
      formatExecOutput(execError.stderr),
    ].filter(Boolean).join('\n'))
  }
}

async function stagePackage(
  appRoot: string,
  packageName: HoloPackageName,
  stagedPackages: Set<HoloPackageName>,
): Promise<void> {
  if (stagedPackages.has(packageName)) {
    return
  }
  stagedPackages.add(packageName)

  const sourceDir = packageSourceDir(packageName)
  const packageRoot = join(appRoot, 'node_modules', '@holo-js', packageName)
  const manifest = await readPackageManifest(packageName)

  for (const dependencyName of workspaceDependencies(manifest)) {
    await stagePackage(appRoot, dependencyName, stagedPackages)
  }

  await stagePublishedPackage(sourceDir, packageRoot, await buildPackage(packageName))
  await linkInstalledDependenciesForPackage({
    repoRoot,
    nodeModulesRoot: join(appRoot, 'node_modules'),
    packageJsonPath: join(sourceDir, 'package.json'),
    extraDependencyNames: externalPeerDependencies(manifest),
  })
}

async function createPublishedApp(packageCase: PublishedPackageCase): Promise<string> {
  const appRoot = await createTempRoot(`holo-${packageCase.packageName}-published-app-`)
  await mkdir(join(appRoot, 'node_modules', '@holo-js'), { recursive: true })
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2))

  await stagePackage(appRoot, packageCase.packageName, new Set())

  return appRoot
}

afterAll(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('published optional peer behavior', () => {
  it.each(cases)('imports $packageName public entrypoints without optional peers installed', async packageCase => {
    const appRoot = await createPublishedApp(packageCase)
    assertPublicEntrypointsImport(appRoot, packageCase.imports)
  }, 120_000)

  const scaffoldFeaturePackages = [
    undefined,
    'storage',
    'events',
    'queue',
    'validation',
    'forms',
    'auth',
    'authorization',
    'notifications',
    'mail',
    'broadcast',
    'realtime',
    'security',
    'cache',
  ] as const satisfies readonly (HoloPackageName | undefined)[]

  it.each(scaffoldFeaturePackages)(
    'initializes published core with only the %s scaffold feature installed',
    async (featurePackage) => {
      const appRoot = await createTempRoot(`holo-core-${featurePackage ?? 'base'}-published-app-`)
      await mkdir(join(appRoot, 'node_modules', '@holo-js'), { recursive: true })
      await writeFile(join(appRoot, 'package.json'), JSON.stringify({
        private: true,
        type: 'module',
      }, null, 2))

      const stagedPackages = new Set<HoloPackageName>()
      await stagePackage(appRoot, 'core', stagedPackages)
      await stagePackage(appRoot, 'db-sqlite', stagedPackages)
      if (featurePackage) {
        await stagePackage(appRoot, featurePackage, stagedPackages)
      }

      assertCoreInitializes(appRoot)
    },
    120_000,
  )

  const scaffoldFeatureSelections = [
    {
      name: 'reported selection',
      packages: ['validation', 'forms', 'auth', 'authorization', 'broadcast', 'realtime', 'security', 'cache'],
    },
    {
      name: 'all optional packages',
      packages: scaffoldFeaturePackages.filter(
        (packageName): packageName is Exclude<(typeof scaffoldFeaturePackages)[number], undefined> =>
          typeof packageName === 'string',
      ),
    },
  ] as const satisfies readonly {
    readonly name: string
    readonly packages: readonly HoloPackageName[]
  }[]

  it.each(scaffoldFeatureSelections)(
    'initializes published core with the $name',
    async (selection) => {
      const appRoot = await createTempRoot(`holo-core-${selection.name.replaceAll(' ', '-')}-published-app-`)
      await mkdir(join(appRoot, 'node_modules', '@holo-js'), { recursive: true })
      await writeFile(join(appRoot, 'package.json'), JSON.stringify({
        private: true,
        type: 'module',
      }, null, 2))

      const stagedPackages = new Set<HoloPackageName>()
      await stagePackage(appRoot, 'core', stagedPackages)
      await stagePackage(appRoot, 'db-sqlite', stagedPackages)
      for (const packageName of selection.packages) {
        await stagePackage(appRoot, packageName, stagedPackages)
      }

      assertCoreInitializes(appRoot)
    },
    120_000,
  )
})
