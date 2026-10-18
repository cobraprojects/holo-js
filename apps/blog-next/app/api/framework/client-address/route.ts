import { ip } from '@holo-js/security'

export function GET(request: Request) {
  return Response.json({ address: ip(request) })
}
