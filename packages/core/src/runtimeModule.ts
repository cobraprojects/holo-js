import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BuildOptions, BuildResult } from 'esbuild'

type EsbuildModule = {
  build(options: BuildOptions): Promise<BuildResult>
}

async function importModule<TModule>(specifier: string): Promise<TModule> {
  if (process.env.VITEST) {
    return import(/* @vite-ignore */ specifier) as Promise<TModule>
  }

  return import(/* webpackIgnore: true */ specifier) as Promise<TModule>
}

const runtimeModuleRequire = createRequire(import.meta.url)

function resolveOptionalImportSpecifier(specifier: string, projectRoot?: string): string {
  if (!projectRoot) {
    return specifier
  }

  try {
    return pathToFileURL(runtimeModuleRequire.resolve(specifier, {
      paths: [projectRoot],
    })).href
  } catch {
    return specifier
  }
}

function getErrorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : ''
}

function getMissingModuleTarget(message: string): string | undefined {
  const match = message.match(/Cannot find package '([^']+)'|Cannot find module '([^']+)'|Failed to load url ([^ ]+)|Could not resolve "([^"]+)"/)
  return match?.slice(1).find((value): value is string => typeof value === 'string')
}

function normalizeImportSpecifier(specifier: string): string {
  return specifier.startsWith('file://') ? fileURLToPath(specifier) : specifier
}

function isMissingOptionalModule(error: unknown, specifier: string, resolvedSpecifier: string): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const message = getErrorMessage(error)
  const failedTarget = getMissingModuleTarget(message)
  const expectedTargets = new Set([
    specifier,
    resolvedSpecifier,
    normalizeImportSpecifier(specifier),
    normalizeImportSpecifier(resolvedSpecifier),
  ])
  const matchesRequestedTarget = typeof failedTarget === 'string' && expectedTargets.has(failedTarget)

  return (
    ('code' in error && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && matchesRequestedTarget)
    || ('code' in error && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.'))
    || (message.startsWith('Cannot find package \'') && matchesRequestedTarget)
    || (message.startsWith('Cannot find module \'') && matchesRequestedTarget)
    || (message.includes('Does the file exist?') && message.startsWith('Failed to load url ') && matchesRequestedTarget)
    || (message.startsWith('Could not resolve "') && matchesRequestedTarget)
  )
}

export async function importOptionalRuntimeModule<TModule>(
  specifier: string,
  options: {
    readonly projectRoot?: string
  } = {},
): Promise<TModule | undefined> {
  const resolvedSpecifier = resolveOptionalImportSpecifier(specifier, options.projectRoot)

  try {
    return await importModule<TModule>(resolvedSpecifier)
  } catch (error) {
    if (isMissingOptionalModule(error, specifier, resolvedSpecifier)) {
      return undefined
    }

    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeLoaderTsconfig(projectRoot: string, tempDir: string): Promise<string> {
  const projectTsconfigPath = join(projectRoot, 'tsconfig.json')
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

async function bundleRuntimeModule(
  projectRoot: string,
  entryPath: string,
): Promise<{ path: string, cleanup(): Promise<void> }> {
  const runtimeTempRoot = join(projectRoot, '.holo-js', 'runtime')
  await mkdir(runtimeTempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(runtimeTempRoot, 'bundle-'))
  const tsconfigPath = await writeLoaderTsconfig(projectRoot, tempDir)
  const outfile = join(tempDir, `${basename(entryPath, extname(entryPath))}.mjs`)

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  try {
    await runtimeModuleInternals.runEsbuild({
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
        .map((entry) => {
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

export async function importBundledRuntimeModule(
  projectRoot: string,
  entryPath: string,
): Promise<unknown> {
  const bundled = await bundleRuntimeModule(projectRoot, entryPath)

  try {
    return await runtimeModuleInternals.importModule(
      `${pathToFileURL(bundled.path).href}?t=${Date.now()}`,
    )
  } finally {
    await bundled.cleanup()
  }
}

async function loadEsbuild(): Promise<EsbuildModule> {
  const module = await import(/* webpackIgnore: true */ 'esbuild') as
    | EsbuildModule
    | { default: EsbuildModule }

  if ('build' in module) {
    return module
  }

  return module.default
}

async function runEsbuild(options: BuildOptions): Promise<BuildResult> {
  const esbuild = await runtimeModuleInternals.loadEsbuild()
  return esbuild.build(options)
}

export const runtimeModuleInternals = {
  bundleRuntimeModule,
  importModule,
  importOptionalRuntimeModule,
  loadEsbuild,
  pathExists,
  runEsbuild,
  writeLoaderTsconfig,
}
