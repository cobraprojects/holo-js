import { json } from '@sveltejs/kit'
import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'
import { serializeValidationException } from '@holo-js/validation'

import type { RequestHandler } from './$types'

const resendSuccessMessage = 'A fresh verification email has been sent.'

function resendSuccessResponse() {
  return json({
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
    return json({
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
      return json({
        ok: false,
        status: 429,
        errors: { _root: [failure.message] },
      }, { status: 429 })
    }

    const payload = serializeValidationException(failure)
    if (!payload) {
      throw failure
    }

    return json(payload, { status: payload.status })
  }

  return resendSuccessResponse()
}
