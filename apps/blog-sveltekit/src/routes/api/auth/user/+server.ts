import { json } from '@sveltejs/kit'
import { check, user } from '@holo-js/auth'

export async function GET() {
  return json({
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  })
}
