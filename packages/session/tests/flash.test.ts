import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import session, {
  configureSessionRuntime,
  createFileSessionStore,
  createSession,
  fileSessionDriverInternals,
  flashSession,
  getSessionRuntime,
  readSession,
  resetSessionRuntime,
  rotateSession,
  takeSession,
  type SessionRecord,
  type SessionStore,
} from '../src'

const tempDirectories: string[] = []

function configuration(store: SessionStore) {
  return {
    config: {
      absoluteLifetime: 120,
      cookie: {
        httpOnly: true,
        maxAge: 120,
        name: 'holo_session',
        partitioned: false,
        path: '/',
        sameSite: 'lax' as const,
        secure: false,
      },
      driver: 'file',
      idleTimeout: 30,
      rememberMeLifetime: 1_440,
      stores: { file: { driver: 'file' as const, name: 'file', path: './sessions' } },
    },
    stores: { file: store },
  }
}

function record(id: string, store = 'database'): SessionRecord {
  const createdAt = new Date()
  return {
    createdAt,
    data: { visible: true },
    expiresAt: new Date(createdAt.getTime() + 60_000),
    id,
    lastActivityAt: createdAt,
    store,
  }
}

afterEach(async () => {
  resetSessionRuntime()
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('atomic session flash values', () => {
  it('exposes named, runtime, and facade methods with one-time file-backed values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-1', store: 'file', data: { visible: true } })

    expect(session.flash).toBe(flashSession)
    expect(session.take).toBe(takeSession)
    expect(getSessionRuntime().flash).toBe(flashSession)
    expect(getSessionRuntime().take).toBe(takeSession)

    await session.flash('session-1', 'panels.admin.effects', { count: 2, ok: true })
    expect((await readSession('session-1', { store: 'file' }))?.data).toEqual({ visible: true })
    const persisted = await readFile(fileSessionDriverInternals.getRecordPath(root, 'session-1'), 'utf8')
    expect(persisted).not.toContain('panels.admin.effects')
    await expect(session.take('session-1', 'panels.admin.effects')).resolves.toEqual({ count: 2, ok: true })
    await expect(session.take('session-1', 'panels.admin.effects')).resolves.toBeUndefined()
  })

  it('preserves private flash values when rotating a file-backed session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-rotate-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-before-rotation', store: 'file' })
    await flashSession('session-before-rotation', 'notice', 'preserved')

    const rotated = await rotateSession('session-before-rotation', {
      newId: 'session-after-rotation',
    })

    expect(rotated.id).toBe('session-after-rotation')
    await expect(takeSession('session-after-rotation', 'notice')).resolves.toBe('preserved')
    await expect(takeSession('session-before-rotation', 'notice')).resolves.toBeUndefined()
  })

  it('does not replace an existing file-backed session during rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-collision-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-before-rotation', store: 'file' })
    await createSession({ name: 'session-after-rotation', store: 'file', data: { owner: 'destination' } })

    await expect(rotateSession('session-before-rotation', { newId: 'session-after-rotation' }))
      .rejects.toThrow('Session "session-after-rotation" already exists')
    await expect(store.read('session-before-rotation')).resolves.toMatchObject({ id: 'session-before-rotation' })
    await expect(store.read('session-after-rotation')).resolves.toMatchObject({
      id: 'session-after-rotation',
      data: { owner: 'destination' },
    })
  })

  it('refuses rotation through a store without private-state-preserving rotation and retains its state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-unsupported-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    const { rotate: _rotate, ...source } = store
    configureSessionRuntime(configuration(source))
    await createSession({ name: 'session-before-rotation', store: 'file', data: { owner: 'source' } })
    await flashSession('session-before-rotation', 'notice', 'preserved')

    await expect(rotateSession('session-before-rotation', { newId: 'session-after-rotation' }))
      .rejects.toThrow('does not support private-state-preserving rotation')
    await expect(store.read('session-before-rotation')).resolves.toMatchObject({ data: { owner: 'source' } })
    await expect(store.read('session-after-rotation')).resolves.toBeNull()
    await expect(takeSession('session-before-rotation', 'notice')).resolves.toBe('preserved')
  })

  it('refuses to move private flash state between independent stores and retains both sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-independent-'))
    tempDirectories.push(root)
    const source = createFileSessionStore(join(root, 'source'))
    const target = createFileSessionStore(join(root, 'target'))
    const bindings = configuration(source)
    configureSessionRuntime({
      ...bindings,
      config: { ...bindings.config, stores: { ...bindings.config.stores, target: { driver: 'file', name: 'target', path: join(root, 'target') } } },
      stores: { file: source, target },
    })
    await createSession({ name: 'session-before-move', store: 'file', data: { owner: 'source' } })
    await createSession({ name: 'session-after-move', store: 'target', data: { owner: 'target' } })
    await flashSession('session-before-move', 'notice', 'preserved')

    await expect(rotateSession('session-before-move', { newId: 'session-after-move', store: 'target' }))
      .rejects.toThrow('cannot be rotated between stores')
    await expect(source.read('session-before-move')).resolves.toMatchObject({ data: { owner: 'source' } })
    await expect(target.read('session-after-move')).resolves.toMatchObject({ data: { owner: 'target' } })
    await expect(takeSession('session-before-move', 'notice')).resolves.toBe('preserved')
  })

  it('rejects stores without atomic flash capabilities while retaining their session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-capabilities-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    const { flash: _flash, take: _take, ...source } = store
    configureSessionRuntime(configuration(source))
    await createSession({ name: 'session-1', store: 'file', data: { visible: true } })

    await expect(flashSession('session-1', 'notice', true)).rejects.toThrow('does not support atomic flash operations')
    await expect(takeSession('session-1', 'notice')).rejects.toThrow('does not support atomic flash operations')
    await expect(store.read('session-1')).resolves.toMatchObject({ data: { visible: true } })
  })

  it('rejects unsafe keys and invalid JSON values without replacing stored flash state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-invalid-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-1', store: 'file' })
    await flashSession('session-1', 'safe.key', 'preserved')
    const circular: { self?: unknown } = {}
    circular.self = circular
    const symbolKeyed = { [Symbol('hidden')]: true }
    const invalidValues: unknown[] = [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, new Date(), circular, { nested: undefined }, symbolKeyed, 'x'.repeat(65_537)]
    for (const key of ['', ' leading', '__proto__', 'constructor', 'a/b', `a${'x'.repeat(128)}`]) {
      await expect(flashSession('session-1', key, true)).rejects.toThrow('Flash keys')
    }
    for (const value of invalidValues) await expect(flashSession('session-1', 'safe.key', value)).rejects.toThrow()
    await expect(takeSession('session-1', 'safe.key')).resolves.toBe('preserved')
  })

  it('rejects non-finite values read from persisted flash data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-corrupted-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-1', store: 'file' })
    const recordPath = fileSessionDriverInternals.getRecordPath(root, 'session-1')
    await writeFile(fileSessionDriverInternals.getFlashPath(recordPath), '[["safe.key", 1e309]]', 'utf8')
    await expect(takeSession('session-1', 'safe.key')).rejects.toThrow('finite JSON numbers')
  })

  it('rejects deeply nested flash values without changing stored state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-nested-'))
    tempDirectories.push(root)
    configureSessionRuntime(configuration(createFileSessionStore(root)))
    await createSession({ name: 'session-1', store: 'file' })
    await flashSession('session-1', 'safe.key', 'preserved')
    const deeplyNested = Array.from({ length: 10_000 }).reduce<Record<string, unknown>>(value => ({ value }), {})
    await expect(flashSession('session-1', 'safe.key', deeplyNested)).rejects.toThrow('cannot exceed 32 levels')
    await expect(takeSession('session-1', 'safe.key')).resolves.toBe('preserved')
  })

  it('rejects accessors before reading or storing their values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-accessor-'))
    tempDirectories.push(root)
    configureSessionRuntime(configuration(createFileSessionStore(root)))
    await createSession({ name: 'session-1', store: 'file' })
    await flashSession('session-1', 'safe.key', 'preserved')
    let reads = 0
    const value = { get message() { reads += 1; return 'changed' } }
    await expect(flashSession('session-1', 'safe.key', value)).rejects.toThrow('accessors')
    expect(reads).toBe(0)
    await expect(takeSession('session-1', 'safe.key')).resolves.toBe('preserved')
  })

  it('removes private file flash state when the session is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-delete-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    await store.write(record('session-delete', 'file'))
    await store.flash?.('session-delete', 'notice', 'saved')
    await store.delete('session-delete')

    await expect(store.read('session-delete')).resolves.toBeNull()
    await expect(store.take?.('session-delete', 'notice')).resolves.toEqual({ found: false })
  })

  it('does not flash or take values from expired file sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-expired-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    const expired = record('session-expired', 'file')
    await store.write({ ...expired, expiresAt: new Date(Date.now() - 1) })

    await expect(store.flash?.('session-expired', 'notice', 'saved')).rejects.toThrow('was not found')
    await expect(store.take?.('session-expired', 'notice')).resolves.toEqual({ found: false })
    await expect(store.read('session-expired')).resolves.toBeNull()
  })
})
