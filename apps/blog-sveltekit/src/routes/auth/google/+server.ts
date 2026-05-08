import { redirect } from '@holo-js/auth-social'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  return redirect('google', request)
}
