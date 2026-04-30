import { getAdminPostsData } from '$lib/server/blog'

export async function load() {
  return await getAdminPostsData()
}
