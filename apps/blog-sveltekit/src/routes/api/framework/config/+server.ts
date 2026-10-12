import { json } from '@sveltejs/kit'
import { useConfig } from '@holo-js/config'

export function GET() {
  return json({ name: useConfig('app').name })
}
