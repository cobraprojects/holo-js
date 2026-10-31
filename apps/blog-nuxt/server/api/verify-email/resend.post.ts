import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'

const resendSuccessMessage = 'A fresh verification email has been sent.'

function resendSuccessResponse() {
  return {
    ok: true as const,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  }
}

export default defineEventHandler(async (event) => {
  const current = await user()
  if (!current) {
    setResponseStatus(event, 401)
    return {
      ok: false as const,
      status: 401,
      errors: { _root: ['Sign in before requesting another verification email.'] },
    }
  }

  try {
    await rateLimit('emailVerificationResend', { key: `user:${String(current.id)}` })
    await resendEmailVerification()
  } catch (error) {
    if (error instanceof SecurityRateLimitError) {
      setResponseStatus(event, 429)
      return {
        ok: false as const,
        status: 429,
        errors: { _root: [error.message] },
      }
    }

    throw error
  }

  return resendSuccessResponse()
})
