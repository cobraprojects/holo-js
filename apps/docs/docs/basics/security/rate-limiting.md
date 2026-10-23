# Rate Limiting

Rate limiting caps how often a client can hit a route, such as five login attempts per minute. You define named limiters in `config/security.ts`, then apply them by name in your routes and forms.

## Quick start

Define a limiter:

```ts [config/security.ts]
import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'file',
    limiters: {
      login: limit.perMinute(5).define(),
    },
  },
})
```

Apply it when you validate the form:

```ts [app/api/login/route.ts]
import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
import { login } from '@holo-js/auth'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export async function POST(request: Request) {
  const data = await validate(request, loginForm, {
    throttle: 'login',
  })

  await login(data)

  return Response.json({ ok: true })
}
```

The sixth attempt within a minute gets a `429` response with a `Retry-After` header.

## Define limiters

Use `limit.perMinute(n)` or `limit.perHour(n)`, then finish with `.define()` or `.by(...)`:

```ts [config/security.ts]
import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
      api: limit.perMinute(60).define(),
    },
  },
})
```

For any other window, use `defineRateLimiter` with `maxAttempts` and `decaySeconds`:

```ts [config/security.ts]
import { defineRateLimiter, defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    limiters: {
      passwordReset: defineRateLimiter({
        maxAttempts: 3,
        decaySeconds: 900,
      }),
    },
  },
})
```

Both values must be whole numbers of at least `1`.

## How the window works

A window opens with the first attempt for a key and lasts `decaySeconds`. Every attempt in the window counts, including rejected ones. When the window ends, the next attempt starts a new one.

For a `login` limiter of five attempts per minute:

- At `00:00`, five attempts succeed.
- At `00:30`, the sixth attempt gets a `429` with `Retry-After: 30`.
- At `00:45`, another attempt also gets a `429`, now with `Retry-After: 15`. Rejected attempts don't extend the window.
- At `01:00`, the window has ended. The next attempt counts as the first of a new window.

The `memory`, `file`, and `redis` drivers all follow these rules, so switching drivers doesn't change when a key is limited.

## Who gets counted

Each limiter counts attempts per **key**. With `.define()`, the key is:

- `user:<id>` when a user is signed in through [Holo auth](/auth/), or
- `ip:<client-ip>` for guests.

The client IP is the address of the visitor's connection. Behind a load balancer, CDN, or reverse proxy, list your proxies in [`trustedProxies`](/basics/security/cors-and-proxies#trusted-proxies) so each guest is counted separately instead of as the proxy. The key holds the full address, including for IPv6, as in Laravel.

In a Next.js app, Holo can only learn the client IP when `trustedProxies` is `'*'`. Any other value, such as a list of addresses, can't enable IP detection there. Scaffolded apps read it from `TRUSTED_PROXIES`. Until it's `'*'`, a limiter keyed by IP fails with a configuration error instead of counting the visitor. If you don't need the visitor's IP, use a [custom key](#custom-keys) instead. See [Trusted proxies in Next.js](/basics/security/cors-and-proxies#next-js).

### Custom keys

Use `.by(...)` to choose the key yourself. The resolver receives the `request` and, when called from `validate(...)`, the submitted `values`:

```ts [config/security.ts]
import { createHmac } from 'node:crypto'
import { defaultRateLimitKey, defineSecurityConfig, limit } from '@holo-js/security'

function hashEmail(email: string): string {
  const appKey = process.env.APP_KEY
  if (!appKey) {
    throw new Error('APP_KEY must be set to hash rate-limit keys.')
  }

  return createHmac('sha256', appKey)
    .update(email.trim().toLowerCase())
    .digest('hex')
}

export default defineSecurityConfig({
  rateLimit: {
    limiters: {
      login: limit.perMinute(5).by(async ({ request, values }) => {
        const email = typeof values?.email === 'string' ? values.email : 'guest'

        return `${await defaultRateLimitKey(request)}:email:${hashEmail(email)}`
      }),
    },
  },
})
```

This counts attempts per client *and* per email, so one account can't be hammered from many IPs. Hashing keeps raw email addresses out of rate-limit storage.

`defaultRateLimitKey(request)` returns the same `user:<id>` or `ip:<client-ip>` key that `.define()` uses. The resolver must return a non-empty string.

## Throttle form submissions

Pass `throttle` to `validate(...)` or `safeParse(...)` from `@holo-js/forms`. The attempt is counted whether or not validation passes. See [handling submissions](/basics/forms/server).

```ts
const data = await validate(request, loginForm, {
  throttle: 'login',
})
```

When the limit is hit, `validate(...)` throws a validation error with status `429`, a root error message, and `retryAfterSeconds`. Holo turns it into a JSON response like this, with a `Retry-After` header:

```json
{
  "ok": false,
  "status": 429,
  "errors": { "_root": ["Too many attempts. Please try again later."] },
  "retryAfterSeconds": 60
}
```

Throttling needs the request to build a key. In Nuxt, pass the `event`:

```ts [server/api/login.post.ts]
import { defineEventHandler } from 'h3'
import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export default defineEventHandler(async (event) => {
  const data = await validate(event, loginForm, {
    throttle: 'login',
  })

  return { ok: true, email: data.email }
})
```

Don't put `throttle` on client-side `useForm(...)`. Limits are only enforced on the server.

## Protect a route

For routes that don't validate a form, use `protect(...)`. It runs the rate limiter, then the [CSRF check](/basics/security/csrf):

::: code-group

```ts [Next.js]
// app/api/exports/route.ts
import { protect } from '@holo-js/security'

export async function POST(request: Request) {
  await protect(request, {
    throttle: 'api',
  })

  return Response.json({ ok: true })
}
```

```ts [Nuxt]
// server/api/exports.post.ts
import { defineEventHandler, toWebRequest } from 'h3'
import { protect } from '@holo-js/security'

export default defineEventHandler(async (event) => {
  await protect(toWebRequest(event), {
    throttle: 'api',
  })

  return { ok: true }
})
```

```ts [SvelteKit]
// src/routes/api/exports/+server.ts
import { json } from '@sveltejs/kit'
import { protect } from '@holo-js/security'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request }) => {
  await protect(request, {
    throttle: 'api',
  })

  return json({ ok: true })
}
```

:::

Add `csrf: false` to rate-limit without checking CSRF, for example on a token-authenticated API:

```ts
await protect(request, {
  csrf: false,
  throttle: 'api',
})
```

## Rate-limit anything

Call `rateLimit(name, options)` directly in jobs, commands, or services. Pass the `request` to use the limiter's key, or pass your own `key`:

```ts
import { rateLimit } from '@holo-js/security'

await rateLimit('api', { request })

await rateLimit('sendInvite', {
  key: `team:${teamId}:user:${userId}`,
})
```

An explicit `key` always wins over the limiter's resolver. When the limit is exceeded, `rateLimit` throws `SecurityRateLimitError` (`status: 429`). Otherwise it returns the current count:

```ts
const result = await rateLimit('api', { request })

result.snapshot.attempts
result.snapshot.remainingAttempts
result.snapshot.expiresAt
```

Catch the error to respond your own way:

```ts
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'

try {
  await rateLimit('sendInvite', { key: `user:${userId}` })
} catch (error) {
  if (error instanceof SecurityRateLimitError) {
    return Response.json(
      { message: error.message },
      { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds ?? 60) } },
    )
  }

  throw error
}
```

If you don't catch it inside a route handler, Holo converts it into a `429` JSON response with a `Retry-After` header.

## Reset counters

Clear counters from code, for example after a successful login:

```ts
import { clearRateLimit } from '@holo-js/security'

await clearRateLimit({ limiter: 'login', key: 'user:42' })
await clearRateLimit({ limiter: 'login' })
await clearRateLimit({ all: true })
```

Or from the command line:

```bash
npx holo rate-limit:clear --limiter login --key "ip:203.0.113.7"
npx holo rate-limit:clear --limiter login
npx holo rate-limit:clear --all
```

`--limiter` is required unless you pass `--all`. You can't combine `--all` with `--limiter` or `--key`.

## Drivers

Pick where attempt counts are stored with `rateLimit.driver`. The generated config reads it from `RATE_LIMIT_DRIVER`.

| Driver | Survives restarts | Shared across servers | Clear from CLI | Use it for |
|---|---|---|---|---|
| `memory` (default) | No | No | No | Tests and local development |
| `file` | Yes, on the same machine | No | Yes | A single server |
| `redis` | Yes | Yes | Yes | Multiple instances or serverless |

The `memory` driver keeps counts inside the running process, so `holo rate-limit:clear` refuses to run against it. It keeps at most 10,000 keys per process. When it's full, it drops expired keys first. If it is still full, it doesn't evict any live key: new keys are limited (`429`) until a key expires, and Holo reports the full store once, until a slot frees. The memory driver is per-process, so use `redis` or `file` for public, high-cardinality limiters, such as limiters keyed by IP address or email.

[Multi-factor auth](/auth/multi-factor) attempt limits use the same driver. Use `redis` when several app instances must share those limits.

### File driver

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'file',
    file: {
      path: './storage/framework/rate-limits',
    },
  },
})
```

`path` defaults to `./storage/framework/rate-limits`. Keys are hashed before they're written to disk. Each key is one file. While it handles requests, Holo deletes expired files in the background, at most once a minute and a thousand files per step, so rate-limit checks never wait for cleanup. A file for an expired key stays on disk until a later request starts that cleanup.

### Redis driver

The Redis driver uses a named connection from `config/redis.ts` and needs the `ioredis` package:

```bash
npm install ioredis
```

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  rateLimit: {
    driver: 'redis',
    redis: {
      connection: 'cache',
      prefix: 'holo:rate-limit:',
    },
  },
})
```

```ts [config/redis.ts]
import { env } from '@holo-js/config'
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
  },
})
```

`connection` defaults to the `default` connection in `config/redis.ts`. `prefix` defaults to `holo:rate-limit:`. If `config/redis.ts` is missing, startup fails with an error naming the missing connection.

Each key is one Redis string that counts attempts and expires when its window ends. Rejected attempts only increment that counter, so a flood of attempts doesn't grow Redis memory.

## Configuration reference

| Option | Default | Description |
|---|---|---|
| `rateLimit.driver` | `'memory'` | `'memory'`, `'file'`, or `'redis'`. |
| `rateLimit.file.path` | `'./storage/framework/rate-limits'` | Directory for the file driver. |
| `rateLimit.redis.connection` | Redis `default` connection | Connection name from `config/redis.ts`. |
| `rateLimit.redis.prefix` | `'holo:rate-limit:'` | Prefix for Redis keys. |
| `rateLimit.limiters` | `{}` | Named limiters. |

Calling a limiter name that isn't in `limiters` throws an error naming the missing limiter.

## Next steps

- [CORS and trusted proxies](/basics/security/cors-and-proxies)
- [Handling form submissions](/basics/forms/server)
- [Login and registration](/auth/local-auth)
- [CLI commands](/reference/cli)
