import { getContext, setContext } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import { refreshUser as refreshCurrentUser } from '../client'
import type { AuthClientRequestOptions, HoloAuthUser } from '../contracts'

export type { HoloAuthUser } from '../contracts'

export type UseAuthOptions = AuthClientRequestOptions & {
  readonly initialUser?: HoloAuthUser | null
}

export type UseAuthResult = {
  readonly authenticated: boolean
  readonly user: HoloAuthUser | null
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

const authContextKey = Symbol('holo-js.auth.client')

export function setAuthContext(auth: UseAuthResult): UseAuthResult {
  setContext(authContextKey, auth)
  return auth
}

export function getAuthContext(): UseAuthResult | undefined {
  return getContext<UseAuthResult | undefined>(authContextKey)
}

function tryGetAuthContext(): UseAuthResult | undefined {
  try {
    return getAuthContext()
  } catch {
    return undefined
  }
}

function trySetAuthContext(auth: UseAuthResult): void {
  try {
    setAuthContext(auth)
  } catch {
    // Outside component initialization there is no Svelte context to attach.
  }
}

class AuthClientState implements UseAuthResult {
  #notify: () => void = () => {}
  #pendingRefresh: Promise<HoloAuthUser | null> | undefined
  #user: HoloAuthUser | null

  readonly #subscribe = createSubscriber((update) => {
    this.#notify = update

    return () => {
      this.#notify = () => {}
    }
  })

  constructor(
    initialUser: HoloAuthUser | null,
    private requestOptions: AuthClientRequestOptions,
  ) {
    this.#user = initialUser
  }

  get authenticated(): boolean {
    this.#subscribe()
    return this.#user !== null
  }

  get user(): HoloAuthUser | null {
    this.#subscribe()
    return this.#user
  }

  async refreshUser(): Promise<HoloAuthUser | null> {
    if (this.#pendingRefresh) {
      return this.#pendingRefresh
    }

    const refresh = refreshCurrentUser(this.requestOptions)
      .then((user) => {
        this.#user = user
        this.#notify()

        return user
      })
      .finally(() => {
        this.#pendingRefresh = undefined
      })

    this.#pendingRefresh = refresh
    return refresh
  }

  setRequestOptions(requestOptions: AuthClientRequestOptions): void {
    this.requestOptions = requestOptions
  }
}

export function useAuth(options?: UseAuthOptions): UseAuthResult {
  const context = tryGetAuthContext()
  const resolvedOptions = options ?? {}
  const { initialUser = null, ...requestOptions } = resolvedOptions
  if (context && typeof options?.initialUser === 'undefined') {
    if (context instanceof AuthClientState) {
      context.setRequestOptions(requestOptions)
    }

    return context
  }

  const auth = new AuthClientState(initialUser, requestOptions)

  trySetAuthContext(auth)
  return auth
}
