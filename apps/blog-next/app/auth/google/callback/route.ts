import { redirect } from 'next/navigation'
import auth from '@holo-js/auth'
import { callback, SocialAuthConflictError } from '@holo-js/auth-social'

export function GET(request: Request): Promise<Response> {
  return handleCallback(request)
}

async function handleCallback(request: Request): Promise<Response> {
  const result = await callback('google', request).catch((error: unknown) => {
    if (error instanceof SocialAuthConflictError) {
      return { ok: false, status: 409, message: 'Sign in with your password and verify your email to link this account.' } as const
    }
    throw error
  })
  if (!result.ok) {
    return Response.json({
      message: result.message,
    }, {
      status: result.status,
    })
  }

  const guard = auth.guard(result.guard)
  if (!('multiFactor' in guard)) throw new Error('Social login requires a session guard')
  await guard.loginUsing(result.user)
  redirect('/admin')
}
