import { json, redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

export function GET({ request }: { request: Request }): Promise<Response> {
  return handleCallback(request)
}

async function handleCallback(request: Request): Promise<Response> {
  const result = await callback('google', request)
  if (!result.ok) {
    return json({
      message: result.message,
    }, {
      status: result.status,
    })
  }

  await auth.guard(result.guard).loginUsing(result.user)
  throw redirect(303, '/admin')
}
