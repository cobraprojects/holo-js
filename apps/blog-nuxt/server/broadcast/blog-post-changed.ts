import { defineBroadcast, privateChannel } from '@holo-js/broadcast'

export function blogPostChanged(action: 'created' | 'updated' | 'deleted', id: number, title: string, status: string, slug: string) {
  return defineBroadcast({
    name: 'blog.post.changed',
    channels: [
      privateChannel('blog.admin'),
    ],
    payload: {
      action,
      id,
      title,
      status,
      slug,
    },
  })
}
