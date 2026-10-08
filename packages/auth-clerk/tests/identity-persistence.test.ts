import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthHostedIdentityRecord, AuthHostedIdentityStore } from '../../auth/src/config'
import type { AuthProviderAdapter } from '../../auth/src/contracts'
import { configureAuthRuntime, defineAuthConfig, resetAuthRuntime } from '../../auth/src'
import { getSessionRuntime } from '../../session/src'
import { clerkAuthInternals, configureClerkAuthRuntime, resetClerkAuthRuntime, syncIdentity } from '../src'
import { configureWorkosAuthRuntime, resetWorkosAuthRuntime, syncIdentity as syncWorkosIdentity } from '../../auth-workos/src'

const databases: DatabaseSync[] = []

function createPersistence() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT, avatar TEXT, password TEXT, email_verified_at TEXT);
    CREATE TABLE identities (provider TEXT, provider_user_id TEXT, user_id INTEGER, record TEXT,
      PRIMARY KEY (provider, provider_user_id));
  `)
  const adapter: AuthProviderAdapter<Record<string, unknown>> = {
    async findById(id) {
      return database.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null
    },
    async findByCredentials(input) {
      return database.prepare('SELECT * FROM users WHERE email = ?').get(String(input.email)) ?? null
    },
    async create(input) {
      const result = database.prepare('INSERT INTO users (email, name, avatar, password) VALUES (?, ?, ?, ?)').run(String(input.email), String(input.name), null, null)
      return { id: Number(result.lastInsertRowid), email: input.email, name: input.name, avatar: null, password: null, email_verified_at: null }
    },
    async delete(id) {
      database.prepare('DELETE FROM users WHERE id = ?').run(id)
    },
    getId(user) {
      return Number(user.id)
    },
    serialize(user) {
      return user
    },
  }
  const identityStore: AuthHostedIdentityStore = {
    async findByProviderUserId(provider, providerUserId) {
      const row = database.prepare('SELECT record FROM identities WHERE provider = ? AND provider_user_id = ?').get(provider, providerUserId)
      if (!row) {
        return null
      }
      const record = JSON.parse(String(row.record)) as AuthHostedIdentityRecord
      return { ...record, linkedAt: new Date(record.linkedAt), updatedAt: new Date(record.updatedAt) }
    },
    async findByUserId(provider, authProvider, userId) {
      const row = database.prepare('SELECT provider_user_id FROM identities WHERE provider = ? AND user_id = ?').get(provider, userId)
      return row ? await this.findByProviderUserId(provider, String(row.provider_user_id)) : null
    },
    async save(record) {
      database.prepare('INSERT OR REPLACE INTO identities VALUES (?, ?, ?, ?)').run(record.provider, record.providerUserId, record.userId, JSON.stringify(record))
    },
    async claim(record) {
      database.prepare('INSERT OR IGNORE INTO identities VALUES (?, ?, ?, ?)').run(record.provider, record.providerUserId, record.userId, JSON.stringify(record))
      const winner = await this.findByProviderUserId(record.provider, record.providerUserId)
      if (!winner) {
        throw new Error('Identity claim did not persist')
      }
      return winner
    },
  }
  const createIdentity = (userId: string | number): AuthHostedIdentityRecord => ({
    provider: 'hosted', providerUserId: 'remote-user', guard: 'web', authProvider: 'users', userId,
    emailVerified: false, profile: {}, linkedAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  })
  configureAuthRuntime({
    config: defineAuthConfig({
      defaults: { guard: 'web', passwords: 'users' },
      guards: { web: { driver: 'session', provider: 'users' } },
      providers: { users: { model: 'User' } },
      clerk: { hosted: { publishableKey: 'pk_test' } },
      workos: { hosted: { clientId: 'client' } },
    }),
    session: getSessionRuntime(),
    providers: { users: adapter },
  })
  const configureStore = (store: AuthHostedIdentityStore) => {
    configureClerkAuthRuntime({ providers: {}, identityStore: store })
    configureWorkosAuthRuntime({ providers: {}, identityStore: store })
  }
  configureStore(identityStore)
  const profile = { id: 'remote-user', email: 'new@app.test', emailVerified: false, name: 'User' }
  const synchronize = () => syncIdentity({ sessionId: 'session', user: clerkAuthInternals.normalizeClerkUserProfile(profile) }, 'hosted')
  const synchronizeWorkos = () => syncWorkosIdentity({ sessionId: 'session', identity: { ...profile, metadata: {}, raw: {} } }, 'hosted')
  const installCompetingClaim = () => {
    database.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(99, 'winner@app.test', 'User')
    database.exec(`
      CREATE TRIGGER competing_claim AFTER INSERT ON users BEGIN
        INSERT OR IGNORE INTO identities VALUES ('hosted', 'remote-user', 99, '${JSON.stringify(createIdentity(99))}');
      END;
    `)
  }
  return { database, identityStore, configureStore, synchronize, synchronizeWorkos, installCompetingClaim }
}

afterEach(() => {
  resetClerkAuthRuntime()
  resetWorkosAuthRuntime()
  resetAuthRuntime()
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('hosted identity synchronization persistence', () => {
  it('returns the winning claim and removes the losing local user', async () => {
    const { database, identityStore, synchronize, installCompetingClaim } = createPersistence()
    installCompetingClaim()

    const result = await synchronize()

    expect(result).toMatchObject({ status: 'linked', user: { id: 99 }, identity: { userId: 99 } })
    expect(database.prepare('SELECT id FROM users').all()).toEqual([{ id: 99 }])
    expect(await identityStore.findByProviderUserId('hosted', 'remote-user')).toMatchObject({ userId: 99 })
  })

  it('serializes concurrent first synchronizations when the store only supports save', async () => {
    const { database, identityStore: claimedStore, configureStore, synchronize } = createPersistence()
    const { claim: _claim, ...identityStore } = claimedStore
    configureStore(identityStore)
    const [first, second] = await Promise.all([
      synchronize(),
      synchronize(),
    ])

    expect(first.status).toBe('created')
    expect(second.status).toBe('linked')
    expect(first.user.id).toBe(second.user.id)
    expect(database.prepare('SELECT id FROM users').all()).toHaveLength(1)
    expect(await identityStore.findByProviderUserId('hosted', 'remote-user')).toMatchObject({ userId: first.user.id })
  })

  it('preserves direct-save ownership even when a competing identity has been claimed', async () => {
    const { database, identityStore, synchronizeWorkos, installCompetingClaim } = createPersistence()
    installCompetingClaim()

    const result = await synchronizeWorkos()

    expect(result).toMatchObject({ status: 'created', user: { id: 100 }, identity: { userId: 100 } })
    expect(database.prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{ id: 99 }, { id: 100 }])
    expect(await identityStore.findByProviderUserId('hosted', 'remote-user')).toMatchObject({ userId: 100 })
  })

  it('reports losing-user cleanup failure and releases synchronization for a retry', async () => {
    const { database, identityStore, synchronize, installCompetingClaim } = createPersistence()
    installCompetingClaim()
    database.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END;")

    await expect(synchronize()).rejects.toThrow('cleanup failed')
    expect(await identityStore.findByProviderUserId('hosted', 'remote-user')).toMatchObject({ userId: 99 })
    await expect(synchronize()).rejects.toThrow('collides with a different local user')
    expect(database.prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{ id: 99 }, { id: 100 }])
  })
})
