'use client'

import { useState } from 'react'
import { useFlux } from '@holo-js/flux-react'

export function BroadcastFeed() {
  const [latestPostChange, setLatestPostChange] = useState('Waiting for post activity')

  useFlux('blog.admin', 'blog.post.changed', (payload) => {
    setLatestPostChange(`${payload.action}: ${payload.title}`)
  })

  return (
    <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(125, 211, 252, 0.3)' }}>
      <strong>Live post activity</strong>
      <div data-testid="broadcast-post-activity" style={{ marginTop: '0.35rem', color: '#cbd5e1' }}>{latestPostChange}</div>
    </article>
  )
}
