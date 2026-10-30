import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resetPasswordForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const input = await validate(request, resetPasswordForm)

  await resetPassword(input)

  return Response.json({
    ok: true,
    status: 200,
    data: {
      message: 'Password reset successfully. You can sign in with your new password.',
      redirectTo: '/login',
    },
  })
}
