import { getContext, setContext } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import { authClientInternals } from '../client'
import type { AuthClientRequestOptions, HoloAuthUser } from '../contracts'

export type { HoloAuthUser } from '../contracts'

export type UseAuthOptions = AuthClientRequestOptions & {
  readonly initialProvider?: string | null
  readonly initialUser?: HoloAuthUser | null
}

export type UseAuthResult = {
  readonly authenticated: boolean
  readonly provider: string | null
  readonly user: HoloAuthUser | null
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

const authContextKey = Symbol('holo-js.auth.client')

function hasExplicitUseAuthOptions(options: UseAuthOptions | undefined): options is UseAuthOptions {
  return typeof options !== 'undefined'
    && Object.values(options).some(value => typeof value !== 'undefined')
}

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
  #provider: string | null
  #user: HoloAuthUser | null

  readonly #subscribe = createSubscriber((update) => {
    this.#notify = update

    return () => {
      this.#notify = () => {}
    }
  })

  constructor(
    initialProvider: string | null,
    initialUser: HoloAuthUser | null,
    private requestOptions: AuthClientRequestOptions,
  ) {
    this.#provider = initialProvider
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

  get provider(): string | null {
    this.#subscribe()
    return this.#provider
  }

  async refreshUser(): Promise<HoloAuthUser | null> {
    if (this.#pendingRefresh) {
      return this.#pendingRefresh
    }

    const refresh = authClientInternals.fetchCurrentUser(this.requestOptions, {
      force: true,
    })
      .then((currentAuth) => {
        this.#provider = currentAuth.provider
        this.#user = currentAuth.user
        this.#notify()

        return currentAuth.user
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
  const hasOptions = hasExplicitUseAuthOptions(options)
  const resolvedOptions = options ?? {}
  const { initialProvider = null, initialUser = null, ...requestOptions } = resolvedOptions
  if (context && !hasOptions) {
    if (context instanceof AuthClientState) {
      context.setRequestOptions(requestOptions)
    }

    return context
  }

  const auth = new AuthClientState(initialProvider, initialUser, requestOptions)

  trySetAuthContext(auth)
  return auth
}
