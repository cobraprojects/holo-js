'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { logoutForm } from '@/lib/schemas/auth'
import { superAdminLogoutAction } from './logout/actions'

export function SuperAdminLogoutButton() {
  const form = useForm(logoutForm, {
    submitter: ({ formData }) => superAdminLogoutAction(formData),
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <button type="submit" disabled={form.submitting}>Sign out of super admin</button>
    </form>
  )
}
