import { redirect } from '@holo-js/auth-social'

export function GET(request: Request): Promise<Response> {
  return redirect('github', request)
}
