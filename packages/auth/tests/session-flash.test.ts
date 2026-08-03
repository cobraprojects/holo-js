import { afterEach, describe, expect, it, vi } from 'vitest'
import auth, {
  authRuntimeInternals,
  configureAuthRuntime,
  defineAuthConfig,
  flash,
  resetAuthRuntime,
  take,
  type AuthProviderAdapter,
  type AuthRuntimeContext,
} from '../src'
import type { AuthSessionRecord } from '../src/contracts'

type TestUser = {
  readonly email: string
  readonly id: number
}

const users: AuthProviderAdapter<TestUser> = {
  async create(input) {
    return { email: String(input.email), id: 1 }
  },
  async findByCredentials() {
    return null
  },
  async findById() {
    return null
  },
  getId(user) {
    return user.id
  },
  serialize(user) {
    return user
  },
}

function record(sessionId: string, guard: 'admin' | 'web'): AuthSessionRecord {
  const now = new Date()
  return {
    createdAt: now,
    data: {
      auth: {
        authenticatedAt: now.toISOString(),
        guard,
        provider: 'users',
        user: { email: `${guard}@app.test`, id: guard === 'web' ? 1 : 2 },
        userId: guard === 'web' ? 1 : 2,
      },
    },
    expiresAt: new Date(now.getTime() + 60_000),
    id: sessionId,
    lastActivityAt: now,
    store: 'database',
  }
}

function configure(context: AuthRuntimeContext = authRuntimeInternals.createMemoryAuthContext(), atomic = true) {
  const records = new Map([
    ['session-web', record('session-web', 'web')],
    ['session-admin', record('session-admin', 'admin')],
  ])
  const flashed = new Map<string, unknown>()
  const flashAtomic = vi.fn(async (sessionId: string, key: string, value: unknown) => {
    flashed.set(`${sessionId}:${key}`, value)
  })
  const takeAtomic = vi.fn()
  const takeValue = async <TValue = unknown>(sessionId: string, key: string): Promise<TValue | undefined> => {
    takeAtomic(sessionId, key)
    const storageKey = `${sessionId}:${key}`
    if (!flashed.has(storageKey)) return undefined
    const value = flashed.get(storageKey)
    flashed.delete(storageKey)
    return value as TValue
  }
  const touch = vi.fn(async (sessionId: string) => records.get(sessionId) ?? null)

  configureAuthRuntime({
    config: defineAuthConfig({
      defaults: { guard: 'web' },
      guards: {
        admin: { driver: 'session', provider: 'users' },
        api: { driver: 'token', provider: 'users' },
        web: { driver: 'session', provider: 'users' },
      },
      providers: { users: { model: 'User' } },
    }),
    context,
    providers: { users },
    session: {
      async create() {
        throw new Error('not used')
      },
      ...(atomic ? { flash: flashAtomic, take: takeValue } : {}),
      async invalidate() {},
      async issueRememberMeToken() {
        return 'remember-token'
      },
      async read(sessionId) {
        return records.get(sessionId) ?? null
      },
      rememberMeCookie(value) {
        return `holo_remember=${value}`
      },
      sessionCookie(value) {
        return `holo_session=${value}`
      },
      touch,
    },
  })

  return { flashAtomic, takeAtomic, touch }
}

afterEach(() => {
  resetAuthRuntime()
  vi.restoreAllMocks()
})

describe('request-scoped auth session flash values', () => {
  it('delegates named, default, and guard facades to atomic runtime methods without exposing session IDs', async () => {
    const context = authRuntimeInternals.createMemoryAuthContext()
    context.setSessionId('web', 'session-web')
    context.setSessionId('admin', 'session-admin')
    const runtime = configure(context)

    await flash('notice', { saved: true })
    await auth.guard('admin').flash('notice', 'admin-only')
    await expect(take<{ saved: boolean }>('notice')).resolves.toEqual({ saved: true })
    await expect(auth.guard('admin').take<string>('notice')).resolves.toBe('admin-only')
    await expect(take('notice')).resolves.toBeUndefined()

    expect(runtime.flashAtomic).toHaveBeenNthCalledWith(1, 'session-web', 'notice', { saved: true })
    expect(runtime.flashAtomic).toHaveBeenNthCalledWith(2, 'session-admin', 'notice', 'admin-only')
    expect(runtime.takeAtomic).toHaveBeenNthCalledWith(1, 'session-web', 'notice')
    expect(runtime.takeAtomic).toHaveBeenNthCalledWith(2, 'session-admin', 'notice')
    expect(Object.keys(auth)).not.toContain('sessionId')
  })

  it('hydrates the guard-scoped request session and rejects a session belonging to another guard', async () => {
    const base = authRuntimeInternals.createMemoryAuthContext()
    const context: AuthRuntimeContext = {
      ...base,
      getRequestCookie: () => 'session-web',
    }
    const runtime = configure(context)

    await auth.flash('request.notice', true)
    expect(runtime.flashAtomic).toHaveBeenCalledWith('session-web', 'request.notice', true)

    base.setSessionId('admin', 'session-web')
    await auth.guard('admin').flash('request.notice', 'cross-guard')
    expect(runtime.flashAtomic).toHaveBeenCalledTimes(1)
    expect(base.getSessionId('admin')).toBeUndefined()
  })

  it('fails closed for absent sessions and does not expose session methods on token guards', async () => {
    const runtime = configure()

    await expect(auth.flash('notice', true)).resolves.toBeUndefined()
    await expect(auth.take('notice')).resolves.toBeUndefined()
    expect(runtime.touch).not.toHaveBeenCalled()
    expect(runtime.flashAtomic).not.toHaveBeenCalled()
    expect(runtime.takeAtomic).not.toHaveBeenCalled()
    expect('flash' in auth.guard('api')).toBe(false)
    expect('take' in auth.guard('api')).toBe(false)
  })

  it('rejects authenticated use when the runtime lacks atomic capabilities', async () => {
    const context = authRuntimeInternals.createMemoryAuthContext()
    context.setSessionId('web', 'session-web')
    configure(context, false)

    await expect(auth.flash('notice', true)).rejects.toThrow('does not support atomic flash operations')
    await expect(auth.take('notice')).rejects.toThrow('does not support atomic flash operations')
  })
})
