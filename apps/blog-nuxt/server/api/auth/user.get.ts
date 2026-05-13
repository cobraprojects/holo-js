import auth, { check, provider, user } from '@holo-js/auth'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const guard = typeof query.guard === 'string' ? query.guard : undefined
  const guardAuth = guard ? auth.guard(guard) : undefined

  return {
    authenticated: guardAuth ? await guardAuth.check() : await check(),
    guard: guard ?? 'web',
    provider: guardAuth ? await guardAuth.provider() : await provider(),
    user: guardAuth ? await guardAuth.user() : await user(),
  }
})
