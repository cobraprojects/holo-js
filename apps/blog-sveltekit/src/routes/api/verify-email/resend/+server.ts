import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'

import type { RequestHandler } from './$types'

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

export const POST: RequestHandler = async () => {
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
  } catch (failure) {
    if (failure instanceof SecurityRateLimitError) {
      return Response.json({
        ok: false,
        status: 429,
        errors: { _root: [failure.message] },
      }, { status: 429 })
    }

    throw failure
  }

  return resendSuccessResponse()
}
