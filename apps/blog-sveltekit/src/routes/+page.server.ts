import { getHomePageData } from '$lib/server/blog'

export async function load() {
  return await getHomePageData()
}
