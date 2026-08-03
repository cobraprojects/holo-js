import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import {
  configureRealtimeRuntime,
  handleRealtimeMutationRequest,
  handleRealtimeQueryRequest,
  realtimeServerInternals,
  resetRealtimeRuntime,
  resolveRealtimeDefinition,
} from '../src/server'
import { createFakeDatabase } from './helpers/fake-database'

describe('@holo-js/realtime server definition resolution', () => {
  it('executes query and mutation requests independently of broadcast transport', async () => {
    const database = createFakeDatabase(() => [])
    const user = {
      id: 10,
      email: 'current@example.com',
      can: async () => true,
    }
    configureRealtimeRuntime({
      db: () => database.connection,
      loadAuthModule: async () => ({
        getAuthRuntime: () => ({
          user: async () => user,
          provider: async () => 'local',
          guard: () => ({
            user: async () => user,
            provider: async () => 'local',
          }),
        }),
      }),
    })
    const query = defineRealtimeQuery({
      name: 'posts.list',
      access: 'public',
      handler: () => [{ id: 2 }],
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.rename',
      access: 'authenticated',
      handler: ({ auth }) => ({ title: 'Renamed', userId: auth.user.id }),
    })
    const options = {
      projectRoot: '/unused',
      definitions: [query, mutation],
    }

    const queryResponse = await handleRealtimeQueryRequest(new Request('http://localhost/holo/realtime/query', {
      method: 'POST',
      body: JSON.stringify({ name: 'posts.list', args: { page: 2 } }),
    }), options)
    const mutationResponse = await handleRealtimeMutationRequest(new Request('http://localhost/holo/realtime/mutation', {
      method: 'POST',
      body: JSON.stringify({ name: 'posts.rename', args: { title: 'Renamed' } }),
    }), options)

    expect(queryResponse.status).toBe(200)
    await expect(queryResponse.json()).resolves.toMatchObject({
      name: 'posts.list',
      data: [{ id: 2 }],
      version: 1,
    })
    expect(mutationResponse.status).toBe(200)
    await expect(mutationResponse.json()).resolves.toMatchObject({
      name: 'posts.rename',
      data: { title: 'Renamed', userId: 10 },
    })
    resetRealtimeRuntime()
  })

  it('resolves explicit definitions before scanning files', async () => {
    const directDefinition = defineRealtimeQuery({
      name: 'posts.direct',
      access: 'public',
      handler: () => [],
    })
    const fileDefinition = defineRealtimeQuery({
      name: 'posts.file',
      access: 'public',
      handler: () => [],
    })
    const resolvedDefinition = await resolveRealtimeDefinition('posts.direct', {
      projectRoot: '/unused',
      definitions: [
        undefined,
        fileDefinition,
        directDefinition,
      ],
      importModule: async () => {
        throw new Error('Unexpected import.')
      },
    })

    expect(resolvedDefinition).toBe(directDefinition)
  })

  it('finds definitions inside plain modules and ignores unsupported module values', () => {
    const definition = defineRealtimeQuery({
      name: 'posts.module',
      access: 'public',
      handler: () => [],
    })

    expect(realtimeServerInternals.findDefinitionInModule(null, 'posts.module')).toBeUndefined()
    expect(realtimeServerInternals.findDefinitionInModule([], 'posts.module')).toBeUndefined()
    expect(realtimeServerInternals.findDefinitionInModule({
      ignored: defineRealtimeQuery({
        name: 'posts.ignored',
        access: 'public',
        handler: () => [],
      }),
      definition,
    }, 'posts.module')).toBe(definition)
    expect(realtimeServerInternals.findDefinitionInModule({ definition }, 'posts.missing')).toBeUndefined()
  })

  it('collects realtime files recursively with supported extensions in stable order', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-server-files-'))
    const realtimeRoot = join(projectRoot, 'server/realtime')

    try {
      await mkdir(join(realtimeRoot, 'nested'), { recursive: true })
      await writeFile(join(realtimeRoot, 'b.ts'), '')
      await writeFile(join(realtimeRoot, 'a.js'), '')
      await writeFile(join(realtimeRoot, 'nested', 'c.mjs'), '')
      await writeFile(join(realtimeRoot, 'nested', 'ignored.txt'), '')

      await expect(realtimeServerInternals.collectRealtimeFiles(realtimeRoot)).resolves.toEqual([
        join(realtimeRoot, 'a.js'),
        join(realtimeRoot, 'b.ts'),
        join(realtimeRoot, 'nested', 'c.mjs'),
      ])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('scans files with custom importers and stops at the first matching exported definition', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-server-importer-'))
    const realtimeRoot = join(projectRoot, 'server/realtime')
    const firstDefinition = defineRealtimeQuery({
      name: 'posts.first',
      access: 'public',
      handler: () => [],
    })
    const secondDefinition = defineRealtimeQuery({
      name: 'posts.second',
      access: 'public',
      handler: () => [],
    })
    const importedFiles: string[] = []

    try {
      await mkdir(realtimeRoot, { recursive: true })
      const firstPath = join(realtimeRoot, 'a.ts')
      const secondPath = join(realtimeRoot, 'b.ts')
      await writeFile(firstPath, '')
      await writeFile(secondPath, '')

      const resolvedDefinition = await resolveRealtimeDefinition('posts.second', {
        projectRoot,
        importModule: async absolutePath => {
          importedFiles.push(absolutePath)
          return absolutePath === firstPath
            ? { definition: firstDefinition }
            : { definition: secondDefinition }
        },
      })

      expect(resolvedDefinition).toBe(secondDefinition)
      expect(importedFiles).toEqual([firstPath, secondPath])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('imports TypeScript realtime modules with extensionless local dependencies', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-server-dynamic-'))
    const realtimeRoot = join(projectRoot, 'server/realtime')

    try {
      await mkdir(realtimeRoot, { recursive: true })
      await writeFile(join(realtimeRoot, 'definition-value.ts'), `
export const result = [{ id: 2 }]
`)
      await writeFile(join(realtimeRoot, 'definition.ts'), `
import { result } from './definition-value'
const definition = () => result
Object.defineProperties(definition, {
  kind: { value: 'query', enumerable: true },
  name: { value: 'posts.dynamic', enumerable: true },
  access: { value: 'public', enumerable: true },
  handler: { value: () => result, enumerable: true },
  $types: { value: undefined, enumerable: true },
})
Object.defineProperty(definition, Symbol.for('holo-js.realtime.definition'), {
  value: true,
  enumerable: false,
})
export { definition }
`)

      const resolvedDefinition = await resolveRealtimeDefinition('posts.dynamic', {
        projectRoot,
      })
      expect(resolvedDefinition.kind).toBe('query')
      expect(resolvedDefinition.name).toBe('posts.dynamic')
      expect(await resolvedDefinition.handler({} as never)).toEqual([{ id: 2 }])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
