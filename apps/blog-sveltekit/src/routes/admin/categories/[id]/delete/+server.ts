import { redirect } from '@sveltejs/kit'

import { deleteCategory } from '$lib/server/blog'

export async function POST({ params }) {
  await deleteCategory(Number(params.id))
  throw redirect(303, '/admin/categories')
}
