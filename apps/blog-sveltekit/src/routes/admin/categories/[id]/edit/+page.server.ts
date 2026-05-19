import { error, redirect } from '@sveltejs/kit'

import { getAdminCategoryById, updateCategory } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const category = await getAdminCategoryById(Number(params.id))

  if (!category) {
    throw error(404, 'Category not found')
  }

  return { category }
}) satisfies PageServerLoad

export const actions = {
  update: async ({ params, request }) => {
    const formData = await request.formData()
    await updateCategory(Number(params.id), {
      name: String(formData.get('name') || ''),
      description: String(formData.get('description') || ''),
    })

    redirect(303, '/admin/categories')
  },
} satisfies Actions
