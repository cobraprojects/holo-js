import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, normalizeSessionConfig, resetSessionRuntime, type SessionStore } from '../src'
import { createNativeSessionStore } from './support/native-store'

afterEach(() => resetSessionRuntime())

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe.each(['database', 'file', 'redis'] as const)('%s session touch concurrency', (driver) => {
  it.each(['reset', 'remove', 'delete', 'rotate'] as const)('preserves a concurrent %s while refreshing idle lifetime', async (operation) => {
    const store = await createNativeSessionStore(driver)
    const reached = deferred()
    const resume = deferred()
    let paused = false
    const pause = async (): Promise<void> => {
      if (paused) return
      paused = true
      reached.resolve()
      await resume.promise
    }
    const delayed: SessionStore = {
      ...store,
      async read(id) {
        const record = await store.read(id)
        await pause()
        return record
      },
      async touch(id, options) {
        if (!store.touch) throw new Error('Expected atomic lifetime refresh')
        await pause()
        return store.touch(id, options)
      },
    }
    configureSessionRuntime({
      config: { ...normalizeSessionConfig(), driver },
      stores: { [driver]: delayed },
    })
    const session = getSessionRuntime()
    const original = await session.create({ data: { dashboardFilters: { search: 'draft' }, userId: 42 } })
    const touching = session.touch(original.id)
    await reached.promise
    const replacementId = randomUUID()
    try {
      if (operation === 'reset') await store.write({ ...original, data: { ...original.data, dashboardFilters: { search: '' } } })
      if (operation === 'remove') await store.write({ ...original, data: { userId: 42 } })
      if (operation === 'delete') await store.delete(original.id)
      if (operation === 'rotate') await store.rotate?.(original.id, { ...original, id: replacementId, data: { userId: 43 } })
    } finally {
      resume.resolve()
    }
    const touched = await touching
    const saved = await store.read(original.id)
    if (operation === 'delete' || operation === 'rotate') {
      expect(saved).toBeNull()
      expect(touched).toBeNull()
      if (operation === 'rotate') await expect(store.read(replacementId)).resolves.toMatchObject({ data: { userId: 43 } })
    } else {
      const data = operation === 'reset' ? { dashboardFilters: { search: '' }, userId: 42 } : { userId: 42 }
      expect(saved?.data).toEqual(data)
      expect(touched?.data).toEqual(data)
    }
  })

  it('refreshes only lifetime, preserves flash, and caps expiry without moving activity backwards', async () => {
    const store = await createNativeSessionStore(driver)
    if (!store.touch || !store.flash || !store.take) throw new Error('Expected native atomic session operations')
    const now = new Date()
    const createdAt = new Date(now.getTime() - 25 * 60_000)
    const record = {
      id: randomUUID(), store: driver, data: { userId: 42 }, createdAt,
      lastActivityAt: now, expiresAt: new Date(now.getTime() + 60_000),
    }
    await store.write(record)
    await store.flash(record.id, 'notice', ['saved'])
    const options = { now: new Date(now.getTime() + 1000), idleTimeout: 15, absoluteLifetime: 30 }
    const touched = await store.touch(record.id, options)
    expect(touched).toEqual({ ...record, lastActivityAt: options.now, expiresAt: new Date(createdAt.getTime() + 30 * 60_000) })
    await expect(store.touch(record.id, { ...options, now })).resolves.toEqual(touched)
    await expect(store.take(record.id, 'notice')).resolves.toEqual({ found: true, value: ['saved'] })
    await expect(store.read(record.id)).resolves.toEqual(touched)
  })

  it('never extends an expired session or touches a different configured store', async () => {
    const store = await createNativeSessionStore(driver)
    const now = new Date()
    const expired = {
      id: randomUUID(), store: driver, data: { userId: 42 }, createdAt: now,
      lastActivityAt: now, expiresAt: new Date(now.getTime() - 1000),
    }
    await store.write(expired)
    configureSessionRuntime({
      config: { ...normalizeSessionConfig(), driver: 'other' },
      stores: {
        [driver]: store,
        other: { ...store, async touch() { throw new Error('Wrong store selected') } },
      },
    })
    await expect(getSessionRuntime().touch(expired.id, { store: driver })).resolves.toBeNull()
    const saved = await store.read(expired.id)
    if (saved) expect(saved.expiresAt).toEqual(expired.expiresAt)
  })


  it('accepts concurrent authenticated lifetime refreshes without losing session data', async () => {
    const store = await createNativeSessionStore(driver)
    if (!store.touch) throw new Error('Expected native atomic lifetime refresh')
    const now = new Date()
    const record = {
      id: randomUUID(), store: driver, data: { dashboardFilters: { search: '' }, userId: 42 },
      createdAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60_000),
    }
    await store.write(record)
    const touch = store.touch.bind(store)
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => touch(record.id, {
      now: new Date(now.getTime() + index * 1000), idleTimeout: 15, absoluteLifetime: 30,
    })))
    for (const result of results) expect(result?.data).toEqual(record.data)
    await expect(store.read(record.id)).resolves.toEqual({
      ...record,
      lastActivityAt: new Date(now.getTime() + 23_000),
      expiresAt: new Date(now.getTime() + 23_000 + 15 * 60_000),
    })
  })

})
