import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { createFrameworkSession } from '../src/framework-run'

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
  return [
    `const { spawn } = require('node:child_process')`,
    `const { writeFileSync } = require('node:fs')`,
    options.ignoreSigint ? `process.on('SIGINT', () => {})` : '',
    `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })`,
    `writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
}

async function readPids(pidPath: string): Promise<{ readonly child: number, readonly grandchild: number }> {
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
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
  let pids: { readonly child: number, readonly grandchild: number } | undefined
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript(pidPath, { ignoreSigint: true })] }, [])
    pids = await readPids(pidPath)

    process.emit('SIGINT')
    await delay(200)
    expect(exits).toEqual([])
    expect(isAlive(pids.child)).toBe(true)

    process.emit('SIGINT')
    expect(exits).toEqual([130])
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await waitUntilGone(pids.grandchild)
  } finally {
    session.dispose()
    if (pids && isAlive(pids.grandchild)) process.kill(pids.grandchild, 'SIGKILL')
  }
})

it.skipIf(process.platform === 'win32')('delivers the first SIGINT to the whole process group, not only the direct child', async () => {
  const projectRoot = await createProjectRoot()
  const pidPath = join(projectRoot, 'pids.json')
  const exits: number[] = []
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, code => exits.push(code))
  let pids: { readonly child: number, readonly grandchild: number } | undefined
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript(pidPath, { ignoreSigint: false })] }, [])
    pids = await readPids(pidPath)

    process.emit('SIGINT')
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await waitUntilGone(pids.grandchild)
    expect(exits).toEqual([])
  } finally {
    session.dispose()
    if (pids && isAlive(pids.grandchild)) process.kill(pids.grandchild, 'SIGKILL')
  }
})

it.skipIf(process.platform === 'win32')('stops the run when the terminal hangs up', async () => {
  const projectRoot = await createProjectRoot()
  const pidPath = join(projectRoot, 'pids.json')
  const session = createFrameworkSession(createIo(projectRoot), projectRoot, spawn as never, undefined, () => {})
  let pids: { readonly child: number, readonly grandchild: number } | undefined
  try {
    const run = await session.launch({ command: process.execPath, args: ['-e', workerScript(pidPath, { ignoreSigint: false })] }, [])
    pids = await readPids(pidPath)

    process.emit('SIGHUP')
    await expect(run.completion).resolves.toMatchObject({ kind: 'close' })
    await waitUntilGone(pids.grandchild)
  } finally {
    session.dispose()
    if (pids && isAlive(pids.grandchild)) process.kill(pids.grandchild, 'SIGKILL')
  }
})
