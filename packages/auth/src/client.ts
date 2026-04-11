import { check, refreshUser, user } from './client-runtime'

export { authClientInternals, check, configureAuthClient, refreshUser, resetAuthClient, user } from './client-runtime'
export type { AuthClientConfig, AuthClientRequestOptions, AuthUser, AuthUserLike, CurrentAuthResponse, HoloAuthTypeRegistry } from './contracts'

const auth = Object.freeze({
  check,
  user,
  refreshUser,
})

export default auth
