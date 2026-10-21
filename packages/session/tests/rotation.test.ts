import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, expectTypeOf, it } from 'vitest'
import { configureSessionRuntime, createFileSessionStore, getSessionRuntime, resetSessionRuntime, type RotateSessionOptions, type SessionRecord } from '../src'

const directories: string[] = []
afterEach(async () => {
  resetSessionRuntime()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('persists the complete replacement payload, renews lifetime and preserves private flash during rotation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-rotation-'))
  directories.push(directory)
  configureSessionRuntime({ config: { driver: 'file', stores: { file: { name: 'file', driver: 'file', path: directory } }, cookie: { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, maxAge: 120 }, idleTimeout: 30, absoluteLifetime: 120, rememberMeLifetime: 1440 }, stores: { file: createFileSessionStore(directory) } })
  const session = getSessionRuntime()
  const original = await session.create({ data: { cart: 'book' } })
  const aged = new Date(Date.now() - 60_000)
  await session.write({ ...original, createdAt: aged, lastActivityAt: aged })
  await session.flash(original.id, 'notice', 'welcome')
  const rotated = await session.rotate(original.id, { data: { cart: 'book', identity: 'ava' }, renewLifetime: true })
  expect(rotated.createdAt.getTime()).toBeGreaterThan(aged.getTime())
  expect(rotated.expiresAt.getTime() - rotated.createdAt.getTime()).toBe(1_800_000)
  await expect(session.read(original.id)).resolves.toBeNull()
  await expect(session.read(rotated.id)).resolves.toMatchObject({ data: { cart: 'book', identity: 'ava' } })
  await expect(session.take(rotated.id, 'notice')).resolves.toBe('welcome')
  const ordinary = await session.rotate(rotated.id)
  expect(ordinary.createdAt).toEqual(rotated.createdAt)
  expect(ordinary.expiresAt).toEqual(rotated.expiresAt)
})

it('rejects complete auth rotation on unsupported stores without changing the existing session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-rotation-'))
  directories.push(directory)
  const file = createFileSessionStore(directory)
  const { rotate: _rotate, flash: _flash, take: _take, ...unsupported } = file
  configureSessionRuntime({
    config: { driver: 'file', stores: { file: { name: 'file', driver: 'file', path: directory } }, cookie: { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, maxAge: 120 }, idleTimeout: 30, absoluteLifetime: 120, rememberMeLifetime: 1440 },
    stores: { file: unsupported },
  })
  const session = getSessionRuntime()
  const original = await session.create({ data: { identity: 'original' } })
  await expect(session.rotate(original.id, { newId: 'replacement', data: { identity: 'next' }, renewLifetime: true })).rejects.toThrow('state-preserving auth rotation')
  await expect(session.read(original.id)).resolves.toEqual(original)
  await expect(session.read('replacement')).resolves.toBeNull()
})

it('refuses a replacement id that already holds a session on a store without atomic rotation, leaving both sessions intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-rotation-'))
  directories.push(directory)
  const file = createFileSessionStore(directory)
  const { rotate: _rotate, flash: _flash, take: _take, ...unsupported } = file
  configureSessionRuntime({
    config: { driver: 'file', stores: { file: { name: 'file', driver: 'file', path: directory } }, cookie: { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, maxAge: 120 }, idleTimeout: 30, absoluteLifetime: 120, rememberMeLifetime: 1440 },
    stores: { file: unsupported },
  })
  const session = getSessionRuntime()
  const original = await session.create({ data: { identity: 'original' } })
  const existing = await session.create({ data: { identity: 'existing' } })
  await expect(session.rotate(original.id, { newId: existing.id })).rejects.toThrow('already exists')
  await expect(session.read(original.id)).resolves.toEqual(original)
  await expect(session.read(existing.id)).resolves.toEqual(existing)
})

it('mints a fresh id when rotation is not given one, so the new id is not reachable before rotation resolves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-rotation-'))
  directories.push(directory)
  configureSessionRuntime({ config: { driver: 'file', stores: { file: { name: 'file', driver: 'file', path: directory } }, cookie: { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, maxAge: 120 }, idleTimeout: 30, absoluteLifetime: 120, rememberMeLifetime: 1440 }, stores: { file: createFileSessionStore(directory) } })
  const session = getSessionRuntime()
  const original = await session.create({ data: { identity: 'original' } })
  const rotated = await session.rotate(original.id)
  expect(rotated.id).not.toBe(original.id)
  await expect(session.read(original.id)).resolves.toBeNull()
  await expect(session.read(rotated.id)).resolves.toMatchObject({ data: { identity: 'original' } })
})

function withoutPrivateFlash(store: ReturnType<typeof createFileSessionStore>) {
  const { rotate: _rotate, flash: _flash, take: _take, ...plain } = store
  return plain
}

it('lets exactly one of several concurrent rotations claim a replacement id on another store', async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'session-rotation-source-'))
  const targetDirectory = await mkdtemp(join(tmpdir(), 'session-rotation-target-'))
  directories.push(sourceDirectory, targetDirectory)
  const cookie = { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax' as const, partitioned: false, maxAge: 120 }
  configureSessionRuntime({
    config: {
      driver: 'source',
      stores: {
        source: { name: 'source', driver: 'file', path: sourceDirectory },
        target: { name: 'target', driver: 'file', path: targetDirectory },
      },
      cookie,
      idleTimeout: 30,
      absoluteLifetime: 120,
      rememberMeLifetime: 1440,
    },
    stores: { source: withoutPrivateFlash(createFileSessionStore(sourceDirectory)), target: createFileSessionStore(targetDirectory) },
  })
  const session = getSessionRuntime()
  const sources = await Promise.all(Array.from({ length: 4 }, (_, index) => session.create({ store: 'source', data: { index } })))
  const results = await Promise.allSettled(sources.map(source => session.rotate(source.id, { store: 'target', newId: 'shared-replacement' })))
  const fulfilled = results.filter(result => result.status === 'fulfilled')
  const rejected = results.filter(result => result.status === 'rejected')
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(3)
  for (const result of rejected) {
    expect(String(result.reason)).toContain('already exists')
  }
  const survivors = await Promise.all(sources.map(source => session.read(source.id, { store: 'source' })))
  expect(survivors.filter(Boolean)).toHaveLength(3)
  await expect(session.read('shared-replacement', { store: 'target' })).resolves.toMatchObject({ id: 'shared-replacement' })
})

it('lets a rotation take a replacement id held only by an expired file session', async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'session-rotation-source-'))
  const targetDirectory = await mkdtemp(join(tmpdir(), 'session-rotation-target-'))
  directories.push(sourceDirectory, targetDirectory)
  const cookie = { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax' as const, partitioned: false, maxAge: 120 }
  configureSessionRuntime({
    config: {
      driver: 'source',
      stores: {
        source: { name: 'source', driver: 'file', path: sourceDirectory },
        target: { name: 'target', driver: 'file', path: targetDirectory },
      },
      cookie,
      idleTimeout: 30,
      absoluteLifetime: 120,
      rememberMeLifetime: 1440,
    },
    stores: { source: withoutPrivateFlash(createFileSessionStore(sourceDirectory)), target: createFileSessionStore(targetDirectory) },
  })
  const session = getSessionRuntime()
  const replacementId = 'expired-replacement'
  const target = createFileSessionStore(targetDirectory)
  const now = new Date()
  await target.write({ id: replacementId, store: 'target', data: { stale: true }, createdAt: now, lastActivityAt: now, expiresAt: new Date(Date.now() - 1_000) })
  const source = await session.create({ store: 'source', data: { userId: 7 } })

  await expect(session.rotate(source.id, { store: 'target', newId: replacementId })).resolves.toMatchObject({ id: replacementId })

  await expect(session.read(replacementId, { store: 'target' })).resolves.toMatchObject({ id: replacementId, data: { userId: 7 } })
})

it('keeps replacement data and renewal options precisely typed', () => {
  expectTypeOf<RotateSessionOptions['data']>().toEqualTypeOf<SessionRecord['data'] | undefined>()
  expectTypeOf<RotateSessionOptions['renewLifetime']>().toEqualTypeOf<boolean | undefined>()
})
