import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'
import type { WatchFactory, WatchHandle } from '../src/cli-types'
import { runProjectDevServer } from '../src/dev'
import { DISCOVERY_WATCH_PROBE_PATH } from '../src/discovery-watch'

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

function createFakeWatcher() {
  const listeners: WatchListener[] = []
  const createWatcher = ((_path: string, _options: unknown, listener: WatchListener) => {
    listeners.push(listener)
    return { close() {} } as unknown as WatchHandle
  }) as unknown as WatchFactory
  return {
    createWatcher,
    emit(eventType: string, path: string) {
      for (const listener of listeners) listener(eventType, path)
    },
  }
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
  prepare: (call: number) => Promise<void> | void,
): Promise<void> {
  let preparations = 0
  await runProjectDevServer(
    { cwd: root, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    root,
    createFakeSpawn(calls),
    watcher.createWatcher,
    async () => {
      preparations += 1
      calls.push('prepare')
      await prepare(preparations)
    },
  )
}

it('re-prepares before launching the server when a source edit lands during the initial prepare', async () => {
  const root = await createProject()
  const watcher = createFakeWatcher()
  const calls: string[] = []

  await runDev(root, watcher, calls, (call) => {
    if (call !== 1) return
    watcher.emit('change', 'server/models/User.ts')
    watcher.emit('rename', DISCOVERY_WATCH_PROBE_PATH)
  })

  expect(calls).toEqual(['prepare', 'prepare', 'spawn'])
})

it('launches the server only after the watcher confirms it is live', async () => {
  const root = await createProject()
  const watcher = createFakeWatcher()
  const calls: string[] = []

  await runDev(root, watcher, calls, () => {
    void delay(0).then(() => {
      calls.push('live')
      watcher.emit('rename', DISCOVERY_WATCH_PROBE_PATH)
    })
  })

  expect(calls).toEqual(['prepare', 'live', 'spawn'])
})

it('removes its liveness probe when the initial prepare fails', async () => {
  const root = await createProject()
  const watcher = createFakeWatcher()

  await expect(runDev(root, watcher, [], () => {
    throw new Error('prepare failed')
  })).rejects.toThrow('prepare failed')

  await expect(stat(join(root, DISCOVERY_WATCH_PROBE_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does no extra prepare at startup when no discovery source changed', async () => {
  const root = await createProject()
  const watcher = createFakeWatcher()
  const calls: string[] = []

  await runDev(root, watcher, calls, (call) => {
    if (call !== 1) return
    watcher.emit('change', 'README.md')
    watcher.emit('change', '.holo-js/generated/index.ts')
    watcher.emit('rename', DISCOVERY_WATCH_PROBE_PATH)
  })

  expect(calls).toEqual(['prepare', 'spawn'])
})
