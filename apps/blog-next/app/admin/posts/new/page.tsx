import { getAdminPostFormData } from '@/server/lib/blog'
import { createPostAction } from '../../actions'
import { PostForm } from '../post-form'

export const dynamic = 'force-dynamic'

export default async function NewPostPage() {
  const data = await getAdminPostFormData()
  const formData = {
    categories: data.categories.map(category => ({ id: category.id, name: category.name })),
    tags: data.tags.map(tag => ({ id: tag.id, name: tag.name })),
  }

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>New post</h1>
      <PostForm action={createPostAction} data={formData} imagePath={undefined} post={undefined} submitLabel="Create post" />
    </section>
  )
}
