import { redirect } from '@sveltejs/kit'

import { createTag } from '$lib/server/blog'

export async function POST({ request }) {
  const formData = await request.formData()
  await createTag({ name: String(formData.get('name') || '') })
  throw redirect(303, '/admin/tags')
}
