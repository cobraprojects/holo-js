import auth, { verifyPassword } from '@holo-js/auth'

import User from '../../models/User'

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event)
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!email || !password) {
    setResponseStatus(event, 422)

    return {
      ok: false,
      message: 'Email and password are required.',
    }
  }

  const currentUser = await User.where('email', email).first()
  const passwordMatches = await verifyPassword(password, currentUser?.get('password') ?? '')

  if (!currentUser || !passwordMatches) {
    setResponseStatus(event, 401)

    return {
      ok: false,
      message: 'Invalid credentials.',
    }
  }

  const token = await auth.tokens.create(currentUser, {
    guard: 'api',
    name: 'browser-posts-api',
    abilities: ['posts.read'],
  })

  return {
    ok: true,
    token: token.plainTextToken,
    tokenId: token.id,
    abilities: token.abilities,
  }
})
