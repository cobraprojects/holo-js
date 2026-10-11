'use server'

import { logout } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { logoutForm } from '@/lib/schemas/auth'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function logoutAction(formData: FormData) {
  await validate(formData, logoutForm)
  await logout()
  revalidatePath('/', 'layout')
  redirect('/')
}
