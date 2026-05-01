import { getAdminTagsData } from '$lib/server/blog'

export async function load() {
  return await getAdminTagsData()
}
