import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { readFileSync, watch, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { runQueueListen, writeQueueRestartSignal } from '../src/queue'

it('starts replacement queue workers after preparation finishes without watching generated output', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-queue-listen-'))
  const configPath = join(projectRoot, 'framework.json')
  await mkdir(join(projectRoot, 'config'))
  await writeFile(join(projectRoot, 'config/app.mjs'), 'export default {}')
  await writeFile(join(projectRoot, 'config/database.mjs'), 'export default {}')
  await writeFile(configPath, '{}')
  const watcher = watch(projectRoot, () => {})
  let notifyChange = (_path = 'server/jobs/updated.ts') => {}
  const createWatcher: NonNullable<Parameters<typeof runQueueListen>[4]> = (_path, _options, listener) => {
    notifyChange = (path = 'server/jobs/updated.ts') => listener('change', path)
    return watcher
  }
  const children: ReturnType<typeof spawn>[] = []
  let resolveInitialWorker = (_worker: ReturnType<typeof spawn>) => {}
  const initialWorkerStarted = new Promise<ReturnType<typeof spawn>>((resolve) => { resolveInitialWorker = resolve })
  const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command) => {
    JSON.parse(readFileSync(configPath, 'utf8'))
    const child = spawn(command, ['-e', children.length === 0
      ? 'setInterval(() => {}, 1000)'
      : 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    if (children.length === 1) resolveInitialWorker(child)
    return child
  }
  let finishPreparation = () => {}
  const preparationGate = new Promise<void>((resolve) => { finishPreparation = resolve })
  let resolvePreparationStarted = () => {}
  const preparationStarted = new Promise<void>((resolve) => { resolvePreparationStarted = resolve })
  let preparations = 0
  const prepare = async () => {
    preparations += 1
    if (preparations === 2) {
      await setImmediate()
      notifyChange()
    }
    if (preparations === 3) {
      writeFileSync(configPath, '')
      resolvePreparationStarted()
      await preparationGate
      await writeFile(configPath, '{}')
    }
    if (preparations > 1) notifyChange('.holo-js/generated/nuxt-init.ts')
  }
  const listening = runQueueListen({
    cwd: projectRoot,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }, projectRoot, {}, spawnWorker, createWatcher, prepare).then(() => undefined, (error: unknown) => error)
  try {
    const initialWorker = await initialWorkerStarted
    const stopped = once(initialWorker, 'close')
    notifyChange()
    await stopped
    await preparationStarted
    await setImmediate()
    finishPreparation()
    await expect(listening).resolves.toBeUndefined()
  } finally {
    finishPreparation()
    watcher.close()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'close')
        child.kill('SIGKILL')
        await stopped
      }
    }
    await listening
    await rm(projectRoot, { recursive: true, force: true })
  }
})

function createFakeWatcher(): ReturnType<typeof watch> {
  return { close() {} } as unknown as ReturnType<typeof watch>
}

async function createQueueListenProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-queue-listen-lifetime-'))
  await mkdir(join(projectRoot, 'config'))
  await writeFile(join(projectRoot, 'config/app.mjs'), 'export default {}')
  await writeFile(join(projectRoot, 'config/database.mjs'), 'export default {}')
  return projectRoot
}

it('forwards termination to the worker and returns only after the worker closes', async () => {
  const projectRoot = await createQueueListenProject()
  let worker: ReturnType<typeof spawn> | undefined
  try {
    const markerPath = join(projectRoot, 'worker-stopped')
    const workerScript = `process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'stopped'); process.exit(0) }, 200)); process.stdout.write('ready'); setInterval(() => {}, 1000)`
    let resolveWorker = (_worker: ReturnType<typeof spawn>) => {}
    const workerStarted = new Promise<ReturnType<typeof spawn>>(resolve => { resolveWorker = resolve })
    const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command) => {
      const child = spawn(command, ['-e', workerScript], { stdio: ['pipe', 'pipe', 'pipe'] })
      resolveWorker(child)
      return child
    }
    const listening = runQueueListen({
      cwd: projectRoot,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    }, projectRoot, {}, spawnWorker, createFakeWatcher, async () => {})

    worker = await workerStarted
    if (!worker.stdout) throw new Error('worker did not start')
    let workerClosed = false
    worker.on('close', () => { workerClosed = true })
    await once(worker.stdout, 'data')
    process.emit('SIGTERM')

    await expect(listening).resolves.toBeUndefined()
    expect(workerClosed).toBe(true)
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('stopped')
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it('reports a worker error during restart as a stopping failure instead of launching a replacement', async () => {
  const projectRoot = await createQueueListenProject()
  try {
    let notifyChange = (_path = 'server/jobs/updated.ts') => {}
    const createWatcher: NonNullable<Parameters<typeof runQueueListen>[4]> = (_path, _options, listener) => {
      notifyChange = (path = 'server/jobs/updated.ts') => listener('change', path)
      return createFakeWatcher()
    }
    let resolveFirstWorker = () => {}
    const firstWorkerStarted = new Promise<void>(resolve => { resolveFirstWorker = resolve })
    const spawned: number[] = []
    const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command) => {
      spawned.push(spawned.length)
      if (spawned.length > 1) return spawn(command, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] })
      const worker = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill(signal: NodeJS.Signals): boolean }
      worker.stdout = new EventEmitter()
      worker.stderr = new EventEmitter()
      worker.kill = (signal) => {
        process.nextTick(() => {
          worker.emit('error', new Error('worker control channel closed'))
          worker.emit('close', null, signal)
        })
        return true
      }
      resolveFirstWorker()
      return worker as unknown as ReturnType<typeof spawn>
    }
    const listening = runQueueListen({
      cwd: projectRoot,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    }, projectRoot, {}, spawnWorker, createWatcher, async () => {}).then(() => undefined, (error: unknown) => error)

    await firstWorkerStarted
    notifyChange()

    const outcome = await listening
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('Queue worker failed while stopping for a restart: worker control channel closed')
    expect(spawned).toHaveLength(1)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it('starts the replacement worker only after the previous worker closes', async () => {
  const projectRoot = await createQueueListenProject()
  try {
    let notifyChange = (_path = 'server/jobs/updated.ts') => {}
    const createWatcher: NonNullable<Parameters<typeof runQueueListen>[4]> = (_path, _options, listener) => {
      notifyChange = (path = 'server/jobs/updated.ts') => listener('change', path)
      return createFakeWatcher()
    }
    const workers: ReturnType<typeof spawn>[] = []
    const replacementStartedAfterClose: boolean[] = []
    let resolveFirstWorker = () => {}
    const firstWorkerStarted = new Promise<void>(resolve => { resolveFirstWorker = resolve })
    const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command) => {
      const [previous] = workers
      if (previous) {
        replacementStartedAfterClose.push(previous.exitCode !== null || previous.signalCode !== null)
        return spawn(command, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] })
      }
      const worker = spawn(command, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
      workers.push(worker)
      resolveFirstWorker()
      return worker
    }
    const listening = runQueueListen({
      cwd: projectRoot,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    }, projectRoot, {}, spawnWorker, createWatcher, async () => {})

    await firstWorkerStarted
    const [firstWorker] = workers
    if (!firstWorker?.stdout) throw new Error('first worker did not start')
    await once(firstWorker.stdout, 'data')
    notifyChange()

    await expect(listening).resolves.toBeUndefined()
    expect(replacementStartedAfterClose).toEqual([true])
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it('launches the replacement worker with the environment a preparation wrote while the launch was waiting', async () => {
  const projectRoot = await createQueueListenProject()
  let firstWorker: ReturnType<typeof spawn> | undefined
  try {
    await writeFile(join(projectRoot, '.env'), 'HOLO_QUEUE_LISTEN_LIFETIME=old\n')
    let notifyChange = (_path = 'server/jobs/updated.ts') => {}
    const createWatcher: NonNullable<Parameters<typeof runQueueListen>[4]> = (_path, _options, listener) => {
      notifyChange = (path = 'server/jobs/updated.ts') => listener('change', path)
      return createFakeWatcher()
    }
    let preparations = 0
    const prepare = async () => {
      preparations += 1
      if (preparations === 3) await writeFile(join(projectRoot, '.env'), 'HOLO_QUEUE_LISTEN_LIFETIME=new\n')
    }
    const spawnedEnvironments: (string | undefined)[] = []
    let resolveFirstWorkerReady = () => {}
    const firstWorkerReady = new Promise<void>(resolve => { resolveFirstWorkerReady = resolve })
    const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command, _args, options) => {
      spawnedEnvironments.push(options.env?.HOLO_QUEUE_LISTEN_LIFETIME)
      if (spawnedEnvironments.length > 1) return spawn(command, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] })

      const worker = spawn(command, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
      firstWorker = worker
      worker.stdout?.once('data', () => resolveFirstWorkerReady())
      worker.once('close', () => globalThis.setImmediate(() => notifyChange('server/jobs/overlap.ts')))
      return worker
    }

    const listening = runQueueListen({
      cwd: projectRoot,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    }, projectRoot, {}, spawnWorker, createWatcher, prepare)

    await firstWorkerReady
    notifyChange()

    await expect(listening).resolves.toBeUndefined()
    expect(spawnedEnvironments).toEqual(['old', 'new'])
  } finally {
    if (firstWorker && firstWorker.exitCode === null && firstWorker.signalCode === null) firstWorker.kill('SIGKILL')
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it('does not relaunch a worker that exits cleanly after a restart signal written while its launch was waiting', async () => {
  const projectRoot = await createQueueListenProject()
  const launchStart = 1_000_000
  let firstWorker: ReturnType<typeof spawn> | undefined
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(launchStart)
  try {
    let notifyChange = (_path = 'server/jobs/updated.ts') => {}
    const createWatcher: NonNullable<Parameters<typeof runQueueListen>[4]> = (_path, _options, listener) => {
      notifyChange = (path = 'server/jobs/updated.ts') => listener('change', path)
      return createFakeWatcher()
    }
    let resolveFirstWorkerReady = () => {}
    const firstWorkerReady = new Promise<void>(resolve => { resolveFirstWorkerReady = resolve })
    const spawnedCount: number[] = []
    const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command) => {
      spawnedCount.push(spawnedCount.length)
      if (spawnedCount.length > 1) return spawn(command, ['-e', 'setTimeout(() => process.exit(0), 300)'], { stdio: ['pipe', 'pipe', 'pipe'] })

      const worker = spawn(command, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
      firstWorker = worker
      worker.stdout?.once('data', () => resolveFirstWorkerReady())
      worker.once('close', () => {
        vi.setSystemTime(launchStart + 10)
        globalThis.setImmediate(() => {
          vi.setSystemTime(launchStart + 20)
          void writeQueueRestartSignal(projectRoot)
        })
      })
      return worker
    }

    const listening = runQueueListen({
      cwd: projectRoot,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    }, projectRoot, {}, spawnWorker, createWatcher, async () => {})

    await firstWorkerReady
    notifyChange()

    await expect(listening).resolves.toBeUndefined()
    expect(spawnedCount).toHaveLength(2)
  } finally {
    vi.useRealTimers()
    if (firstWorker && firstWorker.exitCode === null && firstWorker.signalCode === null) firstWorker.kill('SIGKILL')
    await rm(projectRoot, { recursive: true, force: true })
  }
})
