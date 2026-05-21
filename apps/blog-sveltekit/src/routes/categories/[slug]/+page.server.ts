import { error } from '@sveltejs/kit'

import { getCategoryArchive } from '$lib/server/blog'
import type { PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const archive = await getCategoryArchive(params.slug)
  if (!archive) {
    throw error(404, 'Category not found')
  }

  return archive
}) satisfies PageServerLoad
