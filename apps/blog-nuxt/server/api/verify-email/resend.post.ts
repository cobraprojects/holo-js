import { verification } from '@holo-js/auth'

interface ResendVerificationRequestBody {
  readonly email?: string
}

export default defineEventHandler(async (event) => {
  let payload: ResendVerificationRequestBody | null = {}
  try {
    payload = await readBody<ResendVerificationRequestBody | null>(event)
  } catch {
    payload = {}
  }
  const email = typeof payload === 'object'
    && payload !== null
    && typeof payload.email === 'string'
    ? payload.email.trim()
    : ''
  const { error } = await verification.resend(email ? { email } : undefined)
  if (error) {
    setResponseStatus(event, error.status)
    return {
      ok: false as const,
      status: error.status,
      errors: error.fields,
    }
  }

  return {
    ok: true as const,
    status: 200,
    data: {
      message: 'A fresh verification email has been sent.',
    },
  }
})
