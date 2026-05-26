import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { createPost } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event)
  const data = await validate(formData, postForm)
  const status = data.status
  await authorize('create', Post)
  if (status === 'published') {
    await authorize('publish', Post)
  }

  await createPost({
    ...data,
    tagIds: data.tagIds.join(','),
    ...(data.image?.size ? { image: data.image } : {}),
  })

  return sendRedirect(event, '/admin/posts', 303)
})
