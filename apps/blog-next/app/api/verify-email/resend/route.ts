import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'


const resendSuccessMessage = 'A fresh verification email has been sent.'

function resendSuccessResponse() {
  return Response.json({
    ok: true,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  })
}

export async function POST() {
  const current = await user()
  if (!current) {
    return Response.json({
      ok: false,
      status: 401,
      errors: { _root: ['Sign in before requesting another verification email.'] },
    }, { status: 401 })
  }

  try {
    await rateLimit('emailVerificationResend', { key: `user:${String(current.id)}` })
    await resendEmailVerification()
    return resendSuccessResponse()
  } catch (error) {
    if (error instanceof SecurityRateLimitError) {
      return Response.json({
        ok: false,
        status: 429,
        errors: { _root: [error.message] },
      }, { status: 429 })
    }

    throw error
  }
}
