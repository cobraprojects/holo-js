import { registerWithClerk } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  return await registerWithClerk(request)
}
