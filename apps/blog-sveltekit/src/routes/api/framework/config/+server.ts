import { useConfig } from '@holo-js/config'

export function GET() {
  return Response.json({ name: useConfig('app').name })
}
