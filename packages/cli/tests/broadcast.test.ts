import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as projectModule from '../src/project'
import { loadGeneratedProjectRegistry, loadProjectConfig } from '../src/project'
import { loadBroadcastCliModule, runBroadcastWorkCommand } from '../src/broadcast'
import { createInternalCommands } from '../src/cli'

vi.setConfig({
  testTimeout: 30000,
})

function createIo(projectRoot: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.WriteStream
  const stderr = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.WriteStream
  let stdoutText = ''

  stdout.on('data', (chunk) => {
    stdoutText += chunk.toString()
  })

  return {
    io: {
      cwd: projectRoot,
      stdin,
      stdout,
      stderr,
    },
    read() {
      return stdoutText
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('@holo-js/cli broadcast worker command', () => {
  const workspaceRoot = resolve(import.meta.dirname, '../../..')

  it('runs the broadcast worker with refreshed discovery and shuts down on process signals', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-run-'))
    const moduleRoot = join(tempRoot, 'node_modules', '@holo-js')
    await mkdir(join(tempRoot, 'config'), { recursive: true })
    await mkdir(join(tempRoot, 'server/channels'), { recursive: true })
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-run-fixture',
      private: true,
    }, null, 2))
    await writeFile(join(tempRoot, 'config/app.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/database.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/broadcast.ts'), [
      'import { defineBroadcastConfig } from \'@holo-js/config\'',
      '',
      'export default defineBroadcastConfig({',
      '  default: \'null\',',
      '  connections: {',
      '    null: {',
      '      driver: \'null\',',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(tempRoot, 'server/channels/orders.ts'), [
      'import { defineChannel } from \'@holo-js/broadcast\'',
      '',
      'export default defineChannel(\'orders.{orderId}\', {',
      '  type: \'private\',',
      '  authorize() {',
      '    return true',
      '  },',
      '  whispers: {},',
      '})',
      '',
    ].join('\n'), 'utf8')
    await Promise.all([
      symlink(join(workspaceRoot, 'packages/broadcast'), join(moduleRoot, 'broadcast')),
      symlink(join(workspaceRoot, 'packages/config'), join(moduleRoot, 'config')),
      symlink(join(workspaceRoot, 'packages/db'), join(moduleRoot, 'db')),
      symlink(join(workspaceRoot, 'packages/validation'), join(moduleRoot, 'validation')),
    ])

    const io = createIo(tempRoot)
    const stop = vi.fn(async () => {})
    const loadRegistry = vi.fn(async () => ({
      version: 1 as const,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      broadcast: [],
      channels: [
        {
          sourcePath: 'server/channels/stale.ts',
          pattern: 'orders.{legacyId}',
          type: 'private' as const,
          params: ['legacyId'],
          whispers: ['typing.start'],
        },
      ],
      authorizationPolicies: [],
      authorizationAbilities: [],
    }))
    const promise = runBroadcastWorkCommand(io.io, tempRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: { redis: true } })) as never,
      loadRegistry,
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async ({ config, queue, channelAuth }: { config: unknown, queue?: unknown, channelAuth?: unknown }) => {
          expect(config).toEqual({ ok: true })
          expect(queue).toEqual({ redis: true })
          expect(channelAuth).toEqual({
            registry: {
              projectRoot: tempRoot,
              channels: [
                {
                  sourcePath: 'server/channels/orders.ts',
                  pattern: 'orders.{orderId}',
                  exportName: 'default',
                  type: 'private',
                  params: ['orderId'],
                  whispers: [],
                },
              ],
            },
            importModule: expect.any(Function),
          })
          return {
            host: '0.0.0.0',
            port: 8080,
            stop: vi.fn(async () => {
              await stop()
            }),
          }
        }),
      })),
    })

    const sigintListenersBefore = process.listeners('SIGINT').length
    await vi.waitUntil(() => process.listeners('SIGINT').length > sigintListenersBefore)
    process.listeners('SIGINT')[sigintListenersBefore]?.('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(io.read()).toContain('[broadcast] Worker listening on 0.0.0.0:8080')
  })

  it('stops at most once when multiple signals are emitted', async () => {
    const io = createIo(process.cwd())
    const stop = vi.fn(async () => {})
    const sigtermListenersBefore = process.listeners('SIGTERM').length
    const sigintListenersBefore = process.listeners('SIGINT').length
    const promise = runBroadcastWorkCommand(io.io, process.cwd(), {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: {} })) as never,
      loadRegistry: vi.fn(async () => undefined),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async () => ({
          host: '127.0.0.1',
          port: 7001,
          stop: vi.fn(async () => {
            await stop()
          }),
        })),
      })),
    })

    await vi.waitUntil(() => process.listeners('SIGTERM').length > sigtermListenersBefore)
    await vi.waitUntil(() => process.listeners('SIGINT').length > sigintListenersBefore)
    const sigtermHandler = process.listeners('SIGTERM')[sigtermListenersBefore]
    const sigintHandler = process.listeners('SIGINT')[sigintListenersBefore]
    sigtermHandler?.('SIGTERM')
    sigintHandler?.('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('refreshes discovery even when loading the stale generated registry fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-stale-registry-'))
    const moduleRoot = join(tempRoot, 'node_modules', '@holo-js')
    await mkdir(join(tempRoot, 'config'), { recursive: true })
    await mkdir(join(tempRoot, 'server/channels'), { recursive: true })
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-stale-registry-fixture',
      private: true,
    }, null, 2))
    await writeFile(join(tempRoot, 'config/app.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/database.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/broadcast.ts'), [
      'import { defineBroadcastConfig } from \'@holo-js/config\'',
      '',
      'export default defineBroadcastConfig({',
      '  default: \'null\',',
      '  connections: {',
      '    null: {',
      '      driver: \'null\',',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(tempRoot, 'server/channels/orders.ts'), [
      'import { defineChannel } from \'@holo-js/broadcast\'',
      '',
      'export default defineChannel(\'orders.{orderId}\', {',
      '  type: \'private\',',
      '  authorize() {',
      '    return true',
      '  },',
      '  whispers: {},',
      '})',
      '',
    ].join('\n'), 'utf8')
    await Promise.all([
      symlink(join(workspaceRoot, 'packages/broadcast'), join(moduleRoot, 'broadcast')),
      symlink(join(workspaceRoot, 'packages/config'), join(moduleRoot, 'config')),
      symlink(join(workspaceRoot, 'packages/db'), join(moduleRoot, 'db')),
      symlink(join(workspaceRoot, 'packages/validation'), join(moduleRoot, 'validation')),
    ])

    const io = createIo(tempRoot)
    const stop = vi.fn(async () => {})
    const promise = runBroadcastWorkCommand(io.io, tempRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: {} })) as never,
      loadRegistry: vi.fn(async () => {
        throw new Error('stale-registry-broke')
      }),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async ({ channelAuth }: { channelAuth?: unknown }) => {
          expect(channelAuth).toEqual({
            registry: {
              projectRoot: tempRoot,
              channels: [
                {
                  sourcePath: 'server/channels/orders.ts',
                  pattern: 'orders.{orderId}',
                  exportName: 'default',
                  type: 'private',
                  params: ['orderId'],
                  whispers: [],
                },
              ],
            },
            importModule: expect.any(Function),
          })
          return {
            host: '127.0.0.1',
            port: 7002,
            stop,
          }
        }),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('loads the project broadcast module through project package resolution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-module-'))
    const moduleRoot = join(tempRoot, 'node_modules/@holo-js/broadcast')
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(moduleRoot, 'package.json'), JSON.stringify({
      name: '@holo-js/broadcast',
      type: 'module',
      exports: './index.mjs',
    }, null, 2))
    const fixtureModulePath = join(moduleRoot, 'index.mjs')
    await writeFile(
      fixtureModulePath,
      [
        'export async function startBroadcastWorker() {',
        '  return { host: "127.0.0.1", port: 6010, async stop() {} }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const loadedModule = await loadBroadcastCliModule(tempRoot)
    const worker = await loadedModule.startBroadcastWorker({
      config: {} as never,
      queue: undefined,
    })

    expect(worker.host).toBe('127.0.0.1')
    expect(worker.port).toBe(6010)
    await worker.stop()
  })

  it('throws a helpful error when @holo-js/broadcast is not installed', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-missing-module-'))
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-missing-module-fixture',
      private: true,
    }, null, 2))
    vi.spyOn(projectModule, 'resolveProjectPackageImportSpecifier').mockReturnValue('file:///definitely-missing-broadcast-module.mjs')

    await expect(loadBroadcastCliModule(tempRoot)).rejects.toThrow(
      `Unable to load @holo-js/broadcast from ${tempRoot}. Install it with "holo install broadcast".`,
    )
  })

  it('discovers channel auth definitions when the generated registry is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-fallback-'))
    const moduleRoot = join(tempRoot, 'node_modules', '@holo-js')
    await mkdir(join(tempRoot, 'config'), { recursive: true })
    await mkdir(join(tempRoot, 'server/channels'), { recursive: true })
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-fallback-fixture',
      private: true,
    }, null, 2))
    await writeFile(join(tempRoot, 'config/app.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/database.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/broadcast.ts'), [
      'import { defineBroadcastConfig } from \'@holo-js/config\'',
      '',
      'export default defineBroadcastConfig({',
      '  default: \'null\',',
      '  connections: {',
      '    null: {',
      '      driver: \'null\',',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(tempRoot, 'server/channels/orders.ts'), [
      'import { defineChannel } from \'@holo-js/broadcast\'',
      '',
      'export default defineChannel(\'orders.{orderId}\', {',
      '  type: \'private\',',
      '  authorize() {',
      '    return true',
      '  },',
      '  whispers: {},',
      '})',
      '',
    ].join('\n'), 'utf8')
    await Promise.all([
      symlink(join(workspaceRoot, 'packages/broadcast'), join(moduleRoot, 'broadcast')),
      symlink(join(workspaceRoot, 'packages/config'), join(moduleRoot, 'config')),
      symlink(join(workspaceRoot, 'packages/db'), join(moduleRoot, 'db')),
      symlink(join(workspaceRoot, 'packages/validation'), join(moduleRoot, 'validation')),
    ])

    const stop = vi.fn(async () => {})
    const promise = runBroadcastWorkCommand(createIo(tempRoot).io, tempRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: { redis: true } })) as never,
      loadRegistry: vi.fn(async () => undefined),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async ({ channelAuth }: { channelAuth?: { registry?: { projectRoot: string, channels: readonly unknown[] } } }) => {
          expect(channelAuth).toEqual({
            registry: {
              projectRoot: tempRoot,
              channels: [
                {
                  sourcePath: 'server/channels/orders.ts',
                  pattern: 'orders.{orderId}',
                  exportName: 'default',
                  type: 'private',
                  params: ['orderId'],
                  whispers: [],
                },
              ],
            },
            importModule: expect.any(Function),
          })
          return {
            host: '127.0.0.1',
            port: 7004,
            stop,
          }
        }),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('passes a project module importer into worker channel auth bindings', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-importer-'))
    const moduleRoot = join(tempRoot, 'node_modules', '@holo-js')
    await mkdir(join(tempRoot, 'config'), { recursive: true })
    await mkdir(join(tempRoot, 'server/channels'), { recursive: true })
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-importer-fixture',
      private: true,
    }, null, 2))
    await writeFile(join(tempRoot, 'config/app.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/database.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/broadcast.ts'), [
      'import { defineBroadcastConfig } from \'@holo-js/config\'',
      '',
      'export default defineBroadcastConfig({',
      '  default: \'null\',',
      '  connections: {',
      '    null: {',
      '      driver: \'null\',',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(tempRoot, 'server/channels/orders.ts'), [
      'import { defineChannel } from \'@holo-js/broadcast\'',
      '',
      'export default defineChannel(\'orders.{orderId}\', {',
      '  type: \'private\',',
      '  authorize() {',
      '    return true',
      '  },',
      '  whispers: {},',
      '})',
      '',
    ].join('\n'), 'utf8')
    await Promise.all([
      symlink(join(workspaceRoot, 'packages/broadcast'), join(moduleRoot, 'broadcast')),
      symlink(join(workspaceRoot, 'packages/config'), join(moduleRoot, 'config')),
      symlink(join(workspaceRoot, 'packages/db'), join(moduleRoot, 'db')),
      symlink(join(workspaceRoot, 'packages/validation'), join(moduleRoot, 'validation')),
    ])

    const stop = vi.fn(async () => {})
    const promise = runBroadcastWorkCommand(createIo(tempRoot).io, tempRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: {} })) as never,
      loadRegistry: vi.fn(async () => ({
        version: 1 as const,
        generatedAt: '2026-01-01T00:00:00.000Z',
        paths: {
          models: 'server/models',
          migrations: 'server/db/migrations',
          seeders: 'server/db/seeders',
          commands: 'server/commands',
          jobs: 'server/jobs',
          events: 'server/events',
          listeners: 'server/listeners',
          broadcast: 'server/broadcast',
          channels: 'server/channels',
          authorizationPolicies: 'server/policies',
          authorizationAbilities: 'server/abilities',
          generatedSchema: 'server/db/schema.generated.ts',
        },
        models: [],
        migrations: [],
        seeders: [],
        commands: [],
        jobs: [],
        events: [],
        listeners: [],
        broadcast: [],
        channels: [
          {
            sourcePath: 'server/channels/orders.ts',
            pattern: 'orders.{orderId}',
            exportName: 'default',
            type: 'private' as const,
            params: ['orderId'],
            whispers: [],
          },
        ],
        authorizationPolicies: [],
        authorizationAbilities: [],
      })),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async ({
          channelAuth,
        }: {
          channelAuth?: {
            registry?: { projectRoot: string, channels: readonly unknown[] }
            importModule?: (absolutePath: string) => Promise<unknown>
          }
        }) => {
          expect(channelAuth?.registry).toEqual({
            projectRoot: tempRoot,
            channels: [
              {
                sourcePath: 'server/channels/orders.ts',
                pattern: 'orders.{orderId}',
                exportName: 'default',
                type: 'private',
                params: ['orderId'],
                whispers: [],
              },
            ],
          })
          expect(channelAuth?.importModule).toEqual(expect.any(Function))
          await expect(channelAuth?.importModule?.(join(tempRoot, 'server/channels/orders.ts'))).resolves.toMatchObject({
            default: expect.objectContaining({
              pattern: 'orders.{orderId}',
              type: 'private',
            }),
          })
          return {
            host: '127.0.0.1',
            port: 7007,
            stop,
          }
        }),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('uses the default generated-registry loader when no registry dependency is injected', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-default-registry-'))
    const moduleRoot = join(tempRoot, 'node_modules', '@holo-js')
    await mkdir(join(tempRoot, 'config'), { recursive: true })
    await mkdir(join(tempRoot, 'server/channels'), { recursive: true })
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-default-registry-fixture',
      private: true,
    }, null, 2))
    await writeFile(join(tempRoot, 'config/app.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/database.ts'), 'export default {}\n', 'utf8')
    await writeFile(join(tempRoot, 'config/broadcast.ts'), [
      'import { defineBroadcastConfig } from \'@holo-js/config\'',
      '',
      'export default defineBroadcastConfig({',
      '  default: \'null\',',
      '  connections: {',
      '    null: {',
      '      driver: \'null\',',
      '    },',
      '  },',
      '})',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(tempRoot, 'server/channels/orders.ts'), [
      'import { defineChannel } from \'@holo-js/broadcast\'',
      '',
      'export default defineChannel(\'orders.{orderId}\', {',
      '  type: \'private\',',
      '  authorize() {',
      '    return true',
      '  },',
      '  whispers: {},',
      '})',
      '',
    ].join('\n'), 'utf8')
    await Promise.all([
      symlink(join(workspaceRoot, 'packages/broadcast'), join(moduleRoot, 'broadcast')),
      symlink(join(workspaceRoot, 'packages/config'), join(moduleRoot, 'config')),
      symlink(join(workspaceRoot, 'packages/db'), join(moduleRoot, 'db')),
      symlink(join(workspaceRoot, 'packages/validation'), join(moduleRoot, 'validation')),
    ])

    const stop = vi.fn(async () => {})
    const promise = runBroadcastWorkCommand(createIo(tempRoot).io, tempRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: { redis: true } })) as never,
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async ({ channelAuth }: { channelAuth?: { registry?: { projectRoot: string, channels: readonly unknown[] } } }) => {
          expect(channelAuth).toEqual({
            registry: {
              projectRoot: tempRoot,
              channels: [
                {
                  sourcePath: 'server/channels/orders.ts',
                  pattern: 'orders.{orderId}',
                  exportName: 'default',
                  type: 'private',
                  params: ['orderId'],
                  whispers: [],
                },
              ],
            },
            importModule: expect.any(Function),
          })
          return {
            host: '127.0.0.1',
            port: 7006,
            stop,
          }
        }),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('falls back to default config loader when no loadConfig dependency is injected', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-config-'))
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'broadcast-config-loader-fixture',
      private: true,
    }, null, 2))

    const stop = vi.fn(async () => {})
    const promise = runBroadcastWorkCommand(createIo(projectRoot).io, projectRoot, {
      loadRegistry: vi.fn(async () => undefined),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async () => ({
          host: '127.0.0.1',
          port: 7002,
          stop,
        })),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('falls back to default broadcast module loader when no loadModule dependency is injected', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-loader-'))
    const moduleRoot = join(projectRoot, 'node_modules/@holo-js/broadcast')
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(moduleRoot, 'package.json'), JSON.stringify({
      name: '@holo-js/broadcast',
      type: 'module',
      exports: './index.mjs',
    }, null, 2))
    await writeFile(join(moduleRoot, 'index.mjs'), [
      'export async function startBroadcastWorker() {',
      '  return {',
      '    host: "127.0.0.1",',
      '    port: 7003,',
      '    async stop() {},',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8')

    const io = createIo(projectRoot)
    const promise = runBroadcastWorkCommand(io.io, projectRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: {}, queue: {} })) as never,
      loadRegistry: vi.fn(async () => undefined),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGTERM')
    await expect(promise).resolves.toBeUndefined()
    expect(io.read()).toContain('[broadcast] Worker listening on 127.0.0.1:7003')
  })

  it('omits channel auth when discovery cannot produce a registry', async () => {
    const io = createIo(process.cwd())
    const stop = vi.fn(async () => {})

    vi.resetModules()
    vi.doMock('../src/project', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../src/project')
      return {
        ...actual,
        prepareProjectDiscovery: vi.fn(async () => undefined),
      }
    })

    try {
      const { runBroadcastWorkCommand: isolatedRunBroadcastWorkCommand } = await import('../src/broadcast')
      const promise = isolatedRunBroadcastWorkCommand(io.io, process.cwd(), {
        loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: {} })) as never,
        loadRegistry: vi.fn(async () => undefined),
        loadModule: vi.fn(async () => ({
          startBroadcastWorker: vi.fn(async ({ channelAuth }: { channelAuth?: unknown }) => {
            expect(channelAuth).toBeUndefined()
            return {
              host: '127.0.0.1',
              port: 7005,
              stop,
            }
          }),
        })),
      })

      await new Promise(resolve => setTimeout(resolve, 100))
      process.emit('SIGINT')
      await expect(promise).resolves.toBeUndefined()
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.resetModules()
      vi.doUnmock('../src/project')
    }
  })

  it('ignores duplicate stop requests when process listener removal is unavailable', async () => {
    const io = createIo(process.cwd())
    const stop = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    const offSpy = vi.spyOn(process, 'off').mockImplementation(() => process)
    const promise = runBroadcastWorkCommand(io.io, process.cwd(), {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: {} })) as never,
      loadRegistry: vi.fn(async () => undefined),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async () => ({
          host: '127.0.0.1',
          port: 7001,
          stop,
        })),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGTERM')
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(offSpy).toHaveBeenCalled()
  })

  it('regenerates broadcast discovery using the project app config when the registry is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-cli-broadcast-config-'))
    await mkdir(join(tempRoot, 'config'), { recursive: true })
    await writeFile(join(tempRoot, 'config/app.ts'), [
      'export default {',
      '  paths: {',
      "    models: 'custom/server/models',",
      "    migrations: 'custom/server/migrations',",
      "    seeders: 'custom/server/seeders',",
      "    generatedSchema: 'custom/.holo-js/generated/schema.generated.ts',",
      '  },',
      '}',
      '',
    ].join('\n'), 'utf8')

    const stop = vi.fn(async () => {})
    const promise = runBroadcastWorkCommand(createIo(tempRoot).io, tempRoot, {
      loadConfig: vi.fn(async () => ({ broadcast: { ok: true }, queue: {} })) as never,
      loadRegistry: vi.fn(async () => undefined),
      loadModule: vi.fn(async () => ({
        startBroadcastWorker: vi.fn(async () => ({
          host: '127.0.0.1',
          port: 7002,
          stop,
        })),
      })),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    process.emit('SIGINT')
    await expect(promise).resolves.toBeUndefined()

    const project = await loadProjectConfig(tempRoot, { required: true })
    const registry = await loadGeneratedProjectRegistry(tempRoot)
    expect(project.config.paths.models).toBe('custom/server/models')
    expect(registry?.paths.models).toBe('custom/server/models')
    expect(registry?.paths.generatedSchema).toBe('custom/.holo-js/generated/schema.generated.ts')
  })

  it('wires internal broadcast:work command execution to broadcast executors', async () => {
    const io = createIo(process.cwd())
    const runBroadcastWork = vi.fn(async () => {})
    const commands = createInternalCommands(
      {
        ...io.io,
        projectRoot: process.cwd(),
        loadProject: async () => ({ manifestPath: undefined, config: {} as never }),
        registry: [],
      } as never,
      async (_projectRoot, _kind, _options, callback) => callback(''),
      {},
      {},
      {
        runBroadcastWorkCommand: runBroadcastWork as never,
      },
    )

    const broadcastWork = commands.find(command => command.name === 'broadcast:work')
    expect(await broadcastWork?.prepare?.({ args: [], flags: {} } as never, {
      projectRoot: process.cwd(),
      registry: [],
    } as never)).toEqual({
      args: [],
      flags: {},
    })
    await broadcastWork?.run({ args: [], flags: {} } as never)

    expect(runBroadcastWork).toHaveBeenCalledTimes(1)
    expect(runBroadcastWork).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
    }), process.cwd())
  })
})
