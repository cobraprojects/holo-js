import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'
import type { WatchFactory, WatchHandle } from '../src/cli-types'
import { runProjectDevServer } from '../src/dev'
import { DISCOVERY_WATCH_PROBE_PATH } from '../src/discovery-watch'
import type { PreparedOutput } from '../src/project-prepare'

type WatchListener = (eventType: string, fileName: string) => void

async function write(root: string, path: string, content = 'original'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-dev-watch-startup-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await write(root, 'package.json', '{"name":"dev-watch-fixture","type":"module"}')
  await write(root, 'config/app.mjs', 'export default {}')
  await write(root, 'config/database.mjs', 'export default {}')
  await write(root, 'server/models/User.ts')
  return root
}

function createFakeWatcher(calls: string[]) {
  const listeners: WatchListener[] = []
  const emit = (eventType: string, path: string) => {
    for (const listener of listeners) listener(eventType, path)
  }
  const createWatcher = ((_path: string, _options: unknown, listener: WatchListener) => {
    listeners.push(listener)
    void delay(0).then(() => {
      calls.push('live')
      emit('rename', DISCOVERY_WATCH_PROBE_PATH)
    })
    return { close() {} } as unknown as WatchHandle
  }) as unknown as WatchFactory
  return { createWatcher, emit }
}

function createFakeSpawn(calls: string[]) {
  return ((() => {
    calls.push('spawn')
    const child = new EventEmitter()
    setImmediate(() => child.emit('close', 0))
    return child
  }) as unknown) as Parameters<typeof runProjectDevServer>[2]
}

async function runDev(
  root: string,
  watcher: ReturnType<typeof createFakeWatcher>,
  calls: string[],
  prepare: (call: number, recordOutputs: (output: PreparedOutput) => Promise<void>) => Promise<void> | void,
): Promise<void> {
  let preparations = 0
  await runProjectDevServer(
    { cwd: root, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    root,
    createFakeSpawn(calls),
    watcher.createWatcher,
    async (_projectRoot, _io, options) => {
      preparations += 1
      calls.push('prepare')
      await prepare(preparations, output => options?.recordOutputs?.(output) ?? Promise.resolve())
    },
  )
}

it('runs the initial prepare only after the watcher confirms it is live', async () => {
  const root = await createProject()
  const calls: string[] = []

  await runDev(root, createFakeWatcher(calls), calls, () => {})

  expect(calls).toEqual(['live', 'prepare', 'spawn'])
})

it('re-prepares before launching the server when a source edit lands during the initial prepare', async () => {
  const root = await createProject()
  const calls: string[] = []
  const watcher = createFakeWatcher(calls)

  await runDev(root, watcher, calls, (call) => {
    if (call === 1) watcher.emit('change', 'server/models/User.ts')
  })

  expect(calls).toEqual(['live', 'prepare', 'prepare', 'spawn'])
})

it('batches every source edit seen during the initial prepare into one catch-up prepare', async () => {
  const root = await createProject()
  await write(root, 'server/jobs/send.ts')
  const calls: string[] = []
  const watcher = createFakeWatcher(calls)

  await runDev(root, watcher, calls, (call) => {
    if (call !== 1) return
    watcher.emit('change', 'server/models/User.ts')
    watcher.emit('rename', 'server/jobs/send.ts')
    watcher.emit('change', 'config/app.mjs')
  })

  expect(calls).toEqual(['live', 'prepare', 'prepare', 'spawn'])
})

it('removes its liveness probe when the initial prepare fails', async () => {
  const root = await createProject()

  await expect(runDev(root, createFakeWatcher([]), [], () => {
    throw new Error('prepare failed')
  })).rejects.toThrow('prepare failed')

  await expect(stat(join(root, DISCOVERY_WATCH_PROBE_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does no extra prepare at startup when no discovery source changed', async () => {
  const root = await createProject()
  const calls: string[] = []
  const watcher = createFakeWatcher(calls)

  await runDev(root, watcher, calls, (call) => {
    if (call !== 1) return
    watcher.emit('change', 'README.md')
    watcher.emit('change', '.holo-js/generated/index.ts')
  })

  expect(calls).toEqual(['live', 'prepare', 'spawn'])
})

it('does not re-prepare for the dependency manifests and Generated schema the initial prepare writes', async () => {
  const root = await createProject()
  const calls: string[] = []
  const watcher = createFakeWatcher(calls)

  await runDev(root, watcher, calls, async (call, recordOutputs) => {
    if (call !== 1) return
    await write(root, '.holo-js/generated/schema.generated.ts', 'placeholder')
    watcher.emit('rename', '.holo-js/generated/schema.generated.ts')
    await recordOutputs('generated-schema')
    await write(root, 'package.json', '{"name":"dev-watch-fixture","type":"module","dependencies":{"better-sqlite3":"^12.0.0"}}')
    await write(root, 'package-lock.json', '{}')
    watcher.emit('change', 'package.json')
    watcher.emit('rename', 'package-lock.json')
    await recordOutputs('dependencies')
  })

  expect(calls).toEqual(['live', 'prepare', 'spawn'])
})

it('re-prepares once when a dependency manifest or the Generated schema changes after the initial prepare wrote it', async () => {
  const root = await createProject()
  const calls: string[] = []
  const watcher = createFakeWatcher(calls)

  await runDev(root, watcher, calls, async (call, recordOutputs) => {
    if (call !== 1) return
    await recordOutputs('generated-schema')
    await write(root, 'package.json', '{"name":"dev-watch-fixture","type":"module","dependencies":{"better-sqlite3":"^12.0.0"}}')
    watcher.emit('change', 'package.json')
    await recordOutputs('dependencies')
    await write(root, 'package.json', '{"name":"dev-watch-fixture","type":"module","dependencies":{"better-sqlite3":"^12.1.0"}}')
    watcher.emit('change', 'package.json')
    await write(root, '.holo-js/generated/schema.generated.ts', 'migrated')
    watcher.emit('rename', '.holo-js/generated/schema.generated.ts')
  })

  expect(calls).toEqual(['live', 'prepare', 'prepare', 'spawn'])
})

it('re-prepares once when the user edits a dependency manifest the initial prepare never wrote', async () => {
  const root = await createProject()
  const calls: string[] = []
  const watcher = createFakeWatcher(calls)

  await runDev(root, watcher, calls, async (call) => {
    if (call !== 1) return
    await write(root, 'package.json', '{"name":"dev-watch-fixture","type":"module","private":true}')
    watcher.emit('change', 'package.json')
  })

  expect(calls).toEqual(['live', 'prepare', 'prepare', 'spawn'])
})
