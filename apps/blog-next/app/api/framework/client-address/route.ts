import { ip } from '@holo-js/security'

export function GET(request: Request) {
  try {
    return Response.json({ address: ip(request) })
  } catch (error) {
    if (error instanceof Error && error.name === 'SecurityClientAddressUnavailableError') {
      return Response.json({ address: null }, { status: 503 })
    }

    throw error
  }
}
