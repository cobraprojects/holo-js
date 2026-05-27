import { notFound } from 'next/navigation'
import { getAdminPostById } from '@/server/lib/blog'
import { PostForm } from '../../post-form'
import { updatePostAction } from '../../../actions'

export const dynamic = 'force-dynamic'

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getAdminPostById(Number(id))

  if (!data) {
    notFound()
  }

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
