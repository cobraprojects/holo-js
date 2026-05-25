'use server'

import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { loginForm } from '@/lib/schemas/auth'

export async function superAdminLoginAction(formData: FormData) {
  const submission = await validate(formData, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  const { data: session, error } = await auth.guard('admin').login(submission.data)
  if (error) {
    return submission.fail({
      status: error.status,
      errors: error.fields,
    })
  }

  const redirectTo = session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/super-admin'

  revalidatePath('/', 'layout')
  redirect(redirectTo)
}
