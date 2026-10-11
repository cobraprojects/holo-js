'use server'

import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { logoutForm } from '@/lib/schemas/auth'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function superAdminLogoutAction(formData: FormData) {
  await validate(formData, logoutForm)
  await auth.guard('admin').logout()
  revalidatePath('/', 'layout')
  redirect('/super-admin/login')
}
