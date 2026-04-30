import { error } from '@sveltejs/kit'

import { getCategoryArchive } from '$lib/server/blog'

export async function load({ params }) {
  const archive = await getCategoryArchive(params.slug)
  if (!archive) {
    throw error(404, 'Category not found')
  }

  return archive
}
