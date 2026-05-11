import { registerWithClerk } from '@holo-js/auth-clerk'

export default defineEventHandler(async (event) => {
  return await registerWithClerk(event)
})
