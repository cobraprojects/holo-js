import { redirect } from '@sveltejs/kit'

import { createCategory } from '$lib/server/blog'

export async function POST({ request }) {
  const formData = await request.formData()
  await createCategory({ name: String(formData.get('name') || ''), description: String(formData.get('description') || '') })
  throw redirect(303, '/admin/categories')
}
