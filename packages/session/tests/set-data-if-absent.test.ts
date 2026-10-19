import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileSessionStore, type SessionRecord, type SessionStore } from '../src'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function createRecord(id = randomUUID(), data: Record<string, unknown> = { userId: 42 }): SessionRecord {
  const now = new Date()
  return { id, store: 'file', data, createdAt: now, lastActivityAt: now, expiresAt: new Date(Date.now() + 60_000) }
}

async function createFileStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'holo-session-data-'))
  roots.push(root)
  return createFileSessionStore(root)
}

function requireSetDataIfAbsent(store: SessionStore): NonNullable<SessionStore['setDataIfAbsent']> {
  if (!store.setDataIfAbsent) throw new Error('Session stores must support atomic data writes.')
  return store.setDataIfAbsent.bind(store)
}

describe('session store setDataIfAbsent', () => {
  it('persists a missing key and keeps the rest of the stored record', async () => {
    const store = await createFileStore()
    const setDataIfAbsent = requireSetDataIfAbsent(store)
    const record = createRecord()
    await store.write(record)

    await expect(setDataIfAbsent(record.id, '_token', 'token-a')).resolves.toEqual({ found: true, value: 'token-a' })

    await expect(store.read(record.id)).resolves.toMatchObject({ id: record.id, data: { userId: 42, _token: 'token-a' } })
  })

  it('returns the value already stored instead of replacing it', async () => {
    const store = await createFileStore()
    const setDataIfAbsent = requireSetDataIfAbsent(store)
    const record = createRecord(randomUUID(), { _token: 'first' })
    await store.write(record)

    await expect(setDataIfAbsent(record.id, '_token', 'second')).resolves.toEqual({ found: true, value: 'first' })
    await expect(store.read(record.id)).resolves.toMatchObject({ data: { _token: 'first' } })
  })

  it('does not write anything when the session was rotated away after the caller read it', async () => {
    const store = await createFileStore()
    const setDataIfAbsent = requireSetDataIfAbsent(store)
    const previous = createRecord()
    await store.write(previous)
    const replacement = createRecord(randomUUID(), { userId: 42, login: 'fresh' })
    await store.rotate?.(previous.id, replacement)

    await expect(setDataIfAbsent(previous.id, '_token', 'stale-token')).resolves.toEqual({ found: false })

    await expect(store.read(previous.id)).resolves.toBeNull()
    await expect(store.read(replacement.id)).resolves.toMatchObject({ data: { userId: 42, login: 'fresh' } })
  })

  it('does not recreate a deleted session', async () => {
    const store = await createFileStore()
    const setDataIfAbsent = requireSetDataIfAbsent(store)
    const record = createRecord()
    await store.write(record)
    await store.delete(record.id)

    await expect(setDataIfAbsent(record.id, '_token', 'stale-token')).resolves.toEqual({ found: false })
    await expect(store.read(record.id)).resolves.toBeNull()
  })
})
