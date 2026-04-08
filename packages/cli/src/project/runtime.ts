import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type {
  EventsDiscoveryModule,
  ProjectModuleBundler,
  QueueDiscoveryModule,
} from './shared'
import {
  APP_CONFIG_FILE_NAMES,
  CLI_RUNTIME_ROOT,
  pathExists,
} from './shared'

let projectModuleBundler: ProjectModuleBundler = build

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

export async function loadQueueDiscoveryModule(projectRoot: string): Promise<QueueDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')) as QueueDiscoveryModule
}

export async function loadEventsDiscoveryModule(projectRoot: string): Promise<EventsDiscoveryModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/events')) as EventsDiscoveryModule
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

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

export function resetProjectModuleBundlerForTesting(): void {
  projectModuleBundler = build
}

export function setProjectModuleBundlerForTesting(bundler: ProjectModuleBundler): void {
  projectModuleBundler = bundler
}
