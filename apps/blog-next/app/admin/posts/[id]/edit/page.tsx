import { notFound, redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'
import { getAdminPostById } from '@/server/lib/blog'
import Post from '@/server/models/Post'
import { PostForm } from '../../post-form'
import { updatePostAction } from '../../../actions'

export const dynamic = 'force-dynamic'

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)

  const data = await getAdminPostById(Number(id))

  if (!data) {
    notFound()
  }

  await authorize('update', data.post)

  const updateWithId = updatePostAction.bind(null, data.post.id)
  const imagePath = await data.post.getFirstMediaPath('images', 'thumb')
  const formData = {
    categories: data.categories.map(category => ({ id: category.id, name: category.name })),
    tags: data.tags.map(tag => ({ id: tag.id, name: tag.name })),
  }
  const post = {
    id: data.post.id,
    title: data.post.title,
    excerpt: data.post.excerpt,
    body: data.post.body,
    status: data.post.status,
    category_id: data.post.category_id,
    tags: data.post.tags.map(tag => ({ id: tag.id })),
  }

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>Edit post</h1>
      <PostForm action={updateWithId} data={formData} imagePath={imagePath} post={post} submitLabel="Save post" />
    </section>
  )
}
