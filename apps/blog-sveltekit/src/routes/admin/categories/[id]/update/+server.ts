import { redirect } from '@sveltejs/kit'

import { updateCategory } from '$lib/server/blog'

export async function POST({ params, request }) {
  const formData = await request.formData()
  await updateCategory(Number(params.id), { name: String(formData.get('name') || ''), description: String(formData.get('description') || '') })
  throw redirect(303, '/admin/categories')
}
