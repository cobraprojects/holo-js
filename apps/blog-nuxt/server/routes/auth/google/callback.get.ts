import auth from '@holo-js/auth'
import { callback, SocialAuthConflictError } from '@holo-js/auth-social'

export default defineEventHandler(async (event) => {
  const result = await callback('google', event).catch((error: unknown) => {
    if (error instanceof SocialAuthConflictError) {
      return { ok: false, status: 409, message: 'Sign in with your password and verify your email to link this account.' } as const
    }
    throw error
  })
  if (!result.ok) {
    setResponseStatus(event, result.status)
    return { message: result.message }
  }

  const guard = auth.guard(result.guard)
  if (!('multiFactor' in guard)) throw new Error('Social login requires a session guard')
  await guard.loginUsing(result.user)
  return sendRedirect(event, '/admin', 303)
})
