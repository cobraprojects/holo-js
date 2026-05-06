import { auth } from '@holo-js/adapter-sveltekit/server'

export async function load() {
  const currentAuth = await auth()

  return {
    auth: currentAuth,
  }
}
