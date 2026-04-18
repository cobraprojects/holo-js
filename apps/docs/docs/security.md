# Security

`@holo-js/security` is the optional package for CSRF protection and rate limiting.

Install it only when the app needs browser form protection or named request throttles:

```bash
bunx holo install security
```

That writes `config/security.ts`, adds `@holo-js/security`, and lets core boot the package lazily only when
it is installed.

## What the package owns

- CSRF token helpers for server-rendered forms and browser clients
- request protection for plain routes with `protect(...)`
- named rate limiters with `limit.perMinute(...)` and `limit.perHour(...)`
- low-level `rateLimit(...)` and `clearRateLimit(...)` helpers
- optional integration with `@holo-js/forms` through `validate(..., { csrf, throttle })` and
  `useForm(..., { csrf: true })`

`throttle` stays server-only. The browser never meaningfully enforces the rate limit.

## Configuration

`config/security.ts` is the single config entrypoint:

```ts
import { defineSecurityConfig, ip, limit } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
    field: '_token',
    header: 'X-CSRF-TOKEN',
    cookie: 'XSRF-TOKEN',
    except: [
      '/webhooks/*',
    ],
  },
  rateLimit: {
    driver: 'file',
    file: {
      path: './storage/framework/rate-limits',
    },
    redis: {
      connection: 'default',
      prefix: 'holo:rate-limit:',
    },
    limiters: {
      login: limit.perMinute(5).by(({ request, values }) => {
        const email = typeof values?.email === 'string' ? values.email.toLowerCase() : 'guest'
        return `${ip(request)}:${email}`
      }),
      register: limit.perHour(10).by(({ request }) => ip(request)),
      api: limit.perMinute(60).by(({ request }) => ip(request)),
    },
  },
})
```

### Config rules

- `csrf.enabled` controls the default CSRF behavior for route protection.
- `csrf.field` is the hidden form field name for normal form posts.
- `csrf.header` is the header accepted for XHR and `fetch` requests.
- `csrf.cookie` stores the signed token cookie that `useForm(..., { csrf: true })` reads on the client.
- `csrf.except` skips CSRF verification for matching paths such as webhooks.
- `rateLimit.driver` must be `memory`, `file`, or `redis`.
- `rateLimit.limiters` is the named limiter registry used by `validate(...)`, `protect(...)`, and
  `rateLimit(...)`.

## Forms

When `@holo-js/forms` is installed, forms can opt into security directly through `validate(...)`.

### Login

```ts
import { field, schema, validate } from '@holo-js/forms'
import { login } from '@holo-js/auth'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.string().required().min(8),
})

export async function POST(request: Request) {
  const submission = await validate(request, loginForm, {
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  await login(submission.data)

  return Response.json(submission.success({
    message: 'Logged in.',
  }))
}
```

### Register

```ts
import { field, schema, validate } from '@holo-js/forms'
import { register } from '@holo-js/auth'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.string().required().min(8).confirmed(),
  passwordConfirmation: field.string().required(),
})

export async function POST(request: Request) {
  const submission = await validate(request, registerUser, {
    csrf: true,
    throttle: 'register',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  await register(submission.data)

  return Response.json(submission.success({
    message: 'Account created.',
  }))
}
```

### Failure statuses

- validation failures return `422`
- CSRF failures return `419`
- rate-limit failures return `429`

`submission.fail()` preserves that status:

```ts
return Response.json(submission.fail(), {
  status: submission.fail().status,
})
```

### `useForm(...)`

`useForm(...)` only gets one security option:

```ts
const form = useForm(registerUser, {
  validateOn: 'blur',
  csrf: true,
  initialValues: {
    name: '',
    email: '',
    password: '',
    passwordConfirmation: '',
  },
  async submitter({ formData }) {
    return await $fetch('/api/register', {
      method: 'POST',
      body: formData,
    })
  },
})
```

`csrf: true` tells the client helper to read the CSRF cookie and attach the hidden field to outgoing
`FormData` for unsafe methods. The actual protection still happens on the server when `validate(...)`
or `protect(...)` verifies the token.

Do not put `throttle` on `useForm(...)`. Throttling is enforced on the server through
`validate(request, schema, { throttle: 'name' })` or `protect(request, { throttle: 'name' })`.

If the browser should use custom CSRF field or cookie names instead of the defaults (`_token` and
`XSRF-TOKEN`), configure the browser helper explicitly:

```ts
import { configureSecurityClient } from '@holo-js/security/client'

configureSecurityClient({
  config: {
    csrf: {
      field: '_csrf',
      cookie: 'csrf-token',
    },
  },
})
```

## CSRF helpers

Use the CSRF helpers directly when you are not going through `validate(...)`.

### Server-rendered hidden field

```ts
import { csrf } from '@holo-js/security'

const field = await csrf.field(request)
```

`field` has the shape:

```ts
{
  name: '_token',
  value: '...',
}
```

### Setting the readable cookie

`useForm(..., { csrf: true })` needs the CSRF cookie to already exist:

```ts
import { csrf } from '@holo-js/security'

export async function GET(request: Request) {
  return new Response('<html>...</html>', {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': await csrf.cookie(request),
    },
  })
}
```

### Route protection without forms

```ts
import { protect } from '@holo-js/security'

export async function POST(request: Request) {
  await protect(request, {
    csrf: true,
    throttle: 'api',
  })

  return Response.json({ ok: true })
}
```

## Rate limiting

Named limiters are the normal path:

```ts
import { defineSecurityConfig, ip, limit } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'file',
    limiters: {
      login: limit.perMinute(5).by(({ request, values }) => {
        return `${ip(request)}:${String(values?.email ?? 'guest')}`
      }),
      register: limit.perHour(10).by(({ request }) => ip(request)),
    },
  },
})
```

### Plain routes and actions

```ts
await protect(request, {
  throttle: 'api',
})
```

### Arbitrary methods

Use the low-level helper when the code is not going through `validate(...)` or `protect(...)`:

```ts
import { rateLimit } from '@holo-js/security'

await rateLimit('login', { request })
```

Or use an explicit key when there is no `Request`:

```ts
await rateLimit('send-invite', {
  key: `team:${teamId}:user:${userId}`,
})
```

### Clearing counters

Programmatic helper:

```ts
import { clearRateLimit } from '@holo-js/security'

await clearRateLimit({ limiter: 'login', key: '203.0.113.7:ava@example.com' })
await clearRateLimit({ limiter: 'login' })
await clearRateLimit({ all: true })
```

CLI helper:

```bash
bunx holo rate-limit:clear --limiter login --key "203.0.113.7:ava@example.com"
bunx holo rate-limit:clear --limiter login
bunx holo rate-limit:clear --all
```

## Driver persistence

| Driver | Persists after reload | Works across multiple app instances | CLI clear story |
|---|---|---|---|
| `memory` | No | No | Not meaningful from the CLI because the counters live in the app process |
| `file` | Yes, on the same machine | No | Supports key, limiter, and `--all` clears |
| `redis` | Yes | Yes | Supports key, limiter, and `--all` clears through the Redis adapter |

Use `memory` for local development and tests. Use `file` when one machine needs persistence across restarts.
Use `redis` when the app runs on multiple instances or when rate-limit state must survive deploys and reloads.

## Nuxt request handling

Security-aware `validate(...)` calls need a real web `Request`. In Nuxt, build one from the event when you
want CSRF or throttling:

```ts
import { defineEventHandler, getHeaders, getRequestURL, readRawBody } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.string().required().min(8),
})

export default defineEventHandler(async (event) => {
  const request = new Request(getRequestURL(event), {
    method: event.method,
    headers: getHeaders(event),
    body: await readRawBody(event) ?? undefined,
  })

  const submission = await validate(request, loginForm, {
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  return submission.success({
    message: 'Logged in.',
  })
})
```

If you pass only a plain body object, validation still works, but CSRF and request-based limiter keys cannot.

## Typing

The public API is fully typed and normal usage should infer everything without manual generics.

Examples:

- `defineSecurityConfig(...)` infers `memory`, `file`, and `redis` driver config correctly
- limiter callbacks infer `request` and `values`
- `validate(request, schema, { csrf, throttle })` keeps the schema-derived success and failure types
- `useForm(schema, { csrf: true })` keeps field, value, and error inference
- public contracts such as `SecurityRateLimitStore`, `SecurityRateLimitHitResult`, and
  `SecurityRateLimitRedisDriverAdapter` are exported when you need explicit annotations

## Optional package behavior

Security stays optional:

- install it with `bunx holo install security`
- include it during project creation only if the app needs it
- apps that do not install it do not pay dependency or runtime cost
- `@holo-js/forms` loads it lazily only when security-aware options are actually used

If code uses `validate(..., { csrf, throttle })` or `useForm(..., { csrf: true })` without the package
installed, Holo throws a targeted error instead of silently pretending the route is protected.
