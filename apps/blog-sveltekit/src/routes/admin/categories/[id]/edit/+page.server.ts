import { error } from '@sveltejs/kit'

import { getAdminCategoryById } from '$lib/server/blog'

export async function load({ params }) {
  const category = await getAdminCategoryById(Number(params.id))
  if (!category) {
    throw error(404, 'Category not found')
  }

  return { category }
}
