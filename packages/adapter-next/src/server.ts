import holoAuth, { user as currentUser } from '@holo-js/auth'
import type { HoloAuthUser } from '@holo-js/auth'

export type AuthState = {
  readonly authenticated: boolean
  readonly user: HoloAuthUser | null
}

export type AuthOptions = {
  readonly guard?: string
}

function toClientAuthUser(user: HoloAuthUser | null): HoloAuthUser | null {
  return user ? { ...user } : null
}

export async function auth(options: AuthOptions = {}): Promise<AuthState> {
  const user = options.guard
    ? await holoAuth.guard(options.guard).user()
    : await currentUser()
  const clientUser = toClientAuthUser(user)

  return {
    authenticated: clientUser !== null,
    user: clientUser,
  }
}
