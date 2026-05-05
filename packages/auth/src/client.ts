import { check, refreshUser, useAuth, user } from './client-runtime'

export { authClientInternals, check, configureAuthClient, refreshUser, resetAuthClient, useAuth, user } from './client-runtime'
export type { AuthClientConfig, AuthClientRequestOptions, AuthUser, AuthUserLike, CurrentAuthResponse, HoloAuthTypeRegistry } from './contracts'

const auth = Object.freeze({
  check,
  useAuth,
  user,
  refreshUser,
})

export default auth
