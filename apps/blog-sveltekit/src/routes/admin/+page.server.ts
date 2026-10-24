import { getAdminDashboardData } from '#lib/server/blog.js'

export async function load() {
  return await getAdminDashboardData()
}
