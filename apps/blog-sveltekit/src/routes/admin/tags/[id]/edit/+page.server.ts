import { error } from '@sveltejs/kit'

import { getAdminTagById } from '$lib/server/blog'

export async function load({ params }) {
  const tag = await getAdminTagById(Number(params.id))
  if (!tag) {
    throw error(404, 'Tag not found')
  }

  return { tag }
}
