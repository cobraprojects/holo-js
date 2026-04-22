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
import { defineSecurityConfig, limit } from '@holo-js/security'

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
      connection: 'cache',
      prefix: 'holo:rate-limit:',
    },
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
      api: limit.perMinute(60).define(),
    },
  },
})
```

When `rateLimit.driver` is `redis`, `rateLimit.redis.connection` points to a named connection in
`config/redis.ts`.

Example shared Redis config:

```ts
import { defineRedisConfig, env } from '@holo-js/config'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      username: env('REDIS_USERNAME'),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
  },
})
```

Shared Redis connections resolve in this order:

1. `url`
2. `clusters`
3. `host`

So if `url` is present, it wins. Otherwise cluster mode is used when `clusters` exists. Otherwise
Holo-JS falls back to standalone `host`, which may also be a Unix socket path.

### Config rules

- `csrf.enabled` controls the default CSRF behavior for route protection.
- `csrf.field` is the hidden form field name for normal form posts.
- `csrf.header` is the header accepted for XHR and `fetch` requests.
- `csrf.cookie` stores the signed token cookie that `useForm(..., { csrf: true })` reads on the client.
- `csrf.except` skips CSRF verification for matching paths such as webhooks.
- `rateLimit.driver` must be `memory`, `file`, or `redis`.
- `rateLimit.redis.connection` must reference a named shared Redis connection when `rateLimit.driver` is `redis`.
- `rateLimit.limiters` is the named limiter registry used by `validate(...)`, `protect(...)`, and
  `rateLimit(...)`.
- When a limiter uses `define()` instead of `by(...)`, the package uses its default key strategy.
- The default key is `user:<id>` when the current Holo auth runtime can resolve an authenticated user.
- Otherwise the default key falls back to `ip:<client-ip>` from the incoming request headers.
- The runtime only reads `x-forwarded-for` and `x-real-ip` when `HOLO_SECURITY_TRUST_PROXY` is truthy.
- Without trusted proxy headers, guest requests can fall back to `ip:unknown`, which means multiple
  anonymous clients may share the same limiter bucket and get throttled together.
- If your app sits behind trusted proxies or needs additional identifier scoping, either override the
  limiter key with `by(...)` or enable `HOLO_SECURITY_TRUST_PROXY` for those trusted proxies.

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
import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'file',
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
    },
  },
})
```

`define()` is the default path. It gives you the default framework behavior without repeating a key resolver on
every limiter: authenticated requests use `user:<id>` and guest requests fall back to `ip:<client-ip>`.

### Overriding the default key

Override the key when a limiter needs more than the built-in user-or-IP fallback. A common case is login:
keep the default base key, then add an opaque identifier so one email cannot be hammered across many IPs
and raw email addresses never land in rate-limit storage.

```ts
import { createHmac } from 'node:crypto'
import { defaultRateLimitKey, defineSecurityConfig, limit } from '@holo-js/security'

function getOpaqueKeyFromEmail(email: string): string {
  const appKey = process.env.APP_KEY
  if (!appKey) {
    throw new Error('APP_KEY must be set before deriving opaque rate-limit keys.')
  }

  return createHmac('sha256', appKey)
    .update(email.trim().toLowerCase())
    .digest('hex')
}

export default defineSecurityConfig({
  rateLimit: {
    driver: 'file',
    limiters: {
      login: limit.perMinute(5).by(async ({ request, values }) => {
        const email = typeof values?.email === 'string' ? values.email.toLowerCase() : 'guest'
        return `${await defaultRateLimitKey(request)}:email:${getOpaqueKeyFromEmail(email)}`
      }),
      register: limit.perHour(10).define(),
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

await clearRateLimit({ limiter: 'api', key: 'user:42' })
await clearRateLimit({ limiter: 'api', key: 'ip:203.0.113.7' })
await clearRateLimit({ limiter: 'login' })
await clearRateLimit({ all: true })
```

CLI helper:

```bash
bunx holo rate-limit:clear --limiter api --key "user:42"
bunx holo rate-limit:clear --limiter api --key "ip:203.0.113.7"
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

Security-aware `validate(...)` calls need a real web `Request` or request-like event. In Nuxt, pass the h3
event directly when you want CSRF or throttling:

```ts
import { defineEventHandler } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.string().required().min(8),
})

export default defineEventHandler(async (event) => {
  const submission = await validate(event, loginForm, {
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

If you pass only a plain body object, validation still works, but CSRF and request-based limiter keys cannot be generated.

## Typing

The public API is fully typed and normal usage should infer everything without manual generics.

Examples:

- `defineSecurityConfig(...)` infers `memory`, `file`, and `redis` driver config correctly
- limiter callbacks infer `request` and `values`
- `validate(requestOrEvent, schema, { csrf, throttle })` keeps the schema-derived success and failure types
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
