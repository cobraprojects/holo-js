import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { updatePost } from '../../../../lib/blog'
import Post from '../../../../models/Post'

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event)
  const data = await validate(formData, postForm)
  const id = Number(event.context.params?.id || 0)
  const status = data.status
  const post = await Post.findOrFail(id)
  await authorize('update', post)
  if (status === 'published') {
    await authorize('publish', post)
  }

  await updatePost(id, {
    ...data,
    tagIds: data.tagIds.join(','),
    ...(data.image?.size ? { image: data.image } : {}),
  })

  return sendRedirect(event, '/admin/posts', 303)
})
