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

it('keeps replacement data and renewal options precisely typed', () => {
  expectTypeOf<RotateSessionOptions['data']>().toEqualTypeOf<SessionRecord['data'] | undefined>()
  expectTypeOf<RotateSessionOptions['renewLifetime']>().toEqualTypeOf<boolean | undefined>()
})
