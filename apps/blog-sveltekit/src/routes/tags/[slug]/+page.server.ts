import { error } from '@sveltejs/kit'

import { getTagArchive } from '$lib/server/blog'

export async function load({ params }) {
  const archive = await getTagArchive(params.slug)
  if (!archive) {
    throw error(404, 'Tag not found')
  }

  return archive
}
