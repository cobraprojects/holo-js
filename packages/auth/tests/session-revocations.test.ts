import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthProviderAdapter, type AuthSessionRevocationStore, type AuthTokenStore, type PersonalAccessTokenRecord } from '../src'
import { configureSessionRuntime, createFileSessionStore, getSessionRuntime, normalizeSessionConfig, resetSessionRuntime } from '../../session/src'

const user = { id: 1, email: 'user@app.test' }
const provider: AuthProviderAdapter<typeof user> = {
  async create() { return user },
  async findByCredentials() { return user },
  async findById(id) { return { ...user, id: Number(id) } },
  getId(value) { return value.id },
  serialize(value) { return value },
}
let directory: string
let database: DatabaseSync
let reads: number
const context = createAsyncAuthContext()
let store: AuthSessionRevocationStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'auth-revocations-'))
  database = new DatabaseSync(join(directory, 'revocations.sqlite'))
  database.exec('CREATE TABLE revocations (provider TEXT, user_id TEXT, generation INTEGER NOT NULL, retained_session_id TEXT, PRIMARY KEY (provider, user_id))')
  reads = 0
  store = {
    async readMany(identities) {
      reads++
      if (!identities.length) return []
      const rows = database.prepare(`SELECT * FROM revocations WHERE ${identities.map(() => '(provider = ? AND user_id = ?)').join(' OR ')}`).all(...identities.flatMap(identity => [identity.provider, String(identity.userId)]))
      return identities.map(identity => {
        const row = rows.find(value => value.provider === identity.provider && value.user_id === String(identity.userId))
        return { ...identity, generation: Number(row?.generation ?? 0), ...(typeof row?.retained_session_id === 'string' ? { retainedSessionId: row.retained_session_id } : {}) }
      })
    },
    async revokeOthers(identity, currentSession) {
      const result = database.prepare('INSERT INTO revocations VALUES (?, ?, 1, ?) ON CONFLICT(provider, user_id) DO UPDATE SET generation = generation + 1, retained_session_id = excluded.retained_session_id WHERE generation = ? OR retained_session_id = excluded.retained_session_id').run(identity.provider, String(identity.userId), currentSession.id, currentSession.generation)
      return result.changes === 1
    },
  }
  configureSessionRuntime({ config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: directory } } }), stores: { file: createFileSessionStore(directory) } })
  configureAuthRuntime({
    config: { defaults: { guard: 'web' }, guards: { web: { driver: 'session', provider: 'users' }, admin: { driver: 'session', provider: 'users' }, other: { driver: 'session', provider: 'otherUsers' }, api: { driver: 'token', provider: 'users' } }, providers: { users: { model: 'User' }, otherUsers: { model: 'OtherUser' } } },
    providers: { users: provider, otherUsers: provider }, context, session: getSessionRuntime(), sessionRevocations: store,
  })
})

afterEach(async () => {
  resetAuthRuntime()
  resetSessionRuntime()
  database.close()
  await rm(directory, { recursive: true, force: true })
})

it('retains the current logical browser and rejects another browser on its next request', async () => {
  const first = await context.run(() => auth.loginUsingId(1))
  const second = await context.run(() => auth.loginUsingId(1))
  await context.run(async () => {
    context.setSessionId('web', second.sessionId)
    await auth.logoutOtherDevices()
    expect(await auth.check()).toBe(true)
  })
  await context.run(async () => {
    context.setSessionId('web', first.sessionId)
    expect(await auth.check()).toBe(false)
  })
})

it('batches shared identities once per native request and preserves provider isolation across rotation', async () => {
  const survivor = await context.run(() => auth.loginUsingId(1))
  const other = await context.run(async () => {
    await auth.loginUsingId(1)
    await auth.guard('admin').loginUsingId(1)
    const otherGuard = auth.guard('other')
    if (!('loginUsingId' in otherGuard)) throw new Error('Expected a session guard')
    return otherGuard.loginUsingId(1)
  })
  const before = reads
  await context.run(async () => {
    for (const name of ['web', 'admin', 'other']) context.setSessionId(name, other.sessionId)
    expect(await auth.check()).toBe(true)
    expect(await auth.guard('admin').check()).toBe(true)
    expect(await auth.guard('other').check()).toBe(true)
  })
  expect(reads - before).toBe(1)
  const rotated = await context.run(async () => {
    context.setSessionId('web', survivor.sessionId)
    await auth.logoutOtherDevices()
    return auth.loginUsingId(1)
  })
  await context.run(async () => {
    context.setSessionId('web', rotated.sessionId)
    expect(await auth.check()).toBe(true)
  })
  await context.run(async () => {
    for (const name of ['web', 'admin', 'other']) context.setSessionId(name, other.sessionId)
    expect(await auth.guard('admin').check()).toBe(false)
    expect(await auth.check()).toBe(false)
    expect(await auth.guard('other').check()).toBe(true)
  })
  const newLogin = await context.run(() => auth.loginUsingId(1))
  await context.run(async () => {
    context.setSessionId('web', newLogin.sessionId)
    expect(await auth.check()).toBe(true)
  })
})

it('does not let a previously authenticated losing browser become the retained browser', async () => {
  const first = await context.run(() => auth.loginUsingId(1))
  const second = await context.run(() => auth.loginUsingId(1))
  let ready: () => void = () => {}
  let release: () => void = () => {}
  const isReady = new Promise<void>(resolve => { ready = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const loser = context.run(async () => {
    context.setSessionId('web', first.sessionId)
    expect(await auth.check()).toBe(true)
    ready()
    await released
    await expect(auth.logoutOtherDevices()).rejects.toMatchObject({ code: 'auth_user_missing' })
    expect(await auth.check()).toBe(false)
  })
  await isReady
  await context.run(async () => {
    context.setSessionId('web', second.sessionId)
    await auth.logoutOtherDevices()
  })
  release()
  await loser
  await context.run(async () => {
    context.setSessionId('web', second.sessionId)
    expect(await auth.check()).toBe(true)
  })
})

it('rejects legacy browser payloads with enabled persistence and keeps ordinary auth without persistence', async () => {
  expect(auth.guard('api')).not.toHaveProperty('logoutOtherDevices')
  const legacy = await getSessionRuntime().create({ data: { auth: { guard: 'web', provider: 'users', userId: 1, user, authenticatedAt: new Date().toISOString() } } })
  await context.run(async () => {
    context.setSessionId('web', legacy.id)
    expect(await auth.check()).toBe(false)
  })
  configureAuthRuntime({ config: { providers: { users: { model: 'User' } } }, providers: { users: provider }, context, session: getSessionRuntime() })
  await context.run(async () => {
    await auth.loginUsingId(1)
    expect(await auth.check()).toBe(true)
    await expect(auth.logoutOtherDevices()).rejects.toMatchObject({ code: 'runtime_unconfigured' })
  })
})


it('checks remember restoration before trusting it and preserves later legitimate login', async () => {
  const remembered = await context.run(() => auth.loginUsingId(1, { remember: true }))
  const current = await context.run(() => auth.loginUsingId(1))
  await context.run(async () => {
    context.setSessionId('web', current.sessionId)
    await auth.logoutOtherDevices()
  })
  const rememberedContext = {
    ...authRuntimeInternals.createMemoryAuthContext(),
    getRequestCookie: (name: string) => name === 'holo_session_remember' ? remembered.rememberToken : undefined,
  }
  configureAuthRuntime({ ...authRuntimeInternals.getRuntimeBindings(), context: rememberedContext })
  expect(await auth.check()).toBe(false)
  expect(rememberedContext.getCachedUser('web')).toBeNull()
  await auth.loginUsingId(1)
  expect(await auth.check()).toBe(true)
})

it('does not reuse a custom context read after a revocation in another request', async () => {
  const first = await context.run(() => auth.loginUsingId(1))
  const second = await context.run(() => auth.loginUsingId(1))
  const bindings = authRuntimeInternals.getRuntimeBindings()
  const custom = { ...authRuntimeInternals.createMemoryAuthContext() }
  custom.setSessionId('web', first.sessionId)
  configureAuthRuntime({ ...bindings, context: custom })
  expect(await auth.check()).toBe(true)
  configureAuthRuntime(bindings)
  await context.run(async () => {
    context.setSessionId('web', second.sessionId)
    await auth.logoutOtherDevices()
  })
  configureAuthRuntime({ ...bindings, context: custom })
  expect(await auth.check()).toBe(false)
})

it('retains aliases across physical rotation and named-guard revocation', async () => {
  const initial = await context.run(() => auth.loginUsingId(1))
  const rotated = await context.run(async () => {
    context.setSessionId('web', initial.sessionId)
    await auth.logoutOtherDevices()
    return auth.guard('admin').loginUsingId(1)
  })
  await context.run(async () => {
    context.setSessionId('web', rotated.sessionId)
    context.setSessionId('admin', rotated.sessionId)
    await auth.guard('admin').logoutOtherDevices()
    expect(await auth.check()).toBe(true)
    expect(await auth.guard('admin').check()).toBe(true)
  })
})

it('propagates durable adapter failures without claiming revocation succeeded', async () => {
  const failure = new Error('durable database unavailable')
  const session = await context.run(() => auth.loginUsingId(1))
  configureAuthRuntime({ ...authRuntimeInternals.getRuntimeBindings(), sessionRevocations: { ...store, async revokeOthers() { throw failure } } })
  await context.run(async () => {
    context.setSessionId('web', session.sessionId)
    await expect(auth.logoutOtherDevices()).rejects.toBe(failure)
  })
})

it('restores a valid remembered identity and rejects remembered payloads without revocation metadata', async () => {
  const remembered = await context.run(() => auth.loginUsingId(1, { remember: true }))
  const bindings = authRuntimeInternals.getRuntimeBindings()
  const validRemember = {
    ...authRuntimeInternals.createMemoryAuthContext(),
    getRequestCookie: (name: string) => name === 'holo_session_remember' ? remembered.rememberToken : undefined,
  }
  configureAuthRuntime({ ...bindings, context: validRemember })
  expect(await auth.check()).toBe(true)
  const legacy = await getSessionRuntime().create({ data: { auth: { guard: 'web', provider: 'users', userId: 1, user, authenticatedAt: new Date().toISOString() } } })
  const legacyToken = await getSessionRuntime().issueRememberMeToken(legacy.id)
  const legacyRemember = {
    ...authRuntimeInternals.createMemoryAuthContext(),
    getRequestCookie: (name: string) => name === 'holo_session_remember' ? legacyToken : undefined,
  }
  configureAuthRuntime({ ...bindings, context: legacyRemember })
  expect(await auth.check()).toBe(false)
  expect(legacyRemember.getCachedUser('web')).toBeNull()
})

it('preserves durable revocation after the adapter connection is reopened', async () => {
  const other = await context.run(() => auth.loginUsingId(1))
  await context.run(async () => {
    await auth.loginUsingId(1)
    await auth.logoutOtherDevices()
  })
  database.close()
  database = new DatabaseSync(join(directory, 'revocations.sqlite'))
  await context.run(async () => {
    context.setSessionId('web', other.sessionId)
    expect(await auth.check()).toBe(false)
  })
})


it('preserves personal access token authentication when browser authentication is revoked', async () => {
  database.exec('CREATE TABLE tokens (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
  function readToken(value: string): PersonalAccessTokenRecord {
    const record = JSON.parse(value) as Omit<PersonalAccessTokenRecord, 'createdAt' | 'lastUsedAt' | 'expiresAt'> & { createdAt: string, lastUsedAt?: string, expiresAt?: string | null }
    const { createdAt, lastUsedAt, expiresAt, ...attributes } = record
    return { ...attributes, createdAt: new Date(createdAt), ...(lastUsedAt ? { lastUsedAt: new Date(lastUsedAt) } : {}), expiresAt: expiresAt ? new Date(expiresAt) : null }
  }
  async function writeToken(record: PersonalAccessTokenRecord): Promise<void> {
    database.prepare('INSERT INTO tokens VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record').run(record.id, JSON.stringify(record))
  }
  const tokens: AuthTokenStore = {
    create: writeToken,
    update: writeToken,
    async findById(id) {
      const row = database.prepare('SELECT record FROM tokens WHERE id = ?').get(id)
      return typeof row?.record === 'string' ? readToken(row.record) : null
    },
    async listByUserId(providerName, userId) {
      return database.prepare("SELECT record FROM tokens WHERE json_extract(record, '$.provider') = ? AND CAST(json_extract(record, '$.userId') AS TEXT) = ?").all(providerName, String(userId)).flatMap(row => typeof row.record === 'string' ? [readToken(row.record)] : [])
    },
    async delete(id) { database.prepare('DELETE FROM tokens WHERE id = ?').run(id) },
    async deleteByUserId(providerName, userId) {
      return Number(database.prepare("DELETE FROM tokens WHERE json_extract(record, '$.provider') = ? AND CAST(json_extract(record, '$.userId') AS TEXT) = ?").run(providerName, String(userId)).changes)
    },
  }
  configureAuthRuntime({ ...authRuntimeInternals.getRuntimeBindings(), tokens })
  const token = await auth.tokens.create(user, { name: 'Mobile', guard: 'api' })
  await context.run(async () => {
    await auth.loginUsingId(1)
    await auth.logoutOtherDevices()
  })
  await context.run(async () => {
    context.setAccessToken?.('api', token.plainTextToken)
    expect(await auth.guard('api').check()).toBe(true)
  })
})

it('reuses native request reads through framework contexts that preserve the async auth accessors', async () => {
  const wrapped = { ...context, getRequestCookie: () => undefined }
  configureAuthRuntime({ ...authRuntimeInternals.getRuntimeBindings(), context: wrapped })
  const session = await context.run(async () => {
    await auth.loginUsingId(1)
    return auth.guard('admin').loginUsingId(1)
  })
  const before = reads
  await context.run(async () => {
    context.setSessionId('web', session.sessionId)
    context.setSessionId('admin', session.sessionId)
    expect(await auth.check()).toBe(true)
    expect(await auth.guard('admin').check()).toBe(true)
  })
  expect(reads - before).toBe(1)
  await context.run(async () => {
    context.setSessionId('web', session.sessionId)
    expect(await auth.check()).toBe(true)
  })
  expect(reads - before).toBe(2)
})

it('restores a valid impersonation original with its browser revocation identity', async () => {
  const session = await context.run(async () => {
    await auth.loginUsingId(1)
    return auth.impersonateById(2)
  })
  await context.run(async () => {
    context.setSessionId('web', session.sessionId)
    expect(await auth.stopImpersonating()).toMatchObject({ id: 1 })
    expect(await auth.check()).toBe(true)
  })
})

it('does not restore an impersonation original revoked by another browser', async () => {
  const impersonated = await context.run(async () => {
    await auth.loginUsingId(1)
    return auth.impersonateById(2)
  })
  await context.run(async () => {
    await auth.loginUsingId(1)
    await auth.logoutOtherDevices()
  })
  await context.run(async () => {
    context.setSessionId('web', impersonated.sessionId)
    expect(await auth.check()).toBe(true)
    expect(await auth.stopImpersonating()).toBeNull()
    expect(await auth.check()).toBe(false)
  })
})

it('preserves guards explicitly bound to another session when cleaning a revoked shared identity', async () => {
  const shared = await context.run(async () => {
    await auth.loginUsingId(1)
    return auth.guard('admin').loginUsingId(1)
  })
  const separate = await context.run(() => auth.guard('admin').loginUsingId(2))
  await context.run(async () => {
    await auth.loginUsingId(1)
    await auth.logoutOtherDevices()
  })
  await context.run(async () => {
    context.setSessionId('web', shared.sessionId)
    context.setSessionId('admin', separate.sessionId)
    expect(await auth.check()).toBe(false)
    expect(await auth.guard('admin').id()).toBe(2)
  })
})
