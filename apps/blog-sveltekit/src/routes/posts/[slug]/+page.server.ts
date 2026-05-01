import { error } from '@sveltejs/kit'

import { getPublishedPostBySlug } from '$lib/server/blog'

export async function load({ params }) {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) {
    throw error(404, 'Post not found')
  }

  return { post }
}
