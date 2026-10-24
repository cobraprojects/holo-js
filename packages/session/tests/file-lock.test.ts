import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFileSessionStore, type SessionRecord } from '../src'

let packageBuildRoot: string | undefined
let root: string | undefined
let owner: ChildProcess | undefined
let record: SessionRecord

function forkLockOwner(sessionRoot: string, sessionId: string, driverEntry: string): ChildProcess {
  return fork(new URL('./support/file-session-worker.mjs', import.meta.url), [sessionRoot, sessionId, driverEntry], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
}

async function waitUntilLocked(child: ChildProcess): Promise<void> {
  let stderr = ''
  child.stderr?.on('data', (value: Buffer) => { stderr += value.toString() })
  await new Promise<void>((resolveLocked, reject) => {
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`The lock owner exited (${code}) before it signalled that it holds the lock: ${stderr}`)))
    child.once('message', message => {
      if (typeof message === 'object' && message !== null && 'event' in message && message.event === 'locked') resolveLocked()
      else reject(new Error(`Expected the lock owner to signal "locked", received ${JSON.stringify(message)}`))
    })
  })
  child.removeAllListeners('exit')
}

async function stopLockOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolveExited => child.once('exit', () => resolveExited()))
  child.kill('SIGKILL')
  await exited
}

describe('file session locking with a real owner process', () => {
  beforeAll(async () => {
    packageBuildRoot = await mkdtemp(resolve(import.meta.dirname, '../.tmp-file-session-build-'))
    execFileSync('bun', ['run', 'build'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, HOLO_BUILD_OUT_DIR: packageBuildRoot }, stdio: 'pipe' })
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-'))
    const now = new Date()
    record = { id: randomUUID(), store: 'file', data: { userId: 42 }, createdAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() - 1_000) }
    await createFileSessionStore(root).write(record)
    owner = forkLockOwner(root, record.id, join(packageBuildRoot, 'index.mjs'))
    await waitUntilLocked(owner)
  }, 60_000)

  afterAll(async () => {
    if (owner) await stopLockOwner(owner)
    if (root) await rm(root, { force: true, recursive: true })
    if (packageBuildRoot) await rm(packageBuildRoot, { force: true, recursive: true })
  })

  it('keeps the lock of a live owner process with old timestamps, and reclaims it once that process exits', async () => {
    const store = createFileSessionStore(root!)
    expect({ exitCode: owner!.exitCode, signalCode: owner!.signalCode }).toEqual({ exitCode: null, signalCode: null })
    expect(await store.sweepExpired?.(new Date())).toBe(0)
    expect(await store.read(record.id)).toEqual(record)

    await stopLockOwner(owner!)
    await store.delete(record.id)
    expect(await store.read(record.id)).toBeNull()
  })
})
