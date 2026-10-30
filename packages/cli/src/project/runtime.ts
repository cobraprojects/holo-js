import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createSourceModuleUrlPlugin } from './source-module-url'
import type {
  AuthorizationDiscoveryModule,
  BroadcastDiscoveryModule,
  EventsDiscoveryModule,
  QueueDiscoveryModule,
} from './shared'
import {
  APP_CONFIG_FILE_NAMES,
  CLI_RUNTIME_ROOT,
  pathExists,
} from './shared'

function createHoloPackageBundlerPlugin(projectRoot: string): Plugin {
  const projectRequire = createRequire(join(projectRoot, 'package.json'))
  const cliRequire = createRequire(import.meta.url)

  return {
    name: 'holo-package-bundler',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^@holo-js\// }, ({ importer, path }) => {
        const importerRequire = importer ? createRequire(importer) : undefined
        const resolvers = [
          ...(importerRequire ? [importerRequire.resolve.bind(importerRequire)] : []),
          projectRequire.resolve.bind(projectRequire),
          cliRequire.resolve.bind(cliRequire),
        ]
        for (const resolvePackage of resolvers) {
          try {
            const resolved = resolvePackage(path)
            return {
              path: resolved.startsWith('file:') ? resolved : pathToFileURL(resolved).href,
              external: true,
            }
          } catch {
            continue
          }
        }

        const workspaceSpecifier = resolveWorkspacePackageImportSpecifier(path)
        if (workspaceSpecifier) {
          return {
            path: workspaceSpecifier,
            external: true,
          }
        }

        return undefined
      })
    },
  }
}

function resolveWorkspacePackageImportSpecifier(specifier: string): string | undefined {
  if (!specifier.startsWith('@holo-js/')) {
    return undefined
  }

  const [, packageName, ...subpathSegments] = specifier.split('/')
  if (!packageName) {
    return undefined
  }

  const subpath = subpathSegments.join('/')
  const candidateRoots = [
    resolve(import.meta.dirname, '../../', packageName),
    resolve(import.meta.dirname, '../../../', packageName),
  ]

  for (const candidateRoot of candidateRoots) {
    const candidatePath = join(candidateRoot, 'dist', subpath ? `${subpath}.mjs` : 'index.mjs')
    if (existsSync(candidatePath)) {
      return pathToFileURL(candidatePath).href
    }
  }

  return undefined
}

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
    return resolveWorkspacePackageImportSpecifier(specifier) ?? specifier
  }
}

export async function loadQueueDiscoveryModule(projectRoot: string): Promise<QueueDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')) as QueueDiscoveryModule
}

export async function loadEventsDiscoveryModule(projectRoot: string): Promise<EventsDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/events')) as EventsDiscoveryModule
}

export async function loadBroadcastDiscoveryModule(projectRoot: string): Promise<BroadcastDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/broadcast')) as BroadcastDiscoveryModule
}

export async function loadAuthorizationDiscoveryModule(projectRoot: string): Promise<AuthorizationDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/authorization')) as AuthorizationDiscoveryModule
}

export async function resolveFirstExistingPath(
  projectRoot: string,
  fileNames: readonly string[],
): Promise<string | undefined> {
  for (const fileName of fileNames) {
    const candidate = join(projectRoot, fileName)
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  return undefined
}

export async function isModulePackage(projectRoot: string): Promise<boolean> {
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

type ProjectBundleOptions = { bundleDependencies?: boolean, external?: readonly string[] }

export async function bundleProjectModule(
  projectRoot: string,
  entryPath: string,
  options: ProjectBundleOptions = {},
): Promise<{ path: string, cleanup(): Promise<void> }> {
  const bundle = await bundleProjectModules(projectRoot, [entryPath], options)
  return { path: bundle.paths[0]!, cleanup: bundle.cleanup }
}

export async function bundleProjectModules(
  projectRoot: string,
  entryPaths: readonly string[],
  options: ProjectBundleOptions = {},
): Promise<{ paths: readonly string[], cleanup(): Promise<void> }> {
  if (entryPaths.length === 0) return { paths: [], async cleanup() {} }
  const runtimeTempRoot = join(projectRoot, CLI_RUNTIME_ROOT)
  await mkdir(runtimeTempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(runtimeTempRoot, 'bundle-'))
  const outdir = join(tempDir, 'out')
  const outputNames = entryPaths.map((entryPath, index) => `${index}/${basename(entryPath, extname(entryPath))}`)

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  try {
    const { projectTsconfigInternals } = await import('@holo-js/core')
    await projectTsconfigInternals.withLoaderTsconfig(projectRoot, tsconfigPath => build({
      absWorkingDir: projectRoot,
      bundle: true,
      entryPoints: entryPaths.map((entryPath, index) => ({ in: entryPath, out: outputNames[index]! })),
      outdir,
      outExtension: { '.js': '.mjs' },
      format: 'esm',
      logLevel: 'silent',
      packages: options.bundleDependencies ? 'bundle' : 'external',
      platform: 'node',
      target: 'node22',
      tsconfig: tsconfigPath,
      sourcemap: false,
      plugins: [
        createSourceModuleUrlPlugin(),
        createHoloPackageBundlerPlugin(projectRoot),
      ],
      external: [...(options.external ?? [])],
    }))

    return {
      paths: outputNames.map(name => join(outdir, `${name}.mjs`)),
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

      throw new Error(message, { cause: error })
    }

    if (error instanceof Error && error.message) {
      throw error
    }

    throw new Error(`Failed to load ${entryPaths.join(', ')}.`, { cause: error })
  }
}

export interface ProjectModuleBatch {
  bundle(entryPaths: readonly string[]): Promise<void>
  import(entryPath: string): Promise<unknown>
  cleanup(): Promise<void>
}

export function createProjectModuleBatch(projectRoot: string): ProjectModuleBatch {
  const bundledPaths = new Map<string, string>()
  let cleanupBundle = async () => {}

  return {
    async bundle(entryPaths) {
      const bundle = await bundleProjectModules(projectRoot, entryPaths)
      cleanupBundle = bundle.cleanup
      entryPaths.forEach((entryPath, index) => bundledPaths.set(entryPath, bundle.paths[index]!))
    },
    async import(entryPath) {
      const bundledPath = bundledPaths.get(entryPath)
      if (!bundledPath) throw new Error(`${entryPath} was not bundled.`)
      return await import(`${pathToFileURL(bundledPath).href}?t=${Date.now()}`)
    },
    async cleanup() {
      await cleanupBundle()
    },
  }
}

export async function importProjectModule(projectRoot: string, entryPath: string): Promise<unknown> {
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

export async function readTextFile(path: string): Promise<string | undefined> {
  if (!(await pathExists(path))) {
    return undefined
  }

  return readFile(path, 'utf8')
}

