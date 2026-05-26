# Security

`@holo-js/security` is the optional package for CSRF protection, CORS, and rate limiting.

Install it only when the app needs browser form protection or named request throttles:

```bash
npx holo install security
```

That writes `config/security.ts` and `config/cors.ts`, adds `@holo-js/security`, and lets core boot the package lazily only when
it is installed.

## What the package owns

- CSRF token helpers for server-rendered forms and browser clients
- CORS headers for separate frontend/API deployments
- request protection for unsafe HTTP methods through framework middleware
- route-level protection for plain routes with `protect(...)`
- named rate limiters with `limit.perMinute(...)` and `limit.perHour(...)`
- low-level `rateLimit(...)` and `clearRateLimit(...)` helpers
- optional integration with `@holo-js/forms` for named request throttles

`throttle` stays server-only. The browser never meaningfully enforces the rate limit.

## Configuration

Security uses separate config entrypoints: cross-origin rules live in `config/cors.ts`, while CSRF and rate limit settings live in
`config/security.ts`:

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

`config/cors.ts` controls cross-origin API access:

```ts
import { defineCorsConfig, env } from '@holo-js/config'

export default defineCorsConfig({
  paths: ['/api/*', '/broadcasting/auth'],
  origins: [
    env('FRONTEND_URL', 'http://localhost:3000'),
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  headers: ['Content-Type', 'Authorization', 'X-CSRF-TOKEN', 'X-Requested-With'],
  credentials: true,
  maxAge: 7200,
  statefulDomains: [
    env('FRONTEND_DOMAIN', 'localhost:3000'),
  ],
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
- `csrf.cookie` stores the signed readable token cookie that browser clients and native forms submit back.
- `csrf.except` skips CSRF verification for matching paths such as webhooks.
- `cors.origins` lists frontend origins allowed to call the API.
- `cors.credentials` must be true when the frontend uses cookie-backed auth with `fetch(..., { credentials: 'include' })`.
- `cors.statefulDomains` lists browser hosts that should be treated as first-party cookie clients.
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

CSRF is enforced by middleware before route handlers run. Form validation does not opt into CSRF; it only
validates field data after the request passes the middleware.

Validation failures, CSRF failures, and auth failures stay separate:

- `csrfProtection()` verifies unsafe requests before route handlers run and returns `419` on token mismatch.
- `validate(...)` returns form validation failures such as missing fields, bad formats, and throttling.
- `login(...)`, `register(...)`, `verifyEmail(...)`, `requestPasswordReset(...)`, and `resetPassword(...)` return auth failures in `error`.
- Auth failures are plain data with `status` and `fields`, so routes can forward them directly into the normal form response shape.

### Login

```ts
import { field, schema, validate } from '@holo-js/forms'
import { login } from '@holo-js/auth'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export async function POST(request: Request) {
  const submission = await validate(request, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await login(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

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
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export async function POST(request: Request) {
  const submission = await validate(request, registerUser, {
    throttle: 'register',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await register(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: 'Account created.',
  }))
}
```

### Failure statuses

- validation failures return `422`
- CSRF middleware failures return `419`
- rate-limit failures return `429`

`submission.fail()` preserves that status:

```ts
return Response.json(submission.fail(), {
  status: submission.fail().status,
})
```

### `useForm(...)`

When `@holo-js/security` is installed and its CSRF cookie exists, `useForm(...)` automatically attaches
the CSRF field to unsafe `FormData` submissions. No CSRF option is needed:

```ts
const form = useForm(registerUser, {
  validateOn: 'blur',
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

The actual protection happens in the framework middleware before route code runs. The middleware also
passes the configured CSRF field and cookie names to browser helpers, so `config/security.ts` stays the
only source of truth.

Do not put `throttle` on `useForm(...)`. Throttling is enforced on the server through
`validate(request, schema, { throttle: 'name' })` or `protect(request, { throttle: 'name' })`.

## CSRF helpers

Use CSRF helpers when rendering native server forms or building custom request handling. The framework
middleware remains the normal verification path.

### Server-rendered hidden field

```ts
import { csrf } from '@holo-js/security'

const input = await csrf.input(request)
```

`input` has the shape:

```ts
{
  type: 'hidden',
  name: '_token',
  value: '...',
}
```

### Global CSRF middleware

Framework middleware issues the readable CSRF cookie on safe requests and verifies unsafe requests before
route actions run. Generated apps wire this globally. If you wire it manually, use the framework entrypoint:

::: code-group

```ts [Next.js — proxy.ts]
export { csrfProtection as proxy } from '@holo-js/security/next/server'
```

```ts [Nuxt — server/middleware/csrf.ts]
export { csrfProtection as default } from '@holo-js/security/nuxt/server'
```

```ts [SvelteKit — src/hooks.server.ts]
import { sequence } from '@sveltejs/kit/hooks'
import { csrfProtection } from '@holo-js/security/sveltekit/server'

export const handle = sequence(
  csrfProtection(),
)
```

:::

`csrfProtection()` respects `security.csrf.except`, so webhook paths can opt out from verification.

Use `csrf.cookie(request)` directly only for custom server-rendered HTML outside framework middleware.

### Route protection without framework middleware

```ts
import { protect } from '@holo-js/security'

export async function POST(request: Request) {
  await protect(request, {
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
npx holo rate-limit:clear --limiter api --key "user:42"
npx holo rate-limit:clear --limiter api --key "ip:203.0.113.7"
npx holo rate-limit:clear --limiter login
npx holo rate-limit:clear --all
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

Throttle-aware `validate(...)` calls need a real web `Request` or request-like event. In Nuxt, pass the h3
event directly when you want request-based limiter keys:

```ts
import { defineEventHandler } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export default defineEventHandler(async (event) => {
  const submission = await validate(event, loginForm, {
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

If you pass only a plain body object, validation still works, but request-based limiter keys cannot be generated.

## Typing

The public API is fully typed and normal usage should infer everything without manual generics.

Examples:

- `defineSecurityConfig(...)` infers `memory`, `file`, and `redis` driver config correctly
- limiter callbacks infer `request` and `values`
- `validate(requestOrEvent, schema, { throttle })` keeps the schema-derived success and failure types
- `useForm(schema)` keeps field, value, and error inference while client CSRF attachment stays automatic
- public contracts such as `SecurityRateLimitStore`, `SecurityRateLimitHitResult`, and
  `SecurityRateLimitRedisDriverAdapter` are exported when you need explicit annotations

## Optional package behavior

Security stays optional:

- install it with `npx holo install security`
- include it during project creation only if the app needs it
- apps that do not install it do not pay dependency or runtime cost
- `@holo-js/forms` loads it lazily only when server throttling or browser CSRF attachment is actually used

If code uses `validate(..., { throttle })` without the package installed, Holo throws a targeted error
instead of silently pretending the route is rate-limited.
