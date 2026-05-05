import { verification } from '@holo-js/auth'

interface ResendVerificationRequestBody {
  readonly email?: string
}

export default defineEventHandler(async (event) => {
  let payload: ResendVerificationRequestBody = {}
  try {
    payload = await readBody<ResendVerificationRequestBody>(event)
  } catch {
    payload = {}
  }
  const email = typeof payload.email === 'string' ? payload.email.trim() : ''
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
