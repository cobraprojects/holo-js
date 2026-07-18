import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Dirent } from 'node:fs'
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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
  return options.importModule
    ? await options.importModule(filePath)
    : await import(pathToFileURL(filePath).href) as unknown
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
