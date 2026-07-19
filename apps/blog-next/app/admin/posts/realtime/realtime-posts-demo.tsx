'use client'

import { useState, useTransition } from 'react'
import { adminPosts, renameAdminPost } from '@/server/realtime/posts'

export default function RealtimePostsDemo() {
  const data = adminPosts()
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [isPending, startTransition] = useTransition()
  const posts = data.posts

  function selectPost(post: typeof posts[number]) {
    setSelectedPostId(post.id)
    setTitle(`${post.title} updated`)
  }

  function savePost() {
    if (!selectedPostId) {
      return
    }

    startTransition(() => {
      void renameAdminPost({ id: selectedPostId, title })
    })
  }

  return (
    <section style={{ display: 'grid', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Realtime posts</h1>
        <a href="/admin/posts" style={{ color: '#7dd3fc' }}>Posts</a>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          savePost()
        }}
        style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <input
          aria-label="Realtime post title"
          value={title}
          onChange={event => setTitle(event.target.value)}
          style={{ minWidth: '18rem', flex: '1 1 18rem' }}
        />
        <button type="submit" disabled={!selectedPostId || isPending}>Save realtime title</button>
      </form>
      {posts.map(post => (
        <article key={post.id} data-post-id={post.id} style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: '0 0 0.5rem 0' }}>{post.title}</h2>
              <div style={{ color: '#94a3b8' }}>
                {post.status} · {post.category?.name ?? 'Uncategorized'} · {post.tags.map(tag => tag.name).join(', ') || 'No tags'}
              </div>
            </div>
            <button type="button" onClick={() => selectPost(post)}>Edit title</button>
          </div>
        </article>
      ))}
    </section>
  )
}
