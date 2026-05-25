'use server'

import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { loginForm } from '@/lib/schemas/auth'

export async function loginAction(formData: FormData) {
  const submission = await validate(formData, loginForm, {
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  const { data: session, error } = await login(submission.data)
  if (error) {
    return submission.fail({
      status: error.status,
      errors: error.fields,
    })
  }

  const redirectTo = session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/admin'

  revalidatePath('/', 'layout')
  redirect(redirectTo)
}
