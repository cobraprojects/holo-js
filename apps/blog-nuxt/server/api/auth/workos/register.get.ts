import { registerWithWorkos } from '@holo-js/auth-workos'

export default defineEventHandler(async (event) => {
  return await registerWithWorkos(event)
})
