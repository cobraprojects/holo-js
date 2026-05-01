import { redirect } from '@sveltejs/kit'

import { deleteTag } from '$lib/server/blog'

export async function POST({ params }) {
  await deleteTag(Number(params.id))
  throw redirect(303, '/admin/tags')
}
