# Validation

`@holo-js/validation` is a framework-neutral package for schema validation and input parsing.

Every schema and field builder implements [Standard Schema V1](https://standardschema.dev), so they work
natively with SvelteKit remote functions, tRPC, TanStack Form, Hono, and any other tool that accepts
Standard Schema.

Use it when you need:

- schema definition with a fluent builder API
- request, `FormData`, query, or plain-object parsing
- typed coercion
- normalized error bags
- Standard Schema interop with third-party tools
- validation outside form submissions, such as JSON APIs, CLI input, or auth internals

If you are building a normal application form, install [`@holo-js/forms`](/forms/) as well. Validation is
the lower-level engine.

## What validation owns

`@holo-js/validation` owns:

- `schema(...)`
- `field.*(...)`
- `validate(...)`
- `safeParse(...)`
- `parse(...)`
- error bag creation and flattening
- Standard Schema V1 conformance on all schemas and field builders
- web-native input parsing for `Request`, `FormData`, `URLSearchParams`, and plain objects

It does not own:

- server submission helpers like `submission.fail()` and `submission.success(...)`
- client form state like `useForm(...)`

Those belong to `@holo-js/forms` and adapter packages.

## Quick start

```ts
// lib/schemas/session.ts
import { field, schema, validate } from '@holo-js/validation'

const createSession = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
  remember: field.boolean().default(false),
})

const data = await validate({
  email: 'ava@example.com',
  password: 'super-secret',
}, createSession)

data.email
data.remember
```

`validate(...)` returns the inferred data when valid. When invalid, it throws a `ValidationException`
with a 422 status, a default error bag, sanitized submitted values, and field messages.

Use `safeParse(...)` when you need a non-throwing result object with `valid`, `data`, `values`, and
`errors`.

## Standard Schema V1

Every `schema(...)` and `field.*()` builder carries a `'~standard'` property that satisfies the
Standard Schema V1 spec. This means you can pass them directly to any tool that accepts Standard Schema:

```ts
// lib/schemas/post.ts
import { field, schema } from '@holo-js/validation'

// Object schema — works with SvelteKit form(), tRPC, TanStack Form, etc.
export const createPost = schema({
  title: field.string().required().min(3),
  content: field.string().required(),
})

// Single field — works with SvelteKit query(), command(), etc.
export const postSlug = field.string().required().min(1)
```

Both `createPost` and `postSlug` are valid Standard Schema objects. No wrappers or adapters needed.

## Request parsing

Validation accepts web-native inputs directly:

```ts
// server/api/avatar.ts
import { field, schema, validate } from '@holo-js/validation'

const uploadAvatar = schema({
  userId: field.string().required().uuid(),
  avatar: field.file().required().image().maxSize('2mb'),
})

export async function POST(request: Request) {
  const data = await validate(request, uploadAvatar)

  return Response.json({
    ok: true,
    userId: data.userId,
  })
}
```

That same schema can also validate a plain object or `FormData`. Holo framework adapters serialize
validation exceptions into the same 422 error-bag shape for the host framework.

## JSON API validation without forms

Use validation directly when there is no form workflow:

```ts
// server/api/profile.ts
import { field, schema, validate } from '@holo-js/validation'

const updateProfile = schema({
  displayName: field.string().required().min(3).max(80),
  timezone: field.string().required(),
  birthday: field.date().nullable().beforeOrToday(),
})

export async function PATCH(request: Request) {
  const body = await request.json()
  const data = await validate(body, updateProfile)

  return Response.json({
    ok: true,
    profile: data,
  })
}
```

Use `validate(...)` when invalid input should become a validation error. Use `safeParse(...)` when you
want to inspect errors without throwing. `parse(...)` is the lower-level strict parser that throws a
contract error instead of a validation exception.

## Rules, errors, and next steps

- [Rules and Errors](/validation/rules-and-errors)
- [Forms Overview](/forms/)
- [Server Validation](/forms/server-validation)
