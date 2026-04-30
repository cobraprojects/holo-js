import { redirect } from '@sveltejs/kit'

import { updateTag } from '$lib/server/blog'

export async function POST({ params, request }) {
  const formData = await request.formData()
  await updateTag(Number(params.id), { name: String(formData.get('name') || '') })
  throw redirect(303, '/admin/tags')
}
