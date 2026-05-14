import auth from '@holo-js/auth'

import Post from '../../models/Post'

export default defineEventHandler(async (event) => {
  const currentUser = await auth.guard('api').user()

  if (!currentUser) {
    setResponseStatus(event, 401)

    return {
      ok: false,
      message: 'Unauthenticated.',
    }
  }

  const userId = currentUser.id

  if (!currentUser.can('posts.read')) {
    setResponseStatus(event, 403)

    return {
      ok: false,
      message: 'Forbidden.',
    }
  }

  const posts = await Post
    .with('category', 'tags')
    .where('user_id', userId)
    .orderBy('published_at', 'desc')
    .get()

  return {
    ok: true,
    posts,
  }
})
