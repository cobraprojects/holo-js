'use server'

import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { loginForm } from '@/lib/schemas/auth'

export async function superAdminLoginAction(formData: FormData) {
  const input = await validate(formData, loginForm, {
    throttle: 'login',
  })

  const session = await auth.guard('admin').login(input)

  const redirectTo = session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/super-admin'

  revalidatePath('/', 'layout')
  redirect(redirectTo)
}
