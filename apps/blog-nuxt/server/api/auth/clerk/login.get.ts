import { loginWithClerk } from '@holo-js/auth-clerk'

export default defineEventHandler(async (event) => {
  return await loginWithClerk(event)
})
