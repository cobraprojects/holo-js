import { verification } from '@holo-js/auth'

interface ResendVerificationRequestBody {
  readonly email?: string
}

async function readRequestBody(request: Request): Promise<ResendVerificationRequestBody> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return {}
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const email = typeof payload.email === 'string' ? payload.email.trim() : undefined
  return email ? { email } : {}
}

export async function POST(request: Request) {
  const input = await readRequestBody(request)
  const { error } = await verification.resend(input)
  if (error) {
    return Response.json({
      ok: false as const,
      status: error.status,
      errors: error.fields,
    }, {
      status: error.status,
    })
  }

  return Response.json({
    ok: true as const,
    status: 200,
    data: {
      message: 'A fresh verification email has been sent.',
    },
  })
}
