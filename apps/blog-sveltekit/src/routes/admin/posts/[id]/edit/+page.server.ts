import { error } from '@sveltejs/kit'

import { getAdminPostById } from '$lib/server/blog'

export async function load({ params }) {
  const data = await getAdminPostById(Number(params.id))
  if (!data) {
    throw error(404, 'Post not found')
  }

  return data
}
