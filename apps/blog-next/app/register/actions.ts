'use server'

import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { registerForm } from '@/lib/schemas/auth'

export async function registerAction(formData: FormData) {
  const submission = await validate(formData, registerForm, {
    throttle: 'register',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  const { data: created, error } = await register(submission.data)
  if (error) {
    return submission.fail({
      status: error.status,
      errors: error.fields,
    })
  }

  const session = await loginUsing(created)
  const redirectTo = session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/admin'

  revalidatePath('/', 'layout')
  redirect(redirectTo)
}
