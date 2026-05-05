import { check, user } from '@holo-js/auth'

export async function GET() {
  return Response.json({
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  })
}
