import { redirect } from '@sveltejs/kit'

import { createPost } from '$lib/server/blog'

export async function POST({ request }) {
  const formData = await request.formData()
  await createPost({
    title: String(formData.get('title') || ''),
    excerpt: String(formData.get('excerpt') || ''),
    body: String(formData.get('body') || ''),
    status: String(formData.get('status') || 'published'),
    categoryId: String(formData.get('categoryId') || ''),
    tagIds: formData.getAll('tagIds').map(String).join(','),
  })
  throw redirect(303, '/admin/posts')
}
