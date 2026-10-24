# Handling Submissions

On the server, a form submission is validated with `validate()` or `safeParse()` from `@holo-js/forms`. They work like the [validation](/basics/validation/) functions, but also accept framework request objects and can rate-limit the submission.

## Validate a submission

`validate()` returns the typed data, or throws a `ValidationException` that Holo turns into a [422 response](/basics/validation/errors#the-422-response).

::: code-group

```ts [Next.js]
// app/api/posts/route.ts
import { validate } from '@holo-js/forms'
import { postForm } from '@/lib/schemas/post'
import Post from '@/server/models/Post'

export async function POST(request: Request) {
  const data = await validate(request, postForm)
  const post = await Post.create(data)

  return Response.json({ ok: true, status: 201, data: { id: post.id } }, { status: 201 })
}
```

```ts [Nuxt]
// server/api/posts.post.ts
import { validate } from '@holo-js/forms'
import { postForm } from '#shared/schemas/post'
import Post from '../models/Post'

export default defineEventHandler(async (event) => {
  const data = await validate(event, postForm)
  const post = await Post.create(data)

  setResponseStatus(event, 201)
  return { ok: true, status: 201, data: { id: post.id } }
})
```

```ts [SvelteKit]
// src/routes/posts/new/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'
import { postForm } from '#lib/schemas/post.js'
import Post from '../../../../server/models/Post'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, postForm)
    await Post.create(data)

    redirect(303, '/posts')
  },
} satisfies Actions
```

:::

`validate()` accepts:

- a web `Request` (Next.js route handlers, SvelteKit)
- a Nuxt/h3 `event`
- `FormData` (Next.js server actions, or after `readFormData(event)` in Nuxt)
- `URLSearchParams` or a plain object

## Return a success payload

`useForm()` treats any JSON response shaped like `{ ok: true, status, data }` as a success and stores it in `form.lastSubmission`:

```json
{ "ok": true, "status": 201, "data": { "id": 42 } }
```

A `204` response, or any successful non-JSON response, also counts as success. Redirects work too: see [Framework Recipes](/basics/forms/frameworks).

## Handle failures yourself

Use `safeParse()` when you want to inspect the result instead of throwing. It returns a submission object:

```ts [app/api/newsletter/route.ts]
import { safeParse } from '@holo-js/forms'
import { newsletterForm } from '@/lib/schemas/newsletter'
import Subscriber from '@/server/models/Subscriber'

export async function POST(request: Request) {
  const submission = await safeParse(request, newsletterForm)

  if (!submission.valid) {
    const failure = submission.fail()
    return Response.json(failure, { status: failure.status })
  }

  if (await Subscriber.where('email', submission.data.email).first()) {
    const failure = submission.fail({
      status: 409,
      errors: { email: ['You are already subscribed.'] },
    })
    return Response.json(failure, { status: failure.status })
  }

  await Subscriber.create(submission.data)

  return Response.json(submission.success({ subscribed: true }, 201), { status: 201 })
}
```

| Property or method | What it gives you |
|---|---|
| `valid` | `true` if every rule passed |
| `submitted` | Always `true`. It tells a serialized submission apart from other payloads. |
| `data` | The typed, validated data (only when `valid` is `true`) |
| `values` | The submitted values after type conversion |
| `errors` | The [error bag](/basics/validation/errors#read-errors) |
| `fail(status?)` / `fail({ status, errors })` | A failure payload. Defaults to status 422. `errors` adds to or replaces field messages. |
| `success(data?, status?)` | `{ ok: true, status, data }`. Defaults to status 200. |
| `serialize()` | `{ valid, submitted, values, errors }`, useful as `initialState` for `useForm()` |

The failure payload has the same shape as the 422 response, without `message` and `bag`:

```json
{
  "ok": false,
  "status": 422,
  "valid": false,
  "values": { "email": "ava@example" },
  "errors": { "email": ["This field must be a valid email address."] }
}
```

`fail()` and `serialize()` leave out uploaded files and [sensitive fields](/basics/validation/rules#sensitive), such as passwords, so they aren't sent back to the browser.

## Add a business-rule error

When the input is valid but something else is wrong, throw `ValidationException.withMessages()` to attach an error to a field. The user sees it exactly like a validation error:

```ts [src/routes/account/+page.server.ts]
import { validate } from '@holo-js/forms'
import { ValidationException } from '@holo-js/validation'
import { changeEmailForm } from '#lib/schemas/account.js'
import User from '../../../server/models/User'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, changeEmailForm)

    if (await User.where('email', data.email).first()) {
      throw ValidationException.withMessages({
        email: ['This email is already in use.'],
      })
    }

    return { ok: true }
  },
} satisfies Actions
```

## Rate-limit a form

Pass `throttle` with the name of a limiter from `config/security.ts` to stop repeated submissions, such as login attempts. This requires [`@holo-js/security`](/basics/security/).

```ts [config/security.ts]
import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    limiters: {
      login: limit.perMinute(5).define(),
    },
  },
})
```

```ts [app/api/login/route.ts]
import { validate } from '@holo-js/forms'
import { loginForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const data = await validate(request, loginForm, { throttle: 'login' })

  return Response.json({ ok: true, status: 200, data: { email: data.email } })
}
```

`safeParse()` takes the same `throttle` option. The Rate Limiting page covers the limiter itself.

When the limit is hit, the submission fails with status 429. The message goes in the `_root` error, and the payload includes `retryAfterSeconds` and `retryAt` so you can tell the user when to try again. Route handlers also send a `Retry-After` header.

`throttle` needs to know who is submitting, so pass a `Request`, a Nuxt `event`, or (in a Next.js server action) the `FormData`. A plain object throws an error. See [Rate Limiting](/basics/security/rate-limiting) for limiter options. Each submission is validated first, then counted, valid or not. A `.by()` key resolver that reads `values` gets the values after the schema's transforms, so trimmed or lowercased variants share one limit. For a submission that fails validation, `values` is `undefined`, so the resolver must return a non-empty string for every request. A limiter without a `.by()` resolver uses the default request key.

::: info
CSRF checks are not a `validate()` option. Holo's security middleware verifies the token before your handler runs. See [CSRF Protection](/basics/security/csrf).
:::

## Validate uploads

File inputs arrive in multipart `FormData`. Use `field.file()`:

```ts [lib/schemas/avatar.ts]
import { field, schema } from '@holo-js/validation'

export const avatarForm = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})
```

```ts [server/routes/account/avatar.post.ts]
import { readFormData } from 'h3'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { avatarForm } from '#shared/schemas/avatar'

export default defineEventHandler(async (event) => {
  const data = await validate(await readFormData(event), avatarForm)
  const user = await auth.user()

  await user?.addMedia(data.avatar).toMediaCollection('avatars')

  return sendRedirect(event, '/account', 303)
})
```

An empty file input is treated as missing, so `field.file().optional()` passes when the user doesn't pick a file. See the [Media Library](/media/) for storing uploads.

## Use a named error bag

Pass `bag` when a page has more than one form, so each form only shows its own errors:

```ts
const data = await validate(request, passwordForm, { bag: 'password' })
```

Read it on the page with `useValidationErrors('password')`. See [Error bags](/basics/validation/errors#error-bags).

## Helpers reference

| Helper | Use it for |
|---|---|
| `validate(input, schema, options?)` | Get typed data or throw a `ValidationException`. `options.throttle` applies a rate limit, and `options.bag` names the error bag. |
| `safeParse(input, schema, options?)` | Get a submission object without throwing. `options.throttle` applies a rate limit. |
| `sanitizeFlashedInput(values, schema?)` | Copy `values` without uploaded files, password fields, and the [sensitive](/basics/validation/rules#sensitive) fields of `schema`, including inside nested objects and arrays. Use it before you store submitted values in a session or cookie. |
| `FormContractError` | Error class for misuse of these helpers. It is thrown when `fail()` or `success()` gets a status below 100 or a non-integer, when `throttle` is used with input that isn't a request, or when `@holo-js/security` is not installed. |

A submission object has these members:

| Member | Type | Notes |
|---|---|---|
| `valid` | `boolean` | Narrows `data` to a value when `true` |
| `submitted` | `true` | Always set |
| `data` | `TData` or `undefined` | Validated output, only when `valid` is `true` |
| `values` | `Partial<TData>` or `TData` | Converted input. Sensitive fields are removed by `fail()` and `serialize()`. |
| `errors` | error bag | Has `has()`, `first()`, `get()`, `flatten()`, and `toJSON()` |
| `fail(status?)` / `fail({ status?, errors? })` | function | Returns a failure payload. Each field in `errors` replaces that field's messages. Other fields keep theirs. |
| `success(payload?, status?)` | function | Returns `{ ok: true, status, data }`. Status defaults to 200. |
| `serialize()` | function | Returns `{ valid, submitted, values, errors }` with sensitive fields removed |

## Next steps

- [Client-Side Forms](/basics/forms/client)
- [Framework Recipes](/basics/forms/frameworks)
- [Error Messages](/basics/validation/errors)
- [Rate Limiting](/basics/security/rate-limiting)
