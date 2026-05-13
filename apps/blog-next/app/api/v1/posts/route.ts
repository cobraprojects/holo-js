import auth from '@holo-js/auth'

import Post from '@/server/models/Post'

export async function GET() {
  const currentUser = await auth.guard('api').user()
  const userId = currentUser?.id

  if (typeof userId === 'undefined') {
    return Response.json({
      ok: false,
      message: 'Unauthenticated.',
    }, { status: 401 })
  }

  const posts = await Post
    .with('category', 'tags')
    .where('user_id', Number(userId))
    .orderBy('published_at', 'desc')
    .get()

  return Response.json({
    ok: true,
    posts,
  })
}
