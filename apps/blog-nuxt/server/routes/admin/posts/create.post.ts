import { authorize } from '@holo-js/authorization'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { createPost } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async (event) => {
  const user = await auth.user()
  if (!user) return sendRedirect(event, '/login', 303)
  const formData = await readFormData(event)
  const data = await validate(formData, postForm)
  const status = data.status
  await authorize('create', Post)
  if (status === 'published') {
    await authorize('publish', Post)
  }

  await createPost({
    ...data,
    authorId: user.id,
    tagIds: data.tagIds.join(','),
    ...(data.image?.size ? { image: data.image } : {}),
  })

  return sendRedirect(event, '/admin/posts', 303)
})
