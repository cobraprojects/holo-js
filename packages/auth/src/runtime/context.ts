import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthenticatedAuthUser, AuthRuntimeContext } from '../contracts'

export type MemoryAuthContext = AuthRuntimeContext & {
  readonly sessionIds: Map<string, string>
  readonly cachedUsers: Map<string, AuthenticatedAuthUser | null>
  readonly accessTokens: Map<string, string>
  readonly rememberTokens: Map<string, string>
  getAccessToken(guardName: string): string | undefined
  setAccessToken(guardName: string, token?: string): void
  getRememberToken(guardName: string): string | undefined
  setRememberToken(guardName: string, token?: string): void
}

export type AsyncAuthContext = AuthRuntimeContext & {
  activate(): void
}

function setMapValue(map: Map<string, string>, key: string, value?: string): void {
  if (!value) {
    map.delete(key)
    return
  }

  map.set(key, value)
}

export function createMemoryAuthContext(): MemoryAuthContext {
  const sessionIds = new Map<string, string>()
  const cachedUsers = new Map<string, AuthenticatedAuthUser | null>()
  const accessTokens = new Map<string, string>()
  const rememberTokens = new Map<string, string>()

  return {
    sessionIds,
    cachedUsers,
    accessTokens,
    rememberTokens,
    getSessionId: guardName => sessionIds.get(guardName),
    setSessionId: (guardName, sessionId) => setMapValue(sessionIds, guardName, sessionId),
    getCachedUser: guardName => cachedUsers.get(guardName),
    setCachedUser: (guardName, user) => cachedUsers.set(guardName, user),
    getAccessToken: guardName => accessTokens.get(guardName),
    setAccessToken: (guardName, token) => setMapValue(accessTokens, guardName, token),
    getRememberToken: guardName => rememberTokens.get(guardName),
    setRememberToken: (guardName, token) => setMapValue(rememberTokens, guardName, token),
  }
}

export function createAsyncAuthContext(): AsyncAuthContext {
  const storage = new AsyncLocalStorage<MemoryAuthContext>()
  const resolveContext = (): MemoryAuthContext => {
    const existing = storage.getStore()
    if (!existing) {
      throw new Error('[@holo-js/auth] Async auth context is not active. Call activate() before reading or writing auth context state.')
    }

    return existing
  }

  return {
    activate() {
      if (!storage.getStore()) {
        storage.enterWith(createMemoryAuthContext())
      }
    },
    getSessionId: guardName => resolveContext().getSessionId(guardName),
    setSessionId: (guardName, sessionId) => resolveContext().setSessionId(guardName, sessionId),
    getCachedUser: guardName => resolveContext().getCachedUser(guardName),
    setCachedUser: (guardName, user) => resolveContext().setCachedUser(guardName, user),
    getAccessToken: guardName => resolveContext().getAccessToken(guardName),
    setAccessToken: (guardName, token) => resolveContext().setAccessToken(guardName, token),
    getRememberToken: guardName => resolveContext().getRememberToken(guardName),
    setRememberToken: (guardName, token) => resolveContext().setRememberToken(guardName, token),
  }
}
