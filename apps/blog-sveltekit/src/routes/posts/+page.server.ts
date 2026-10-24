import { getPublishedPosts } from '#lib/server/blog.js'

export async function load() {
  return { posts: await getPublishedPosts() }
}
