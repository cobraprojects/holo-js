import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionRecord, SessionStore } from '@holo-js/session'
import { sessionStoreFactories } from './support/session-stores'

async function storedSession(store: SessionStore, data: Record<string, unknown>): Promise<SessionRecord> {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000)
  const record = { id: randomUUID(), store: 'test', data, createdAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60_000) }
  await store.write(record)
  return record
}

function requireUpdateData(store: SessionStore): NonNullable<SessionStore['updateData']> {
  if (!store.updateData) throw new Error('Built-in session stores must support atomic data updates.')
  return store.updateData.bind(store)
}

function withGuard(guard: string) {
  return (current: unknown) => ({ ...(current as Record<string, unknown> | undefined), [guard]: { userId: guard } })
}

describe.each(sessionStoreFactories)('updateData on the $name session store', ({ create }) => {
  it('keeps every overlapping change to one key', async () => {
    const store = await create()
    const updateData = requireUpdateData(store)
    const record = await storedSession(store, {})
    const guards = ['web', 'admin', 'support', 'api']

    await Promise.all(guards.map(guard => updateData(record.id, 'auth', withGuard(guard))))

    expect(Object.keys((await store.read(record.id))?.data.auth as Record<string, unknown>).sort()).toEqual([...guards].sort())
  })

  it('keeps a key another request stores while the update runs', async () => {
    const store = await create()
    const updateData = requireUpdateData(store)
    const record = await storedSession(store, { auth: { web: { userId: 'web' } } })

    await Promise.all([
      updateData(record.id, 'auth', () => undefined),
      store.setDataIfAbsent?.(record.id, '_token', 'csrf-token'),
    ])

    await expect(store.read(record.id)).resolves.toMatchObject({ data: { _token: 'csrf-token' } })
    expect((await store.read(record.id))?.data).not.toHaveProperty('auth')
  })

  it('returns the stored value, deletes the key on undefined, and keeps the rest of the record', async () => {
    const store = await create()
    const updateData = requireUpdateData(store)
    const record = await storedSession(store, { auth: 'signed-in', preserved: true })

    await expect(updateData(record.id, 'auth', current => `${String(current)}-again`)).resolves.toEqual({ found: true, value: 'signed-in-again' })
    await expect(updateData(record.id, 'auth', () => undefined)).resolves.toEqual({ found: true, value: undefined })

    const stored = await store.read(record.id)
    expect(stored?.data).toEqual({ preserved: true })
    expect(stored?.expiresAt).toEqual(record.expiresAt)
  })

  it('does not recreate a missing session', async () => {
    const store = await create()
    const updateData = requireUpdateData(store)
    const sessionId = randomUUID()

    await expect(updateData(sessionId, 'auth', () => 'signed-in')).resolves.toEqual({ found: false })
    await expect(store.read(sessionId)).resolves.toBeNull()
  })
})
