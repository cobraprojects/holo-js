import { check, provider, refreshUser, useAuth, user } from './client-runtime'

export { authClientInternals, check, configureAuthClient, provider, refreshUser, resetAuthClient, useAuth, user } from './client-runtime'
export type { AuthClientConfig, AuthClientRequestOptions, AuthUser, AuthUserLike, CurrentAuthResponse, HoloAuthTypeRegistry, HoloAuthUser } from './contracts'

const auth = Object.freeze({
  check,
  provider,
  useAuth,
  user,
  refreshUser,
})

export default auth
