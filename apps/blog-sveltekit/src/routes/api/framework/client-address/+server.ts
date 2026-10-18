import { json } from '@sveltejs/kit'
import { ip } from '@holo-js/security'

export function GET({ request }: { readonly request: Request }) {
  return json({ address: ip(request) })
}
