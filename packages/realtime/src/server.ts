import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
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

const realtimeFileExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveRealtimeRoot(options: RealtimeServerOptions): string {
  return resolve(options.projectRoot, options.realtimeRoot ?? 'server/realtime')
}

async function collectRealtimeFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => [])

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

export const realtimeServerInternals = {
  collectRealtimeFiles,
  findDefinitionInModule,
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
