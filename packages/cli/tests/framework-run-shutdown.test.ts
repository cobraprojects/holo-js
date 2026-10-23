import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { createFrameworkSession } from '../src/framework-run'

type WorkerPids = { readonly child: number, readonly grandchild: number }

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-framework-shutdown-'))
  tempDirs.push(root)
  return root
}

function createIo(projectRoot: string) {
  return { cwd: projectRoot, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
}

function workerScript(pidPath: string, options: { readonly ignoreSigint: boolean }): string {
  const grandchildSource = [
    options.ignoreSigint ? `process.on('SIGINT', () => {})` : '',
    `process.stdout.write('ready')`,
    `setInterval(() => {}, 1000)`,
  ].filter(Boolean).join('; ')
  return [
    `const { spawn } = require('node:child_process')`,
    `const { writeFileSync } = require('node:fs')`,
    options.ignoreSigint ? `process.on('SIGINT', () => {})` : '',
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    `grandchild.stdout.once('data', () => writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid })))`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
}

async function readPids(pidPath: string): Promise<WorkerPids> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(pidPath, 'utf8'))
    } catch {
      await delay(20)
    }
  }
  throw new Error('worker did not start')
}

function isAlive(pid: number): boolean {
  const state = readProcessState(pid)
  return state !== undefined && state !== 'Z'
}

function readProcessState(pid: number): string | undefined {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (result.error) throw result.error
  const state = result.stdout.trim().charAt(0)
  if (result.status === 0 && state) return state
  if (result.status === 1 && !state && !result.stderr.trim()) return undefined
  throw new Error(`ps failed for pid ${pid} (status ${result.status}): ${result.stderr.trim()}`)
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (!isAlive(pid)) return
    await delay(20)
  }
  throw new Error(`process ${pid} is still running`)
}

it.skipIf(process.platform === 'win32')('force-stops the run on a second SIGINT with a non-zero exit and kills its process group', async () => {
  const projectRoot = await createProjectRoot()
  const pidPath = join(projectRoot, 'pids.json')
  const exits: number[] = []
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, code => exits.push(code))
  let pids: WorkerPids | undefined
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript(pidPath, { ignoreSigint: true })] }, [])
    pids = await readPids(pidPath)

    process.emit('SIGINT')
    await delay(200)
    expect(exits).toEqual([])
    expect(isAlive(pids.child)).toBe(true)
    expect(isAlive(pids.grandchild)).toBe(true)

    process.emit('SIGINT')
    expect(exits).toEqual([130])
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await waitUntilGone(pids.grandchild)
  } finally {
    session.dispose()
    if (pids) killProcess(pids.grandchild)
  }
})

it.skipIf(process.platform === 'win32')('delivers the first SIGINT to the whole process group, not only the direct child', async () => {
  const projectRoot = await createProjectRoot()
  const pidPath = join(projectRoot, 'pids.json')
  const exits: number[] = []
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, code => exits.push(code))
  let pids: WorkerPids | undefined
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript(pidPath, { ignoreSigint: false })] }, [])
    pids = await readPids(pidPath)

    process.emit('SIGINT')
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await waitUntilGone(pids.grandchild)
    expect(exits).toEqual([])
  } finally {
    session.dispose()
    if (pids) killProcess(pids.grandchild)
  }
})

it.skipIf(process.platform === 'win32')('stops the run when the terminal hangs up', async () => {
  const projectRoot = await createProjectRoot()
  const pidPath = join(projectRoot, 'pids.json')
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, () => {})
  let pids: WorkerPids | undefined
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript(pidPath, { ignoreSigint: false })] }, [])
    pids = await readPids(pidPath)

    process.emit('SIGHUP')
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await waitUntilGone(pids.grandchild)
  } finally {
    session.dispose()
    if (pids) killProcess(pids.grandchild)
  }
})

it.skipIf(process.platform === 'win32')('restarts by signalling only the direct child, which forwards the signal once', async () => {
  const projectRoot = await createProjectRoot()
  const countPath = join(projectRoot, 'count.txt')
  const readyPath = join(projectRoot, 'ready.txt')
  const innerScript = [
    `const { writeFileSync } = require('node:fs')`,
    `let count = 0`,
    `process.on('SIGTERM', () => { count += 1; writeFileSync(${JSON.stringify(countPath)}, String(count)); setTimeout(() => process.exit(0), 300) })`,
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
  const runnerScript = [
    `const { spawn } = require('node:child_process')`,
    `const inner = spawn(process.execPath, ['-e', ${JSON.stringify(innerScript)}], { stdio: 'ignore' })`,
    `let forwarded = false`,
    `process.on('SIGTERM', () => { if (!forwarded) { forwarded = true; inner.kill('SIGTERM') } })`,
    `inner.on('exit', code => process.exit(code ?? 0))`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
  const exits: number[] = []
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, code => exits.push(code))
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', runnerScript] }, [])
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await readFile(readyPath, 'utf8').then(() => true, () => false)) break
      await delay(20)
    }

    run.restart()
    await expect(run.completion).resolves.toMatchObject({ kind: 'close', restartRequested: true })
    await expect(readFile(countPath, 'utf8')).resolves.toBe('1')
    expect(exits).toEqual([])
  } finally {
    session.dispose()
  }
})

it.skipIf(process.platform === 'win32')('turns a terminal hang-up into a graceful SIGTERM the worker can handle', async () => {
  const projectRoot = await createProjectRoot()
  const markerPath = join(projectRoot, 'stopped.txt')
  const readyPath = join(projectRoot, 'ready.txt')
  const workerScript = [
    `const { writeFileSync } = require('node:fs')`,
    `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(markerPath)}, 'graceful'); process.exit(0) })`,
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, () => {})
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript] }, [])
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await readFile(readyPath, 'utf8').then(() => true, () => false)) break
      await delay(20)
    }

    process.emit('SIGHUP')
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('graceful')
  } finally {
    session.dispose()
  }
})

it.skipIf(process.platform === 'win32')('a graceful SIGTERM reaches only the direct child, so its subprocesses finish their work', async () => {
  const projectRoot = await createProjectRoot()
  const markerPath = join(projectRoot, 'finished.txt')
  const readyPath = join(projectRoot, 'ready.txt')
  const jobScript = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'finished'); process.exit(0) }, 400)`
  const workerScript = [
    `const { spawn } = require('node:child_process')`,
    `const { writeFileSync } = require('node:fs')`,
    `spawn(process.execPath, ['-e', ${JSON.stringify(jobScript)}], { stdio: 'ignore' })`,
    `process.on('SIGTERM', () => process.exit(0))`,
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, () => {})
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript] }, [])
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await readFile(readyPath, 'utf8').then(() => true, () => false)) break
      await delay(20)
    }

    process.emit('SIGTERM')
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await readFile(markerPath, 'utf8').then(() => true, () => false)) break
      await delay(20)
    }
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('finished')
  } finally {
    session.dispose()
  }
})
