'use server'

import auth from '@holo-js/auth'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function superAdminLogoutAction() {
  await auth.guard('admin').logout()
  revalidatePath('/', 'layout')
  redirect('/super-admin/login')
}
