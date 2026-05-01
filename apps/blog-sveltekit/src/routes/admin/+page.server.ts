import { getAdminDashboardData } from '$lib/server/blog'

export async function load() {
  return await getAdminDashboardData()
}
