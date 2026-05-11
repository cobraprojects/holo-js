import { registerWithWorkos } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  return await registerWithWorkos(request)
}
