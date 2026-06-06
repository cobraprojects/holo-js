import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureRealtimeRuntime,
  realtimeRuntimeInternals,
  resetRealtimeRuntime,
} from '../src/index'
import type { DatabaseContext } from '@holo-js/db'
import {
  handleRealtimeMutationRequest,
  handleRealtimeQueryRequest,
  handleRealtimeStreamRequest,
  realtimeServerInternals,
  resolveRealtimeDefinition,
} from '../src/server'

const tempRoots: string[] = []

afterEach(async () => {
  resetRealtimeRuntime()
  await Promise.all(tempRoots.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })))
})

async function createRealtimeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-realtime-'))
  tempRoots.push(root)
  const realtimeRoot = join(root, 'server/realtime')
  await mkdir(realtimeRoot, { recursive: true })
  await writeFile(join(realtimeRoot, 'posts.mjs'), [
    'const marker = Symbol.for(\'holo-js.realtime.definition\')',
    'function define(kind, name, access, handler) {',
    '  const definition = function definition() {}',
    '  Object.defineProperties(definition, {',
    '    kind: { value: kind, enumerable: true },',
    '    name: { value: name, enumerable: true },',
    '    access: { value: access, enumerable: true },',
    '    handler: { value: handler, enumerable: true },',
    '    $types: { value: undefined, enumerable: true },',
    '  })',
    '  Object.defineProperty(definition, marker, { value: true })',
    '  return definition',
    '}',
    'let shouldFail = false',
    'export function failNext() { shouldFail = true }',
    'export const listPosts = define(\'query\', \'posts.list\', \'public\', async () => {',
    '  if (shouldFail) {',
    '    shouldFail = false',
    '    throw new Error(\'refresh failed\')',
    '  }',
    '  return [{ id: 1, title: \'First\' }]',
    '})',
    'export const createPost = define(\'mutation\', \'posts.create\', \'public\', async ({ args }) => ({ id: 2, title: args.title }))',
    'export const privateProfile = define(\'query\', \'private.profile\', \'authenticated\', async () => ({ id: 1 }))',
    'export const privateCreate = define(\'mutation\', \'private.create\', \'authenticated\', async () => ({ id: 1 }))',
    'export const deniedProfile = define(\'query\', \'private.denied\', { require: \'public\', authorize: async () => false }, async () => ({ id: 1 }))',
    'export const brokenStats = define(\'query\', \'stats.broken\', \'public\', async () => { throw \'broken\' })',
    '',
  ].join('\n'))
  await writeFile(join(realtimeRoot, 'stats.js'), [
    'export const value = 1',
    '',
  ].join('\n'))

  return root
}

function request(body: unknown): Request {
  return new Request('http://localhost/holo/realtime/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
    },
  })
}

function malformedRequest(): Request {
  return new Request('http://localhost/holo/realtime/query', {
    method: 'POST',
    body: '{',
    headers: {
      'content-type': 'application/json',
    },
  })
}

function fakeDatabaseContext(): DatabaseContext {
  return { model: () => ({}) } as unknown as DatabaseContext
}

describe('@holo-js/realtime server handlers', () => {
  it('executes discovered query and mutation definitions from user files', async () => {
    const projectRoot = await createRealtimeProject()
    configureRealtimeRuntime({
      db: fakeDatabaseContext,
      loadAuthModule: async () => null,
    })

    const definition = await resolveRealtimeDefinition('posts.list', { projectRoot })
    expect(definition.kind).toBe('query')
    expect(definition.name).toBe('posts.list')

    const queryResponse = await handleRealtimeQueryRequest(request({
      name: 'posts.list',
      args: { limit: 1 },
    }), { projectRoot })
    const mutationResponse = await handleRealtimeMutationRequest(request({
      name: 'posts.create',
      args: { title: 'Second' },
    }), { projectRoot })

    await expect(queryResponse.json()).resolves.toEqual({
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })
    await expect(mutationResponse.json()).resolves.toEqual({
      name: 'posts.create',
      data: { id: 2 },
      dependencies: [],
    })
  })

  it('returns errors for invalid requests and wrong definition kinds', async () => {
    const projectRoot = await createRealtimeProject()
    configureRealtimeRuntime({
      db: fakeDatabaseContext,
      loadAuthModule: async () => null,
    })

    await expect((await handleRealtimeQueryRequest(request({}), { projectRoot })).json()).resolves.toEqual({
      error: 'Realtime request must include a query or mutation name.',
    })
    await expect((await handleRealtimeQueryRequest(malformedRequest(), { projectRoot })).json()).resolves.toEqual({
      error: 'Realtime request must include a query or mutation name.',
    })
    await expect((await handleRealtimeQueryRequest(request({
      name: 'posts.create',
    }), { projectRoot })).json()).resolves.toEqual({
      error: 'Realtime definition "posts.create" is not a query.',
    })
    await expect((await handleRealtimeMutationRequest(request({
      name: 'posts.list',
    }), { projectRoot })).json()).resolves.toEqual({
      error: 'Realtime definition "posts.list" is not a mutation.',
    })
    await expect(resolveRealtimeDefinition('posts.missing', { projectRoot })).rejects.toThrow('Realtime definition "posts.missing" was not found.')
    await expect((await handleRealtimeMutationRequest(request({}), { projectRoot })).json()).resolves.toEqual({
      error: 'Realtime request must include a query or mutation name.',
    })
    await expect((await handleRealtimeQueryRequest(request({
      name: 'stats.broken',
    }), { projectRoot })).json()).resolves.toEqual({
      error: 'Realtime request failed.',
    })
  })

  it('maps authenticated and denied access errors to HTTP responses', async () => {
    const projectRoot = await createRealtimeProject()
    configureRealtimeRuntime({
      db: fakeDatabaseContext,
      loadAuthModule: async () => null,
    })

    const unavailableQueryResponse = await handleRealtimeQueryRequest(request({
      name: 'private.profile',
    }), { projectRoot })
    const unavailableMutationResponse = await handleRealtimeMutationRequest(request({
      name: 'private.create',
    }), { projectRoot })
    const unavailableStreamResponse = await handleRealtimeStreamRequest(
      new Request('http://localhost/holo/realtime/stream?name=private.profile'),
      { projectRoot },
    )
    const deniedResponse = await handleRealtimeQueryRequest(request({
      name: 'private.denied',
    }), { projectRoot })

    expect(unavailableQueryResponse.status).toBe(500)
    expect(unavailableMutationResponse.status).toBe(500)
    expect(unavailableStreamResponse.status).toBe(500)
    expect(deniedResponse.status).toBe(403)
    await expect(unavailableQueryResponse.json()).resolves.toEqual({
      error: 'Realtime authenticated access requires @holo-js/auth to be installed and configured.',
    })
    await expect(unavailableMutationResponse.json()).resolves.toEqual({
      error: 'Realtime authenticated access requires @holo-js/auth to be installed and configured.',
    })
    await expect(unavailableStreamResponse.json()).resolves.toEqual({
      error: 'Realtime authenticated access requires @holo-js/auth to be installed and configured.',
    })
    await expect(deniedResponse.json()).resolves.toEqual({
      error: 'Realtime access forbidden.',
    })

    configureRealtimeRuntime({
      db: fakeDatabaseContext,
      loadAuthModule: async () => ({
        getAuthRuntime() {
          return {
            user: async () => null,
            provider: async () => null,
            guard() {
              return {
                user: async () => null,
                provider: async () => null,
              }
            },
          }
        },
      }),
    })

    const unauthorizedResponse = await handleRealtimeQueryRequest(request({
      name: 'private.profile',
    }), { projectRoot })

    expect(unauthorizedResponse.status).toBe(401)
    await expect(unauthorizedResponse.json()).resolves.toEqual({
      error: 'Realtime access denied.',
    })
  })

  it('streams query snapshots as server-sent events and unsubscribes on cancel', async () => {
    const projectRoot = await createRealtimeProject()
    const controller = new AbortController()
    configureRealtimeRuntime({
      db: fakeDatabaseContext,
      loadAuthModule: async () => null,
    })
    const response = await handleRealtimeStreamRequest(
      new Request('http://localhost/holo/realtime/stream?name=posts.list&args=%7B%22limit%22%3A1%7D', {
        signal: controller.signal,
      }),
      { projectRoot },
    )
    const reader = response.body?.getReader()

    expect(reader).toBeDefined()

    const chunk = await reader!.read()
    const module = await import(pathToFileURL(join(projectRoot, 'server/realtime/posts.mjs')).href) as {
      failNext(): void
    }
    module.failNext()
    for (const subscription of realtimeRuntimeInternals.getRuntimeState().subscriptions.values()) {
      subscription.dependencies = ['manual:posts']
    }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['manual:posts'],
    })
    await expect(reader!.read()).rejects.toThrow('refresh failed')
    controller.abort()

    expect(new TextDecoder().decode(chunk.value)).toBe('data: {"name":"posts.list","data":[{"id":1,"title":"First"}],"dependencies":[],"version":1}\n\n')
  })

  it('normalizes malformed stream args and rejects wrong stream definition kinds', async () => {
    const projectRoot = await createRealtimeProject()
    configureRealtimeRuntime({
      db: fakeDatabaseContext,
      loadAuthModule: async () => null,
    })

    const response = await handleRealtimeStreamRequest(
      new Request('http://localhost/holo/realtime/stream?name=posts.list'),
      { projectRoot },
    )
    await response.body?.cancel()

    expect(realtimeServerInternals.parseStreamRequest(
      new Request('http://localhost/holo/realtime/stream?name=posts.list&args=wat'),
    )).toEqual({
      name: 'posts.list',
      args: {},
    })

    await expect((await handleRealtimeStreamRequest(
      new Request('http://localhost/holo/realtime/stream?name=posts.create'),
      { projectRoot },
    )).json()).resolves.toEqual({
      error: 'Realtime definition "posts.create" is not a query.',
    })
    await expect((await handleRealtimeStreamRequest(
      new Request('http://localhost/holo/realtime/stream'),
      { projectRoot },
    )).json()).resolves.toEqual({
      error: 'Realtime request must include a query or mutation name.',
    })
  })

  it('finds realtime definitions only in module objects', async () => {
    const projectRoot = await createRealtimeProject()
    const files = await realtimeServerInternals.collectRealtimeFiles(join(projectRoot, 'server/realtime'))

    expect(files).toHaveLength(2)
    expect(await realtimeServerInternals.collectRealtimeFiles(join(projectRoot, 'missing'))).toEqual([])
    expect(realtimeServerInternals.findDefinitionInModule(null, 'posts.list')).toBeUndefined()
    expect(realtimeServerInternals.findDefinitionInModule({}, 'posts.list')).toBeUndefined()
  })
})
