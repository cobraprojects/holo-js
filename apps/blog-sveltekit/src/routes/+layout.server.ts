import { auth } from '@holo-js/auth/sveltekit/server'

export async function load() {
  const currentAuth = await auth()

  return {
    auth: currentAuth,
  }
}
