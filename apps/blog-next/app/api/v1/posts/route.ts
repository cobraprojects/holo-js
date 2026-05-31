import auth from '@holo-js/auth'

import Post from '@/server/models/Post'

export async function GET() {
  const currentUser = await auth.guard('api').user()

  if (!currentUser) {
    return Response.json({
      ok: false,
      message: 'Unauthenticated.',
    }, { status: 401 })
  }

  const userId = currentUser.id

  if (!await currentUser.can('viewAny', Post)) {
    return Response.json({
      ok: false,
      message: 'Forbidden.',
    }, { status: 403 })
  }

  const posts = await Post
    .with('category', 'tags')
    .where('user_id', userId)
    .orderBy('published_at', 'desc')
    .get()

  return Response.json({
    ok: true,
    posts,
  })
}
