import { afterEach, describe, expect, it } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime, rotateSession, type SessionStore } from '@holo-js/session'
import { sessionStoreFactories } from './support/session-stores'

function configure(store: SessionStore): void {
  configureSessionRuntime({
    config: {
      driver: 'file',
      stores: { file: { driver: 'file', name: 'file', path: './sessions' } },
      cookie: { name: 'holo_session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, maxAge: 120 },
      idleTimeout: 120,
      absoluteLifetime: 120,
      rememberMeLifetime: 43200,
    },
    stores: { file: store },
  })
}

function withGuard(guard: string) {
  return (current: Readonly<Record<string, unknown>>) => ({
    ...current,
    auth: { ...(current.auth as Record<string, unknown> | undefined), [guard]: { userId: guard } },
  })
}

function holdRotation(store: SessionStore): { readonly store: SessionStore, readonly reached: Promise<void>, release(): void } {
  let reached!: () => void
  let release!: () => void
  const reachedRotation = new Promise<void>(resolve => { reached = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return {
    store: {
      ...store,
      rotate: async (previousSessionId, record, update) => {
        reached()
        await released
        return store.rotate!(previousSessionId, record, update)
      },
    },
    reached: reachedRotation,
    release,
  }
}

afterEach(() => {
  resetSessionRuntime()
})

describe.each(sessionStoreFactories)('rotating a session on the $name session store', ({ create }) => {
  it('applies the update to the data stored when the rotation runs', async () => {
    const store = await create()
    const gate = holdRotation(store)
    configure(gate.store)
    const session = getSessionRuntime()
    const created = await session.create({ data: { auth: { admin: { userId: 'admin' } } } })

    const rotation = session.rotate(created.id, { update: withGuard('web'), renewLifetime: true })
    await gate.reached
    await session.setDataIfAbsent(created.id, '_token', 'csrf-token')
    await session.updateData(created.id, 'auth', current => ({ ...(current as Record<string, unknown>), support: { userId: 'support' } }))
    gate.release()
    const rotated = await rotation

    const expected = {
      _token: 'csrf-token',
      auth: { admin: { userId: 'admin' }, support: { userId: 'support' }, web: { userId: 'web' } },
    }
    expect(rotated.id).not.toBe(created.id)
    expect(rotated.data).toEqual(expected)
    await expect(session.read(rotated.id)).resolves.toMatchObject({ data: expected })
    await expect(session.read(created.id)).resolves.toBeNull()
  })

  it('keeps data stored while a plain rotation runs', async () => {
    const store = await create()
    const gate = holdRotation(store)
    configure(gate.store)
    const session = getSessionRuntime()
    const created = await session.create({ data: { locale: 'en' } })

    const rotation = rotateSession(created.id)
    await gate.reached
    await session.setDataIfAbsent(created.id, '_token', 'csrf-token')
    gate.release()
    const rotated = await rotation

    expect(rotated.data).toEqual({ locale: 'en', _token: 'csrf-token' })
    await expect(session.read(rotated.id)).resolves.toMatchObject({ data: { locale: 'en', _token: 'csrf-token' } })
  })

  it('carries private flash state and renews the lifetime', async () => {
    configure(await create())
    const session = getSessionRuntime()
    const now = Math.floor(Date.now() / 1000) * 1000
    const created = await session.write({
      ...(await session.create()),
      createdAt: new Date(now - 60 * 60_000),
      lastActivityAt: new Date(now - 60 * 60_000),
      expiresAt: new Date(now + 10 * 60_000),
    })
    await session.flash(created.id, 'notice', 'Saved')

    const rotated = await session.rotate(created.id, { update: withGuard('web'), renewLifetime: true })

    expect(rotated.createdAt.getTime()).toBeGreaterThanOrEqual(now)
    expect(rotated.expiresAt.getTime()).toBeGreaterThanOrEqual(now + 120 * 60_000)
    await expect(session.read(rotated.id)).resolves.toMatchObject({ expiresAt: rotated.expiresAt, data: { auth: { web: { userId: 'web' } } } })
    await expect(session.take(rotated.id, 'notice')).resolves.toBe('Saved')
  })

  it('rejects a session that ends before the rotation runs without creating the new one', async () => {
    const store = await create()
    const gate = holdRotation(store)
    configure(gate.store)
    const session = getSessionRuntime()
    const created = await session.create()

    const rotation = session.rotate(created.id, { update: withGuard('web'), newId: 'rotated-session-id' })
    await gate.reached
    await session.invalidate(created.id)
    gate.release()

    await expect(rotation).rejects.toThrow(new RegExp(`session "${created.id}" was not found`, 'i'))
    await expect(session.read('rotated-session-id')).resolves.toBeNull()
  })
})

describe('rotating with an update', () => {
  it('fails on a store that cannot apply rotation updates and writes nothing', async () => {
    const [file] = sessionStoreFactories
    const { rotate: _rotate, ...withoutRotate } = await file.create()
    configure(withoutRotate)
    const session = getSessionRuntime()
    const created = await session.create({ data: { preserved: true } })

    await expect(session.rotate(created.id, { update: withGuard('web'), renewLifetime: true }))
      .rejects.toThrow('Session store "file" does not support atomic rotation updates.')

    await expect(session.read(created.id)).resolves.toMatchObject({ data: { preserved: true } })
  })

  it('rejects data and an update passed together', async () => {
    const [file] = sessionStoreFactories
    configure(await file.create())
    const session = getSessionRuntime()
    const created = await session.create({ data: { preserved: true } })

    await expect(session.rotate(created.id, { data: {}, update: withGuard('web') }))
      .rejects.toThrow('Session rotation accepts either data or an update, not both.')

    await expect(session.read(created.id)).resolves.toMatchObject({ data: { preserved: true } })
  })
})
