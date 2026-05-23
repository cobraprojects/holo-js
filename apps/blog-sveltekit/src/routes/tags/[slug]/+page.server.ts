import { error } from '@sveltejs/kit'

import { getTagArchive } from '$lib/server/blog'
import type { PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const archive = await getTagArchive(params.slug)
  if (!archive) {
    throw error(404, 'Tag not found')
  }

  return archive
}) satisfies PageServerLoad
