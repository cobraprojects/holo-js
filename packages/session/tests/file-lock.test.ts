import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { createFileSessionStore, fileSessionDriverInternals, type SessionRecord } from '../src'

let packageBuildRoot: string | undefined
const windowsFsLoader = new URL('./support/windows-fs-loader/register.mjs', import.meta.url)
const windowsFsWorkerEnv = process.env.HOLO_SESSION_WINDOWS_FS === '1'
  ? { ...process.env, NODE_OPTIONS: `--import ${windowsFsLoader.href}`, WINDOWS_FS_FRESH_MS: '1000', WINDOWS_FS_FAIL_RATE: '0.1' }
  : process.env

async function createSession() {
  const root = await mkdtemp(join(tmpdir(), 'holo-file-lock-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const driver = createFileSessionStore(root)
  const { flash, take } = driver
  if (!flash || !take) throw new Error('File sessions must support atomic flash and take')
  const store = { ...driver, flash, take }
  const now = new Date()
  const record: SessionRecord = { id: randomUUID(), store: 'file', data: { userId: 42 }, createdAt: now, lastActivityAt: now, expiresAt: new Date(Date.now() + 60_000) }
  await store.write(record)
  const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
  return { root, store, record, lockPath }
}

async function startWorker(mode: 'hold' | 'flash', root: string, sessionId: string, parameter: string): Promise<ChildProcess> {
  if (!packageBuildRoot) throw new Error('Expected the current session package build')
  const child = fork(new URL('./support/file-session-worker.mjs', import.meta.url), [mode, root, sessionId, parameter, join(packageBuildRoot, 'index.mjs')], { execArgv: [], env: windowsFsWorkerEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.on('data', (value: Buffer) => { stderr += value.toString() })
  onTestFinished(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`File session worker exited (${code}): ${stderr}`)))
    child.once('message', message => {
      if (typeof message === 'object' && message !== null && 'event' in message && message.event === 'ready') resolve()
      else reject(new Error('Expected worker readiness'))
    })
  })
  return child
}

async function stopWorker(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

async function writeStaleOwner(lockPath: string, owner: { host: string; pid: number; token: string; processToken?: string }): Promise<void> {
  await mkdir(lockPath)
  await writeFile(join(lockPath, `owner.${owner.token}.json`), JSON.stringify(owner))
  const stale = new Date(Date.now() - 20_000)
  await utimes(join(lockPath, `owner.${owner.token}.json`), stale, stale)
}

async function markLeaseReleasedWithoutRemoval(lockPath: string): Promise<void> {
  const ownerFileName = (await readdir(lockPath)).find(name => name.startsWith('owner.') && name.endsWith('.json'))
  if (!ownerFileName) throw new Error('Expected a live owner lease')
  const leasePath = join(lockPath, ownerFileName)
  const owner = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>
  await writeFile(leasePath, JSON.stringify({ ...owner, released: true }))
}

describe('file session locking with real processes', () => {
  beforeAll(async () => {
    packageBuildRoot = await mkdtemp(resolve(import.meta.dirname, '../.tmp-file-session-build-'))
    execFileSync('bun', ['run', 'build'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, HOLO_BUILD_OUT_DIR: packageBuildRoot }, stdio: 'pipe' })
  }, 60_000)
  afterAll(async () => {
    if (packageBuildRoot) await rm(packageBuildRoot, { force: true, recursive: true })
  })

  it('preserves a live owner lease even when its directory timestamp is old', async () => {
    const { root, store, record, lockPath } = await createSession()
    const owner = await startWorker('hold', root, record.id, lockPath)
    let completed = false
    const flash = store.flash(record.id, 'notice', 'Saved').then(() => { completed = true })
    await setTimeout(100)
    expect(completed).toBe(false)
    const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()))
    owner.send('release')
    await exited
    await flash
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it('reclaims a lock after its actual owner process terminates', async () => {
    const { root, store, record, lockPath } = await createSession()
    const owner = await startWorker('hold', root, record.id, lockPath)
    await stopWorker(owner)
    await store.flash(record.id, 'notice', 'Saved')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it('reclaims a lease its live owner released without being able to remove it', async () => {
    const { root, store, record, lockPath } = await createSession()
    const owner = await startWorker('hold', root, record.id, lockPath)
    await markLeaseReleasedWithoutRemoval(lockPath)
    await store.flash(record.id, 'notice', 'Saved')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
    await stopWorker(owner)
  }, 15_000)

  it('takes over a lease its live owner publishes as released while another writer is already waiting', async () => {
    const { root, store, record, lockPath } = await createSession()
    const owner = await startWorker('hold', root, record.id, lockPath)
    const flashed = store.flash(record.id, 'notice', 'Saved')
    await setTimeout(200)
    await markLeaseReleasedWithoutRemoval(lockPath)
    await flashed
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
    await stopWorker(owner)
  }, 15_000)

  it('times out on a live native lock and writes successfully after release', async () => {
    const { root, store, record, lockPath } = await createSession()
    const owner = await startWorker('hold', root, record.id, lockPath)
    await expect(store.flash(record.id, 'notice', 'Blocked')).rejects.toThrow('Timed out acquiring file session lock')
    const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()))
    owner.send('release')
    await exited
    await store.flash(record.id, 'notice', 'Saved')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  }, 15_000)

  it.each(['reused-pid', 'previous-host'])('reclaims stale persisted leases from %s', async scenario => {
    const { store, record, lockPath } = await createSession()
    await writeStaleOwner(lockPath, { host: scenario === 'previous-host' ? 'previous-host' : hostname(), pid: process.pid, token: randomUUID(), processToken: 'previous-process-instance' })
    await store.flash(record.id, 'notice', 'Saved')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it.each([false, true])('preserves every concurrent writer while replacing an orphaned lease=%s', async orphaned => {
    const { root, store, record, lockPath } = await createSession()
    await store.flash(record.id, 'existing', 'preserved')
    if (orphaned) {
      const owner = await startWorker('hold', root, record.id, lockPath)
      await stopWorker(owner)
    }
    const workers = await Promise.all(Array.from({ length: 8 }, (_, index) => startWorker('flash', root, record.id, `writer${index}`)))
    const results = workers.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`File session writer exited (${code})`)))
      child.on('message', message => {
        if (typeof message === 'object' && message !== null && 'event' in message && message.event === 'failed') reject(new Error(JSON.stringify(message)))
      })
    }))
    workers.forEach(child => child.send('start'))
    await Promise.all(results)
    expect(await store.read(record.id)).toEqual(record)
    expect(await store.take(record.id, 'existing')).toEqual({ found: true, value: 'preserved' })
    for (let writer = 0; writer < workers.length; writer += 1) {
      for (let index = 0; index < 5; index += 1) {
        const key = `writer${writer}.${index}`
        expect(await store.take(record.id, key)).toEqual({ found: true, value: { writer: `writer${writer}`, index } })
        expect(await store.take(record.id, key)).toEqual({ found: false })
      }
    }
  }, 30_000)
})
