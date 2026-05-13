import auth from '@holo-js/auth'

import Post from '../../models/Post'

export default defineEventHandler(async (event) => {
  const currentUser = await auth.guard('api').user()
  const userId = currentUser?.id

  if (typeof userId === 'undefined') {
    setResponseStatus(event, 401)

    return {
      ok: false,
      message: 'Unauthenticated.',
    }
  }

  const posts = await Post
    .with('category', 'tags')
    .where('user_id', Number(userId))
    .orderBy('published_at', 'desc')
    .get()

  return {
    ok: true,
    posts,
  }
})
