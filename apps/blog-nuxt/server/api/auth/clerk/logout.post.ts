import { logoutWithClerk } from '@holo-js/auth-clerk'

export default defineEventHandler(async (event) => {
  return await logoutWithClerk(event)
})
