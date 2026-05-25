import { error, redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'

import { getAdminCategoryById, updateCategory } from '$lib/server/blog'
import Category from '../../../../../../server/models/Category'
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
    await authorize('manage', Category)
    await updateCategory(Number(params.id), {
      name: String(formData.get('name') || ''),
      description: String(formData.get('description') || ''),
    })

    redirect(303, '/admin/categories')
  },
} satisfies Actions
