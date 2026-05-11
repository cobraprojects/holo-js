import { loginWithWorkos } from '@holo-js/auth-workos'

export default defineEventHandler(async (event) => {
  return await loginWithWorkos(event)
})
