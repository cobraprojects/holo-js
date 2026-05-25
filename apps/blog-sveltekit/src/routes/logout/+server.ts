import { redirect } from '@sveltejs/kit'
import { logout } from '@holo-js/auth'

export async function POST() {
  await logout()
  redirect(303, '/')
}
