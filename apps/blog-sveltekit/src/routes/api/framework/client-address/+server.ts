import { ip } from '@holo-js/security'

export function GET({ request }: { readonly request: Request }) {
  return Response.json({ address: ip(request) })
}
