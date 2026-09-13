---
name: holo-queues-events
description: Implement Holo-JS jobs, queue workers, retries, failed jobs, domain events, listeners, queued listeners, after-commit dispatch, and model event coordination.
metadata:
  type: focused
  source: https://docs.holo-js.com/events/
---

# Queues and events

Read [event pattern selection](https://docs.holo-js.com/events/choosing-patterns), [event definitions](https://docs.holo-js.com/events/defining-events), [listeners](https://docs.holo-js.com/events/defining-listeners), [queued listeners](https://docs.holo-js.com/events/queued-listeners), [after-commit dispatch](https://docs.holo-js.com/events/transactions-after-commit), [jobs](https://docs.holo-js.com/queue/jobs), [workers](https://docs.holo-js.com/queue/workers), and [failed jobs](https://docs.holo-js.com/queue/failed-jobs).

## Choose the mechanism

- A domain event states that something happened and may have several listeners.
- A job is explicit background work with queue, retry, timeout, and failure policy.
- A queued listener moves one event reaction off the request path.
- A model observer owns lifecycle behavior tightly coupled to model persistence; see the database skill.

```ts
export const PostPublished = defineEvent<{ postId: string }>({
  name: 'post.published',
})

await DB.transaction(async () => {
  const post = await Post.create(data)
  await PostPublished.dispatch({ postId: post.id }).afterCommit()
})
```

## Reliability

- Event names and payloads are stable contracts. Pass identifiers rather than live models or request objects.
- Jobs and listeners must be idempotent because delivery can repeat.
- Set intentional queue, retry, backoff, timeout, and terminal failure behavior.
- Never dispatch a consumer-visible event before the transaction it depends on commits.
- Keep request-only state out of queued work.

## Completion check

- The chosen event, job, listener, or observer matches the coupling and execution needs.
- Transaction timing is explicit.
- Tests prove synchronous dispatch, queued handoff, retry-safe side effects, and terminal failure handling as applicable.
