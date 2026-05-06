import holoAuth, { user as currentUser } from '@holo-js/auth'
import type { AuthUserLike, HoloAuthUser } from '@holo-js/auth'

export type AuthState = {
  readonly authenticated: boolean
  readonly user: HoloAuthUser | null
}

export type AuthOptions = {
  readonly guard?: string
}

function toClientAuthUser(user: (HoloAuthUser & AuthUserLike) | null): HoloAuthUser | null {
  // AuthUserLike custom fields crossing SvelteKit load boundaries must stay JSON-safe.
  return user ? JSON.parse(JSON.stringify(user)) as HoloAuthUser : null
}

export async function auth(options: AuthOptions = {}): Promise<AuthState> {
  let user: HoloAuthUser | null
  try {
    user = options.guard
      ? await holoAuth.guard(options.guard).user()
      : await currentUser()
  } catch (error) {
    console.warn('Failed to resolve SvelteKit auth state.', error)
    return {
      authenticated: false,
      user: null,
    }
  }

  const clientUser = toClientAuthUser(user)

  return {
    authenticated: clientUser !== null,
    user: clientUser,
  }
}
