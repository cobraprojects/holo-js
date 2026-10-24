import { redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { callback, SocialAuthConflictError } from '@holo-js/auth-social'

export function GET({ request }: { request: Request }): Promise<Response> {
  return handleCallback(request)
}

async function handleCallback(request: Request): Promise<Response> {
  const result = await callback('github', request).catch((error: unknown) => {
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

  await auth.guard(result.guard).loginUsing(result.user)
  throw redirect(303, '/admin')
}
