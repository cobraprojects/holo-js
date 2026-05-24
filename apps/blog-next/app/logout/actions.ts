'use server'

import { logout } from '@holo-js/auth'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function logoutAction() {
  await logout()
  revalidatePath('/', 'layout')
  redirect('/')
}
