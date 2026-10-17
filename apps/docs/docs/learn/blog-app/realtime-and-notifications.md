# Realtime and Notifications

This chapter broadcasts post changes, dispatches events, and sends notifications from the blog workflow.

## What you will build

- a post-changed broadcast payload
- a private admin broadcast channel
- a post-saved event
- a listener that reacts after the post write
- notification-ready auth mail flows

## Files you will create

```txt
server/broadcast/blog-post-changed.ts
server/channels/blog-admin.ts
server/events/blog/post-saved.ts
server/listeners/blog/index-saved-post.ts
server/jobs/blog/index-post.ts
server/notifications/auth/email-verification.ts
server/notifications/auth/password-reset.ts
server/realtime/posts.ts
app/admin/broadcast-feed.tsx
```

The finished example uses those same files under `apps/blog-next`.

## Broadcast inside the write

Send the broadcast as the last step inside the post's transaction:

```ts
const post = await DB.transaction(async () => {
  const post = await Post.create({ /* ... */ })
  await broadcast(blogPostChanged('created', post.id, post.title, post.status, post.slug))
  return post
})
```

If the broadcast worker cannot be reached, `broadcast()` throws and the transaction rolls back, so
the user sees the error and no half-finished post is left behind.

## Dispatch domain events

Dispatch the event after the transaction commits, so the indexing job only ever sees saved posts:

```ts
await BlogPostSaved.dispatch({
  action: 'created',
  postId: post.id,
  title: post.title,
  status: post.status,
  slug: post.slug,
})
```

## Use cases

- update an admin dashboard when a post changes
- queue indexing work after a post is saved
- notify users about auth lifecycle events
- keep realtime subscribers in sync

## Checkpoint

Blog writes now produce side effects outside the request path, while the write itself stays focused on data consistency.

## Related reference

- [Events](/events/)
- [Broadcast](/broadcast/)
- [Realtime](/realtime/)
- [Notifications](/notifications/)
- [Queue](/queue/)
