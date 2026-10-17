# Jobs and Tests

Background jobs and tests have no signed-in user, so pass the user to `authorization.forUser()`. The same policies and abilities run, and the result doesn't depend on any request.

## Authorize inside a job

Put the acting user's ID in the payload, load the user in the job, and check before doing the work:

```ts [server/jobs/posts/publish-post.ts]
import { defineJob } from '@holo-js/queue'
import authorization from '@holo-js/authorization'
import Post from '../../models/Post'
import User from '../../models/User'

export default defineJob<{ postId: number, userId: number }>({
  async handle(payload) {
    const [post, actor] = await Promise.all([
      Post.findOrFail(payload.postId),
      User.findOrFail(payload.userId),
    ])

    await authorization.forUser(actor).authorize('publish', post)

    await post.update({ status: 'published' })
  },
})
```

Check again in the job even if the route already checked. Permissions can change between dispatch and run. If the check fails, `authorize()` throws and the job fails like any other error; see [Failed Jobs](/queue/failed-jobs).

To skip the job quietly instead, use `can()`:

```ts
if (!(await authorization.forUser(actor).can('publish', post))) {
  return
}
```

Pass IDs, not whole user objects. Job payloads are stored as JSON, and loading the user fresh means you check their current permissions. See [Writing Jobs](/queue/jobs).

## Test a policy

Test rules through `forUser()` with the kinds of users that matter: the owner, someone else, a guest. Use `can()` or `inspect()`, which return a value instead of throwing:

```ts [tests/policies/post-policy.test.ts]
import { describe, expect, it } from 'vitest'
import authorization from '@holo-js/authorization'
import '../../server/policies/PostPolicy'
import Post from '../../server/models/Post'
import User from '../../server/models/User'

describe('posts policy', () => {
  it('lets only the author update a post', async () => {
    const author = await User.create({ name: 'Ava', email: 'ava@example.com' })
    const reader = await User.create({ name: 'Ben', email: 'ben@example.com' })
    const post = await Post.create({ title: 'Hello', body: 'First post', user_id: author.id })

    expect(await authorization.forUser(author).can('update', post)).toBe(true)
    expect(await authorization.forUser(reader).can('update', post)).toBe(false)
  })

  it('hides drafts from guests', async () => {
    const post = await Post.create({ title: 'Draft', body: 'Not yet', status: 'draft' })

    const decision = await authorization.forUser(null).inspect('view', post)

    expect(decision).toMatchObject({ allowed: false, status: 404 })
  })
})
```

Importing the policy file registers it, so the test works even when nothing else has loaded your policies. These tests create records, so run them with a test database; see [Database Tests](/testing/database).

To check the message a user sees, assert on `decision.message`, which is the text you passed to `deny()`.

## What to prefer

| Situation | Use |
| --- | --- |
| A route checking the signed-in user | `authorize()` from `@holo-js/authorization` |
| A route for a specific guard | `authorization.guard(name)` |
| Jobs, scripts, commands | `authorization.forUser(user)` |
| Tests of a policy or ability | `authorization.forUser(user)` with `can()` or `inspect()` |

## Next steps

- [Using without Auth](/authorization/standalone)
- [Policies](/authorization/policies)
- [Testing Your App](/testing/)
