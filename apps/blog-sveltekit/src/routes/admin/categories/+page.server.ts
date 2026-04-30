import { getAdminCategoriesData } from '$lib/server/blog'

export async function load() {
  return await getAdminCategoriesData()
}
