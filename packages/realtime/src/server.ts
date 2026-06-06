import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  executeRealtimeMutation,
  executeRealtimeQuery,
  isRealtimeDefinition,
  RealtimeAuthUnavailableError,
  RealtimeForbiddenError,
  RealtimeUnauthorizedError,
  subscribeRealtimeQuery,
} from './runtime'
import type {
  RealtimeMutationDefinitionMetadata,
  RealtimeQueryDefinitionMetadata,
  RealtimeSubscription,
  RealtimeSubscriptionSnapshot,
} from './contracts'

export type RealtimeServerOptions = {
  readonly projectRoot: string
  readonly realtimeRoot?: string
}

type RealtimeRequestBody = {
  readonly name?: unknown
  readonly args?: unknown
}

type RealtimeResolvedDefinition = RealtimeQueryDefinitionMetadata | RealtimeMutationDefinitionMetadata

const realtimeFileExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Realtime request must include a query or mutation name.')
  }

  return value
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

async function importRealtimeModule(filePath: string): Promise<unknown> {
  return await import(pathToFileURL(filePath).href) as unknown
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
  const root = resolveRealtimeRoot(options)
  const files = await collectRealtimeFiles(root)
  for (const filePath of files) {
    const definition = findDefinitionInModule(await importRealtimeModule(filePath), name)
    if (definition) {
      return definition
    }
  }

  throw new Error(`Realtime definition "${name}" was not found.`)
}

async function readRealtimeBody(request: Request): Promise<{
  readonly name: string
  readonly args: Record<string, unknown>
}> {
  const body = await request.json().catch(() => ({})) as RealtimeRequestBody

  return {
    name: normalizeName(body.name),
    args: normalizeArgs(body.args),
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function errorStatus(error: unknown): number {
  if (error instanceof RealtimeAuthUnavailableError) {
    return 500
  }

  if (error instanceof RealtimeUnauthorizedError) {
    return 401
  }

  if (error instanceof RealtimeForbiddenError) {
    return 403
  }

  return 400
}

function errorResponse(error: unknown, status = errorStatus(error)): Response {
  return jsonResponse({
    error: error instanceof Error ? error.message : 'Realtime request failed.',
  }, status)
}

export async function handleRealtimeQueryRequest(
  request: Request,
  options: RealtimeServerOptions,
): Promise<Response> {
  try {
    const { name, args } = await readRealtimeBody(request)
    const definition = await resolveRealtimeDefinition(name, options)
    if (definition.kind !== 'query') {
      return errorResponse(new Error(`Realtime definition "${name}" is not a query.`), 404)
    }

    const result = await executeRealtimeQuery(definition, args as never)
    return jsonResponse({
      ...result,
      version: 1,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

function parseStreamRequest(request: Request): {
  readonly name: string
  readonly args: Record<string, unknown>
} {
  const url = new URL(request.url)
  const name = normalizeName(url.searchParams.get('name'))
  const rawArgs = url.searchParams.get('args')
  if (!rawArgs) {
    return { name, args: {} }
  }

  try {
    return {
      name,
      args: normalizeArgs(JSON.parse(rawArgs) as unknown),
    }
  } catch {
    return { name, args: {} }
  }
}

function encodeSnapshot<TResult>(snapshot: RealtimeSubscriptionSnapshot<TResult>): string {
  return `data: ${JSON.stringify(snapshot)}\n\n`
}

export async function handleRealtimeStreamRequest(
  request: Request,
  options: RealtimeServerOptions,
): Promise<Response> {
  try {
    const { name, args } = parseStreamRequest(request)
    const definition = await resolveRealtimeDefinition(name, options)
    if (definition.kind !== 'query') {
      return errorResponse(new Error(`Realtime definition "${name}" is not a query.`), 404)
    }

    const encoder = new TextEncoder()
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const subscriptionRef: { current?: RealtimeSubscription<unknown> } = {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        subscriptionRef.current?.unsubscribe()
      },
    })
    const subscription = await subscribeRealtimeQuery(definition, args as never, {
      onData(snapshot) {
        streamController?.enqueue(encoder.encode(encodeSnapshot(snapshot)))
      },
      onError(error) {
        streamController?.error(error)
      },
    })
    subscriptionRef.current = subscription

    request.signal.addEventListener('abort', () => {
      subscription?.unsubscribe()
    }, { once: true })

    return new Response(stream, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/event-stream',
      },
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
    const { name, args } = await readRealtimeBody(request)
    const definition = await resolveRealtimeDefinition(name, options)
    if (definition.kind !== 'mutation') {
      return errorResponse(new Error(`Realtime definition "${name}" is not a mutation.`), 404)
    }

    return jsonResponse(await executeRealtimeMutation(definition, args as never))
  } catch (error) {
    return errorResponse(error)
  }
}

export const realtimeServerInternals = {
  collectRealtimeFiles,
  findDefinitionInModule,
  parseStreamRequest,
}
