import { superAdminLogoutAction } from './logout/actions'

export function SuperAdminLogoutButton() {
  return (
    <form action={superAdminLogoutAction}>
      <button type="submit">Sign out of super admin</button>
    </form>
  )
}
