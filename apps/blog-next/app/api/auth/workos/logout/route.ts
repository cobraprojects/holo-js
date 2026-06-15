import { logoutWithWorkos } from '@holo-js/auth-workos'

export async function POST(request: Request) {
  return await logoutWithWorkos(request)
}
