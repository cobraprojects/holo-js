import { redirect } from '@sveltejs/kit'

import { deletePost } from '$lib/server/blog'

export async function POST({ params }) {
  await deletePost(Number(params.id))
  throw redirect(303, '/admin/posts')
}
