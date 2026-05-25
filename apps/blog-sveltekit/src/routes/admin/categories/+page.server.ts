import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'

import { createCategory, deleteCategory, getAdminCategoriesData } from '$lib/server/blog'
import Category from '../../../../server/models/Category'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminCategoriesData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const formData = await request.formData()
    await authorize('manage', Category)
    await createCategory({
      name: String(formData.get('name') || ''),
      description: String(formData.get('description') || ''),
    })

    redirect(303, '/admin/categories')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    await authorize('manage', Category)
    await deleteCategory(Number(formData.get('id')))

    redirect(303, '/admin/categories')
  },
} satisfies Actions
