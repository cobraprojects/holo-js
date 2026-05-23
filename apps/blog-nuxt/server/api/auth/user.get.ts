import auth, { check, isAuthError, provider, user } from '@holo-js/auth'
import { setResponseStatus } from 'h3'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const guard = typeof query.guard === 'string' ? query.guard : undefined
  try {
    const guardAuth = guard ? auth.guard(guard) : undefined

    return {
      authenticated: guardAuth ? await guardAuth.check() : await check(),
      guard: guard ?? 'web',
      provider: guardAuth ? await guardAuth.provider() : await provider(),
      user: guardAuth ? await guardAuth.user() : await user(),
    }
  } catch (error) {
    if (isAuthError(error) && error.code === 'guard_not_configured') {
      setResponseStatus(event, 400)

      return {
        authenticated: false,
        guard: guard ?? 'web',
        provider: null,
        user: null,
      }
    }

    throw error
  }
})
