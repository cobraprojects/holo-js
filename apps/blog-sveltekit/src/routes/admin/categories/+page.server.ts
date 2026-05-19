import { redirect } from '@sveltejs/kit'

import { createCategory, deleteCategory, getAdminCategoriesData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminCategoriesData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const formData = await request.formData()
    await createCategory({
      name: String(formData.get('name') || ''),
      description: String(formData.get('description') || ''),
    })

    redirect(303, '/admin/categories')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    await deleteCategory(Number(formData.get('id')))

    redirect(303, '/admin/categories')
  },
} satisfies Actions
