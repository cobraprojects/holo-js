import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { defineMigration } from '@holo-js/db'
import { createAppCommandRuntimeBoundary } from '../src/app-command-runtime'
import { initializeProjectRuntime } from '../src/runtime'
import { defaultProjectConfig } from '../src/project'
import { defineCommand } from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/index.ts'))
const temporaryDirectories: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-app-command-runtime-'))
  temporaryDirectories.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../db-sqlite'), join(root, 'node_modules/@holo-js/db-sqlite'))
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Command Runtime',
  key: 'base64:command-runtime',
  url: 'https://command.test',
  env: 'testing',
})
`)
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databaseEntry}

export default defineDatabaseConfig({
  defaultConnection: 'default',
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('application command runtime boundary', () => {
  it('infers command context and nested operation results without user annotations', () => {
    const command = defineCommand({
      description: 'Inferred command',
      async run(context) {
        const projectRoot = await context.withRuntime(runtime => runtime.holo.projectRoot)
        const migrations = await context.withRuntime(runtime => runtime.migrate({
          names: ['2026_07_28_000001_create_command_runtime_table'] as const,
          pretend: true,
        }))
        expectTypeOf(projectRoot).toEqualTypeOf<string>()
        expectTypeOf(migrations).toEqualTypeOf<readonly string[]>()
      },
    })

    expect(command.description).toBe('Inferred command')
  })

  it('infers operation results, reuses nested runtime access, and shuts down in finally', { timeout: 15_000 }, async () => {
    const root = await createProject()
    const initialize = vi.fn(initializeProjectRuntime)
    const migration = defineMigration({
      name: '2026_07_28_000001_create_command_runtime_table',
      async up({ schema }) {
        await schema.createTable('command_runtime_records', table => {
          table.id()
        })
      },
    })
    const withRuntime = createAppCommandRuntimeBoundary(
      root,
      async () => ({ config: defaultProjectConfig() }),
      {
        initialize,
        loadMigrations: async () => [migration],
      },
    )
    let retainedRuntime: Awaited<ReturnType<typeof initializeProjectRuntime>> | undefined

    const result = await withRuntime(async (runtime) => {
      retainedRuntime = runtime.holo
      const nested = await withRuntime(inner => inner.holo === runtime.holo)
      const pretended = await runtime.migrate({
        names: ['2026_07_28_000001_create_command_runtime_table'],
        pretend: true,
      })
      const executed = await runtime.migrate({
        names: ['2026_07_28_000001_create_command_runtime_table'],
      })
      return { nested, pretended, executed }
    })

    expect(result).toEqual({
      nested: true,
      pretended: ['2026_07_28_000001_create_command_runtime_table'],
      executed: ['2026_07_28_000001_create_command_runtime_table'],
    })
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(retainedRuntime?.initialized).toBe(false)
  })

  it('rejects unknown and duplicate allow-list names without running migrations', { timeout: 15_000 }, async () => {
    const root = await createProject()
    const migrationName = '2026_07_28_000001_create_command_runtime_table'
    const migration = defineMigration({
      name: migrationName,
      async up({ schema }) {
        await schema.createTable('command_runtime_records', table => {
          table.id()
        })
      },
    })
    const withRuntime = createAppCommandRuntimeBoundary(
      root,
      async () => ({ config: defaultProjectConfig() }),
      {
        initialize: initializeProjectRuntime,
        loadMigrations: async () => [migration],
      },
    )

    let failedRuntime: Awaited<ReturnType<typeof initializeProjectRuntime>> | undefined
    await expect(withRuntime((runtime) => {
      failedRuntime = runtime.holo
      return runtime.migrate({ names: ['unknown'] })
    })).rejects.toThrow('Unknown application command migration')
    expect(failedRuntime?.initialized).toBe(false)
    await expect(withRuntime(runtime => runtime.migrate({
      names: [migrationName, migrationName],
    }))).rejects.toThrow('Duplicate requested migration name')
  })

  it('waits for shutdown before initializing a subsequent runtime session', { timeout: 15_000 }, async () => {
    const root = await createProject()
    let releaseShutdown: (() => void) | undefined
    let markShutdownStarted: (() => void) | undefined
    const shutdownStarted = new Promise<void>((resolvePromise) => {
      markShutdownStarted = resolvePromise
    })
    const shutdownGate = new Promise<void>((resolvePromise) => {
      releaseShutdown = resolvePromise
    })
    const initialize = vi.fn(async (projectRoot: string) => {
      const runtime = await initializeProjectRuntime(projectRoot)
      const shutdown = runtime.shutdown.bind(runtime)
      runtime.shutdown = async () => {
        markShutdownStarted?.()
        await shutdownGate
        await shutdown()
      }
      return runtime
    })
    const withRuntime = createAppCommandRuntimeBoundary(
      root,
      async () => ({ config: defaultProjectConfig() }),
      {
        initialize,
        loadMigrations: async () => [],
      },
    )

    const first = withRuntime(() => 'first')
    await shutdownStarted
    const second = withRuntime(() => 'second')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    expect(initialize).toHaveBeenCalledTimes(1)

    releaseShutdown?.()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(initialize).toHaveBeenCalledTimes(2)
  })
})
