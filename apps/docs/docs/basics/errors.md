# Error Responses

You return or throw HTTP errors the way your framework already does. Holo turns its own failures (invalid input, too many attempts, denied access) into the right status code for you, and it gives you two helpers for reading HTTP errors in your own code.

## Return an error

Use your framework's native tools:

::: code-group

```ts [Next.js]
// app/api/posts/[slug]/route.ts
import Post from '@/server/models/Post'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const post = await Post.where('slug', (await params).slug).first()

  if (!post) {
    return Response.json({ message: 'Post not found.' }, { status: 404 })
  }

  return Response.json(post)
}
```

```ts [Nuxt]
// server/api/posts/[slug].get.ts
import Post from '../../models/Post'

export default defineEventHandler(async (event) => {
  const post = await Post.where('slug', getRouterParam(event, 'slug') ?? '').first()

  if (!post) {
    throw createError({ statusCode: 404, statusMessage: 'Post not found.' })
  }

  return post
})
```

```ts [SvelteKit]
// src/routes/api/posts/[slug]/+server.ts
import { error, json } from '@sveltejs/kit'
import Post from '../../../../../server/models/Post'

export async function GET({ params }) {
  const post = await Post.where('slug', params.slug).first()

  if (!post) {
    error(404, 'Post not found.')
  }

  return json(post)
}
```

:::

In Next.js pages and server components, use `notFound()` from `next/navigation` as usual.

## Statuses Holo sends for you

| Status | When | Details |
|---|---|---|
| `422` | `validate()` fails | [Validation error messages](/basics/validation/errors) |
| `429` | A rate limit is hit | [Rate limiting](/basics/security/rate-limiting) |
| `403` | `authorize()` denies with `deny()` | [Denied responses](/authorization/errors) |
| `404` | `authorize()` denies with `denyAsNotFound()` | [Denied responses](/authorization/errors) |
| `419` | The CSRF token is missing or wrong | [CSRF protection](/basics/security/csrf) |

You don't need a `try`/`catch` for any of these. Throw, and Holo builds the response.

## Validation errors (422)

When `validate()` throws, Holo replies with `422` and a JSON body that lists the errors per field:

```json
{
  "ok": false,
  "status": 422,
  "valid": false,
  "message": "title: This field is required.",
  "bag": "default",
  "values": { "body": "Draft text" },
  "errors": { "title": ["This field is required."] }
}
```

API routes get this JSON directly. Native HTML form posts are redirected back to the form with the errors kept for the next page load. The [error messages page](/basics/validation/errors#how-each-framework-responds) shows exactly which routes get which behavior in each framework.

To report a business-rule failure, such as a taken username, in the same format, throw `ValidationException.withMessages()`:

```ts
import { ValidationException } from '@holo-js/validation'

throw ValidationException.withMessages({
  email: ['That email address is already registered.'],
})
```

## Too many attempts (429)

When a rate limit is hit, route handlers return `429` with a `Retry-After` header and a body in the same shape as a validation failure. The message goes in the `_root` error:

```json
{
  "ok": false,
  "valid": false,
  "status": 429,
  "bag": "default",
  "message": "Too many attempts. Please try again later.",
  "errors": { "_root": ["Too many attempts. Please try again later."] },
  "values": {},
  "retryAfterSeconds": 42
}
```

The message above is the default. See [rate limiting](/basics/security/rate-limiting).

## Denied access (403 and 404)

`authorize()` throws your framework's own HTTP error, so your existing error pages handle it:

| Framework | What `authorize()` throws |
|---|---|
| Next.js | The same error as Next's `forbidden()` or `notFound()`. Default messages: `Forbidden` and `Resource not found.` |
| Nuxt | `createError({ statusCode, statusMessage })`. Default message: `You are not authorized to perform this action.` |
| SvelteKit | `error(status, message)` from `@sveltejs/kit`. Same default message as Nuxt. |

A message you pass to `deny()` or `denyAsNotFound()` replaces the default.

```ts [app/admin/posts/[id]/edit/page.tsx]
import { authorize } from '@holo-js/authorization'
import Post from '@/server/models/Post'

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const post = await Post.findOrFail(Number((await params).id))
  await authorize('update', post)

  return <h1>Edit {post.title}</h1>
}
```

Use `deny()` when the user is known but not allowed. Use `denyAsNotFound()` when you don't want to reveal that the record exists. See [denied responses](/authorization/errors).

## Other errors

Holo only converts the errors above. Everything else goes through your framework's normal error handling.

One case to know: `findOrFail()` and `firstOrFail()` throw a `ModelNotFoundException` with `statusCode: 404`.

- **Nuxt** reads `statusCode` from thrown errors, so a missing record becomes a `404`.
- **Next.js** and **SvelteKit** treat it as an unexpected error and respond with `500`.

::: warning
In Next.js and SvelteKit API routes, use `first()` or `find()` and return a `404` yourself, as in the example at the top of this page. Use `findOrFail()` only where a `500` is acceptable, or catch the error.
:::

## Reporting errors

Some failures happen after Holo has already answered, or inside background work, so they never reach your framework's error handling. Holo catches these, keeps the request or job running, and reports them. Examples are a queue `onCompleted` hook that throws, a cache refresh that fails in the background, or a broadcast socket that sends a malformed message.

By default, each report is written to `console.error`. To send reports to Sentry, OpenTelemetry, or your own logger, add `exceptions.report` to `config/app.ts`:

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'
import * as Sentry from '@sentry/node'
import { PaymentDeclinedError } from '../server/errors'

export default defineAppConfig({
  name: env('APP_NAME', 'Blog'),
  exceptions: {
    report(error, { capability, operation }) {
      Sentry.captureException(error, { tags: { capability, operation } })
    },
    dontReport: [PaymentDeclinedError],
  },
})
```

`report` receives the original error and where it happened:

| `capability` | `operation` |
|---|---|
| `app` | `report` (your own `report()` calls) |
| `queue` | `job.onCompleted`, `job.onFailed`, `dispatch.onComplete`, `dispatch.onFailed`, `worker.onJobProcessed`, `worker.onJobReleased`, `worker.onJobFailed` |
| `auth` | `passwordReset.clearReservation`, `multiFactor.clearRateLimit`, `multiFactor.clearEnrollment`, `next.resolveState`, `sveltekit.resolveState` |
| `cache` | `flexible.refresh`, `driver.dispose`, `driver.disconnect` |
| `db` | `cache.invalidationListener` |
| `broadcast` | `worker.socketMessage`, `worker.scalingMessage`, `worker.socketCleanup`, `worker.realtimeSubscriptionCleanup` |

`report` can be `async`. Holo doesn't wait for it, and a reporter that throws or rejects never breaks the request or job. Holo writes the original error and the reporter's error to `console.error` instead.

Errors that are instances of a class in `dontReport` are skipped, including subclasses.

To report an error you handled yourself, call [`report()`](#report).

## Errors on the client

When a submission from [`useForm()`](/basics/forms/client) fails with an HTTP error other than `422`, such as a `403` from `authorize()`, Holo replaces the page with a minimal error screen that shows the status and message. Field errors from a `422` stay in the form instead.

In Next.js, the error is also rethrown while rendering, so your `error.tsx`, `not-found.tsx`, or `forbidden.tsx` boundary can take over.

## Available functions

**Helpers**

- [isHoloHttpErrorStatus()](#isholohttperrorstatus)
- [normalizeHoloHttpError()](#normalizeholohttperror)
- [report()](#report)

**Error classes**

- [SecurityCsrfError](#securitycsrferror)
- [SecurityRateLimitError](#securityratelimiterror)

### isHoloHttpErrorStatus() {#isholohttperrorstatus}

Returns `true` when a number is an HTTP status Holo knows how to handle, such as `404` or `429`. Import it from `@holo-js/core/errors`.

```ts
import { isHoloHttpErrorStatus } from '@holo-js/core/errors'

isHoloHttpErrorStatus(404) // true
isHoloHttpErrorStatus(399) // false
```

### normalizeHoloHttpError() {#normalizeholohttperror}

Reads an error object and returns its `status`, `message`, and optional `code`, or `undefined` when the value isn't an HTTP error. Import it from `@holo-js/core/errors`.

```ts
import { normalizeHoloHttpError } from '@holo-js/core/errors'

export async function POST(request: Request) {
  try {
    return Response.json(await Post.create(await request.json()), { status: 201 })
  } catch (error) {
    const httpError = normalizeHoloHttpError(error)
    if (!httpError) throw error

    return Response.json({ message: httpError.message }, { status: httpError.status })
  }
}
```

### report() {#report}

Sends an error to the reporter in `config/app.ts` with `{ capability: 'app', operation: 'report' }`, and keeps your code running. It respects `dontReport` and writes to `console.error` when no reporter is configured. Import it from `@holo-js/core`.

```ts
import { report } from '@holo-js/core'

export async function POST(request: Request) {
  const order = await Order.create(await request.json())

  try {
    await sendReceipt(order)
  } catch (error) {
    report(error)
  }

  return Response.json(order, { status: 201 })
}
```

### SecurityCsrfError {#securitycsrferror}

Thrown when a CSRF check fails. It has `status: 419`. See [CSRF protection](/basics/security/csrf).

### SecurityRateLimitError {#securityratelimiterror}

Thrown when a rate limit is exceeded. It has `status: 429`, `retryAfterSeconds`, and `snapshot`. See [rate limiting](/basics/security/rate-limiting).

## Next steps

- [Validation error messages](/basics/validation/errors)
- [Denied responses (403 vs 404)](/authorization/errors)
- [Rate limiting](/basics/security/rate-limiting)
- [CSRF protection](/basics/security/csrf)
