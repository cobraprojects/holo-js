import { redirect } from '@sveltejs/kit'

import { updatePost } from '$lib/server/blog'

export async function POST({ params, request }) {
  const formData = await request.formData()
  await updatePost(Number(params.id), {
    title: String(formData.get('title') || ''),
    excerpt: String(formData.get('excerpt') || ''),
    body: String(formData.get('body') || ''),
    status: String(formData.get('status') || 'published'),
    categoryId: String(formData.get('categoryId') || ''),
    tagIds: formData.getAll('tagIds').map(String).join(','),
  })
  throw redirect(303, '/admin/posts')
}
