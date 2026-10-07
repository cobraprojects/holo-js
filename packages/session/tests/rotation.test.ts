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
  await session.issueRememberMeToken(original.id)
  await session.flash(original.id, 'notice', 'welcome')
  const rotated = await session.rotate(original.id, { data: { cart: 'book', identity: 'ava' }, renewLifetime: true })
  expect(rotated.createdAt.getTime()).toBeGreaterThan(aged.getTime())
  expect(rotated.expiresAt.getTime() - rotated.createdAt.getTime()).toBe(1_800_000)
  expect(rotated.rememberTokenHash).toBeUndefined()
  await expect(session.read(original.id)).resolves.toBeNull()
  await expect(session.read(rotated.id)).resolves.toMatchObject({ data: { cart: 'book', identity: 'ava' } })
  await expect(session.take(rotated.id, 'notice')).resolves.toBe('welcome')
  await session.issueRememberMeToken(rotated.id)
  const remembered = await session.read(rotated.id)
  const ordinary = await session.rotate(rotated.id)
  expect(ordinary.rememberTokenHash).toBe(remembered?.rememberTokenHash)
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

it('keeps replacement data and renewal options precisely typed', () => {
  expectTypeOf<RotateSessionOptions['data']>().toEqualTypeOf<SessionRecord['data'] | undefined>()
  expectTypeOf<RotateSessionOptions['renewLifetime']>().toEqualTypeOf<boolean | undefined>()
})
