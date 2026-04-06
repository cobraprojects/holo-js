# Forms

`@holo-js/forms` is an optional package for apps that want Holo-managed form workflows.

Use forms when you want one shared schema to drive:

- server validation
- typed success and failure payloads
- preserved values on failure
- client form state with `useForm(...)`
- adapter-native helpers for Nuxt, Next.js, and SvelteKit

Validation remains the engine underneath. Install forms when you want Holo to own the submission and client
form workflow.

## The forms-first workflow

1. Define one shared schema.
2. Validate on the server by default.
3. Return errors and values through a typed submission object.
4. Optionally reuse the same schema on the client for blur or change validation.

```ts
// lib/schemas/register.ts
import { field, schema } from '@holo-js/forms'

export const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.string().required().min(8).confirmed(),
  passwordConfirmation: field.string().required(),
  avatar: field.file().optional().image().maxSize('2mb'),
  newsletter: field.boolean().default(false),
})
```

## Standard Schema compatibility

Every schema produced by `@holo-js/forms` implements [Standard Schema V1](https://standardschema.dev).
This means the same schema you use with `useForm(...)` and `validate(...)` also works natively with
SvelteKit remote functions (`form()`, `query()`, `command()`), tRPC, TanStack Form, and any other tool
that accepts Standard Schema. No wrappers or adapters needed.

## Why you would install forms

Forms solve the normal application problem directly:

- validate input
- keep typed values
- keep typed errors
- send a consistent failure payload back to the UI

That is the same workflow a future auth package will need for registration, login, password reset, and
profile updates.

## Package boundaries

- `@holo-js/validation` owns schema parsing, coercion, error normalization, and Standard Schema conformance.
- `@holo-js/forms` owns the submission contract (`fail()`, `success()`, `serialize()`) and client form state.
- All frameworks use the same `validate(...)` function from `@holo-js/forms`.
- SvelteKit users can also pass schemas directly to native `form()`, `query()`, and `command()` remote functions.

## Continue

- [Server Validation](/forms/server-validation)
- [Client Usage](/forms/client-usage)
- [Framework Integration](/forms/framework-integration)
