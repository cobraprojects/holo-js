import { json } from '@sveltejs/kit'
import auth, { verifyPassword } from '@holo-js/auth'

import User from '../../../../../server/models/User'

export async function POST({ request }: { request: Request }) {
  const formData = await request.formData()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!email || !password) {
    return json({
      ok: false,
      message: 'Email and password are required.',
    }, { status: 422 })
  }

  const currentUser = await User.where('email', email).first()
  const passwordMatches = await verifyPassword(password, currentUser?.get('password') ?? '')

  if (!currentUser || !passwordMatches) {
    return json({
      ok: false,
      message: 'Invalid credentials.',
    }, { status: 401 })
  }

  const token = await auth.tokens.create(currentUser, {
    guard: 'api',
    name: 'browser-posts-api',
    abilities: ['posts.read'],
  })

  return json({
    ok: true,
    token: token.plainTextToken,
    tokenId: token.id,
    abilities: token.abilities,
  })
}
