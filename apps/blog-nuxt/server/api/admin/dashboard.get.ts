import { getAdminDashboardData } from '../../lib/blog'

export default defineEventHandler(async () => await getAdminDashboardData())
