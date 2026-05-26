import { error } from '@sveltejs/kit'

import { getPublishedPostBySlug } from '$lib/server/blog'
import type { PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) {
    throw error(404, 'Post not found')
  }

  return {
    post: post.toJSON(),
    imageUrl: await post.getFirstMediaUrl('images', 'thumb'),
  }
}) satisfies PageServerLoad
