import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { Dirent } from 'node:fs'
import { build } from 'esbuild'
import {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  executeRealtimeQuery,
  isRealtimeDefinition,
  realtimeRuntimeInternals,
  RealtimeAuthUnavailableError,
  RealtimeError,
  RealtimeForbiddenError,
  RealtimeUnauthorizedError,
  resetRealtimeRuntime,
  subscribeRealtimeQuery,
} from './runtime'
import type {
  RealtimeMutationDefinitionMetadata,
  RealtimeQueryDefinitionMetadata,
} from './contracts'

export type RealtimeServerOptions = {
  readonly projectRoot: string
  readonly realtimeRoot?: string
  readonly definitions?: readonly unknown[]
  readonly importModule?: (absolutePath: string) => Promise<unknown>
}

type RealtimeResolvedDefinition = RealtimeQueryDefinitionMetadata | RealtimeMutationDefinitionMetadata

type RealtimeRequestBody = {
  readonly name?: unknown
  readonly args?: unknown
}

const realtimeFileExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

type RealtimeModuleFingerprint = {
  readonly mtimeMs: number
  readonly path: string
  readonly size: number
}

type CachedRealtimeModule = {
  readonly bundleRoot: string
  readonly fingerprints: readonly RealtimeModuleFingerprint[]
  readonly module: unknown
}

type RealtimeModuleBuildAttempt =
  | { readonly kind: 'changed', readonly trackedPaths: readonly string[] }
  | { readonly kind: 'consistent', readonly cached: CachedRealtimeModule }

const realtimeModuleCache = new Map<string, Promise<CachedRealtimeModule>>()
const MAX_REALTIME_MODULE_BUILD_ATTEMPTS = 3
const realtimeBundleDirectoryPattern = /^realtime-(\d+)-/u

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRequestName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Realtime request must include a query or mutation name.')
  }

  return value
}

async function readRealtimeRequest(request: Request): Promise<{
  readonly name: string
  readonly args: Record<string, unknown>
}> {
  const body = await request.json().catch(() => ({})) as RealtimeRequestBody
  return {
    name: normalizeRequestName(body.name),
    args: isPlainObject(body.args) ? body.args : {},
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof RealtimeUnauthorizedError) {
    return 401
  }

  if (error instanceof RealtimeForbiddenError) {
    return 403
  }

  if (error instanceof RealtimeAuthUnavailableError) {
    return 500
  }

  return 400
}

function errorResponse(error: unknown, status = errorStatus(error)): Response {
  const authorization = status === 401 || status === 403
  return Response.json({
    message: error instanceof Error ? error.message : 'Realtime request failed.',
    name: error instanceof Error ? error.name : 'RealtimeError',
    status,
    kind: authorization ? 'authorization' : 'runtime',
  }, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function successResponse(value: unknown): Response {
  return Response.json(value, {
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function resolveRealtimeRoot(options: RealtimeServerOptions): string {
  return resolve(options.projectRoot, options.realtimeRoot ?? 'server/realtime')
}

async function collectRealtimeFiles(root: string): Promise<readonly string[]> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }

  return entries
    .filter(entry => entry.isFile())
    .map(entry => resolve(root, entry.parentPath, entry.name))
    .filter(filePath => realtimeFileExtensions.has(filePath.slice(filePath.lastIndexOf('.'))))
    .sort((left, right) => left.localeCompare(right))
}

async function importRealtimeModule(filePath: string, options: RealtimeServerOptions): Promise<unknown> {
  if (options.importModule) return await options.importModule(filePath)
  const cached = realtimeModuleCache.get(filePath)
  let trackedPaths = Object.freeze([filePath]) as readonly string[]
  let previous: CachedRealtimeModule | undefined
  if (cached) {
    previous = await cached
    if (await fingerprintsMatch(previous.fingerprints)) return previous.module
    if (realtimeModuleCache.get(filePath) !== cached) return importRealtimeModule(filePath, options)
    trackedPaths = Object.freeze(previous.fingerprints.map(fingerprint => fingerprint.path))
  }

  const loading = bundleConsistentRealtimeModule(filePath, options.projectRoot, trackedPaths)
  realtimeModuleCache.set(filePath, loading)
  let loaded: CachedRealtimeModule | undefined
  try {
    loaded = await loading
    if (previous) await rm(previous.bundleRoot, { recursive: true, force: true })
    return loaded.module
  } catch (error) {
    if (realtimeModuleCache.get(filePath) === loading) {
      if (cached) realtimeModuleCache.set(filePath, cached)
      else realtimeModuleCache.delete(filePath)
    }
    if (loaded) {
      try {
        await rm(loaded.bundleRoot, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to clean up realtime module bundle "${loaded.bundleRoot}".`)
      }
    }
    throw error
  }
}

async function fingerprintRealtimePaths(paths: readonly string[]): Promise<readonly RealtimeModuleFingerprint[]> {
  const fingerprints = await Promise.all(paths.map(async (path) => {
    const file = await stat(path).catch(() => undefined)
    return file ? Object.freeze({ mtimeMs: file.mtimeMs, path, size: file.size }) : undefined
  }))
  return Object.freeze(fingerprints.filter((value): value is RealtimeModuleFingerprint => value !== undefined))
}

async function fingerprintsMatch(fingerprints: readonly RealtimeModuleFingerprint[]): Promise<boolean> {
  const current = await Promise.all(fingerprints.map(async fingerprint => {
    const file = await stat(fingerprint.path).catch(() => undefined)
    return file?.mtimeMs === fingerprint.mtimeMs && file.size === fingerprint.size
  }))
  return current.every(Boolean)
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
  }
}

async function removeAbandonedRealtimeBundles(runtimeRoot: string): Promise<void> {
  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith('realtime-')) return
    const owner = realtimeBundleDirectoryPattern.exec(entry.name)?.[1]
    if (owner && processIsRunning(Number(owner))) return
    await rm(join(runtimeRoot, entry.name), { recursive: true, force: true })
  }))
}

async function bundleConsistentRealtimeModule(
  filePath: string,
  projectRoot: string,
  initialTrackedPaths: readonly string[],
): Promise<CachedRealtimeModule> {
  let trackedPaths = initialTrackedPaths
  for (let attempt = 0; attempt < MAX_REALTIME_MODULE_BUILD_ATTEMPTS; attempt += 1) {
    const before = await fingerprintRealtimePaths(trackedPaths)
    const result = await bundleRealtimeModule(filePath, projectRoot, before)
    if (result.kind === 'consistent') return result.cached
    trackedPaths = result.trackedPaths
  }
  throw new Error(`Realtime module "${filePath}" changed repeatedly while it was being bundled.`)
}

async function bundleRealtimeModule(
  filePath: string,
  projectRoot: string,
  expectedFingerprints: readonly RealtimeModuleFingerprint[],
): Promise<RealtimeModuleBuildAttempt> {
  const runtimeRoot = resolve(projectRoot, '.holo-js/runtime')
  await mkdir(runtimeRoot, { recursive: true })
  await removeAbandonedRealtimeBundles(runtimeRoot)
  const temporaryRoot = await mkdtemp(join(runtimeRoot, `realtime-${process.pid}-`))
  const outputPath = join(temporaryRoot, `${basename(filePath, extname(filePath))}.mjs`)
  let retained = false
  try {
    const result = await build({
      absWorkingDir: projectRoot,
      bundle: true,
      entryPoints: [filePath],
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      outfile: outputPath,
      packages: 'external',
      platform: 'node',
      target: 'node20',
    })
    const inputPaths = [...new Set(Object.keys(result.metafile.inputs).map(path => resolve(projectRoot, path)))].sort()
    const fingerprints = await Promise.all(inputPaths.map(async (path) => {
      const file = await stat(path)
      return Object.freeze({ mtimeMs: file.mtimeMs, path, size: file.size })
    }))
    const expectedPaths = new Set(expectedFingerprints.map(fingerprint => fingerprint.path))
    const discoveredDifferentPaths = inputPaths.length !== expectedPaths.size
      || inputPaths.some(path => !expectedPaths.has(path))
    if (discoveredDifferentPaths || !await fingerprintsMatch(expectedFingerprints)) {
      return Object.freeze({ kind: 'changed', trackedPaths: Object.freeze(inputPaths) })
    }
    const module = await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */
      `${pathToFileURL(outputPath).href}?v=${randomUUID()}`
    ) as unknown
    retained = true
    return Object.freeze({
      kind: 'consistent',
      cached: Object.freeze({
        bundleRoot: temporaryRoot,
        fingerprints: Object.freeze(fingerprints),
        module,
      }),
    })
  } finally {
    if (!retained) await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function findDefinitionInModule(moduleValue: unknown, name: string): RealtimeResolvedDefinition | undefined {
  if (!isPlainObject(moduleValue)) {
    return undefined
  }

  for (const value of Object.values(moduleValue)) {
    if (isRealtimeDefinition(value) && value.name === name) {
      return value
    }
  }

  return undefined
}

export async function resolveRealtimeDefinition(
  name: string,
  options: RealtimeServerOptions,
): Promise<RealtimeResolvedDefinition> {
  for (const definition of options.definitions ?? []) {
    if (isRealtimeDefinition(definition) && definition.name === name) {
      return definition
    }
  }

  const root = resolveRealtimeRoot(options)
  const files = await collectRealtimeFiles(root)
  for (const filePath of files) {
    const definition = findDefinitionInModule(await importRealtimeModule(filePath, options), name)
    if (definition) {
      return definition
    }
  }

  throw new Error(`Realtime definition "${name}" was not found.`)
}

export async function handleRealtimeQueryRequest(
  request: Request,
  options: RealtimeServerOptions,
): Promise<Response> {
  try {
    const { name, args } = await readRealtimeRequest(request)
    const definition = await resolveRealtimeDefinition(name, options)
    if (definition.kind !== 'query') {
      return errorResponse(new Error(`Realtime definition "${name}" is not a query.`), 404)
    }

    const result = await executeRealtimeQuery(definition, args as never)
    return successResponse({
      ...result,
      version: 1,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleRealtimeMutationRequest(
  request: Request,
  options: RealtimeServerOptions,
): Promise<Response> {
  try {
    const { name, args } = await readRealtimeRequest(request)
    const definition = await resolveRealtimeDefinition(name, options)
    if (definition.kind !== 'mutation') {
      return errorResponse(new Error(`Realtime definition "${name}" is not a mutation.`), 404)
    }

    return successResponse(await executeRealtimeMutation(definition, args as never))
  } catch (error) {
    return errorResponse(error)
  }
}

export const realtimeServerInternals = {
  collectRealtimeFiles,
  findDefinitionInModule,
  normalizeRequestName,
  readRealtimeRequest,
}

export {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  executeRealtimeQuery,
  realtimeRuntimeInternals,
  resetRealtimeRuntime,
  RealtimeAuthUnavailableError,
  RealtimeError,
  RealtimeForbiddenError,
  RealtimeUnauthorizedError,
  subscribeRealtimeQuery,
}
