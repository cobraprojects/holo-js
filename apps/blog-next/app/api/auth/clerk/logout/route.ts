import { logoutWithClerk } from '@holo-js/auth-clerk'

export async function POST(request: Request) {
  return await logoutWithClerk(request)
}
