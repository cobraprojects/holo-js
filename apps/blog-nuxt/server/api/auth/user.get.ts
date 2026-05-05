import { check, user } from '@holo-js/auth'

export default defineEventHandler(async () => {
  return {
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  }
})
