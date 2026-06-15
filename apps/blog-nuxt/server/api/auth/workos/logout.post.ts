import { logoutWithWorkos } from '@holo-js/auth-workos'

export default defineEventHandler(async (event) => {
  return await logoutWithWorkos(event)
})
