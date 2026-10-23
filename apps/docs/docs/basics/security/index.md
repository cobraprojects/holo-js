# Security

`@holo-js/security` adds CSRF protection, CORS headers, and rate limiting to your app. Install it when you accept form posts or cookie-authenticated requests from a browser, or when you need to throttle routes like login and registration.

## Install

```bash
npx holo install security
```

This adds `@holo-js/security` to `package.json` and creates:

- `config/security.ts` — CSRF and rate-limit settings
- `config/cors.ts` — cross-origin rules
- `config/redis.ts` — if it doesn't exist yet, for the Redis rate-limit driver
- `storage/framework/rate-limits/.gitignore` — keeps file-based rate-limit data out of Git
- `RATE_LIMIT_DRIVER=file` in `.env` and `.env.example`

::: tip
If you installed [authentication](/auth/), security is already installed and configured.
:::

## Register the middleware

CSRF checks, CORS headers, and CORS preflight responses all run in one middleware, `csrfProtection()`. Projects created with security enabled already include it. If you installed security later, add it yourself:

::: code-group

```ts [Next.js]
// proxy.ts
import { csrfProtection } from '@holo-js/security/next/server'

export const proxy = csrfProtection()
```

```ts [Nuxt]
// server/middleware/csrf.ts
import { csrfProtection } from '@holo-js/security/nuxt/server'

export default csrfProtection()
```

```ts [SvelteKit]
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks'
import { csrfProtection } from '@holo-js/security/sveltekit/server'

export const handle = sequence(
  csrfProtection(),
)
```

:::

The middleware runs before your route code. On every request it:

1. Answers CORS preflight (`OPTIONS`) requests from allowed origins.
2. Rejects `TRACE` requests with `405 Method Not Allowed`.
3. Verifies the CSRF token on `POST`, `PUT`, `PATCH`, and `DELETE` requests, and returns `419` when it's missing or wrong.
4. Sets the CSRF cookie on `GET` and `HEAD` requests when the browser doesn't have a valid one yet.
5. Adds CORS headers to responses for matching paths.

## Configuration

The generated `config/security.ts` looks like this:

```ts [config/security.ts]
import { defineSecurityConfig, limit } from '@holo-js/security'
import { env } from '@holo-js/config'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
    field: '_token',
    header: 'X-CSRF-TOKEN',
    cookie: 'XSRF-TOKEN',
    except: [],
  },
  rateLimit: {
    driver: env('RATE_LIMIT_DRIVER', 'file'),
    file: {
      path: './storage/framework/rate-limits',
    },
    redis: {
      prefix: 'holo:rate-limit:',
    },
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
    },
  },
})
```

See [CSRF protection](/basics/security/csrf) for the `csrf` block, [rate limiting](/basics/security/rate-limiting) for `rateLimit`, and [CORS and proxies](/basics/security/cors-and-proxies) for `config/cors.ts`.

### Request body limit

`maxBodyBytes` caps every request body Holo reads before it runs your code: CSRF token checks, form validation, social sign-in callbacks, broadcast auth, and Realtime requests. The default is 1 MiB (`1048576`). A request larger than the limit gets a `413` response and is rejected before the body is buffered. The limit is a whole number of bytes:

```ts [config/security.ts]
export default defineSecurityConfig({
  maxBodyBytes: 8 * 1024 * 1024,
})
```

Raise the limit for forms that accept file uploads. Uploads are part of the request body, so a file larger than the limit needs a larger `maxBodyBytes`.

::: warning
The CSRF cookie is encrypted, and signed tokens are signed, with your app key (`key` in `config/app.ts`, usually `APP_KEY` in `.env`). If the key is empty, every protected request fails. Changing the key invalidates all existing tokens.
:::

## Error statuses

| Failure | Status | Where it comes from |
|---|---|---|
| Missing or wrong CSRF token | `419` | `csrfProtection()` middleware or `protect()` |
| Too many attempts | `429` | `rateLimit()`, `protect({ throttle })`, or `validate(..., { throttle })` |
| `TRACE` request | `405` | `csrfProtection()` middleware |

Validation failures (`422`) are separate. See [error responses](/basics/errors).

## Available functions

**Setup**

- [defineSecurityConfig()](#definesecurityconfig)
- [defineCorsConfig()](#definecorsconfig)
- [csrfProtection()](#csrfprotection)
- [default export `security`](#default-export-security)

**CSRF**

<div class="method-list">

- [csrf.token()](#csrf-token)
- [csrf.field()](#csrf-field)
- [csrf.input()](#csrf-input)
- [csrf.cookie()](#csrf-cookie)
- [csrf.verify()](#csrf-verify)
- [protect()](#protect)
- [isSecureRequest()](#issecurerequest)
- [getSecurityClientConfig()](#getsecurityclientconfig)

</div>

**CORS**

- [cors.headers()](#cors-headers)
- [cors.preflight()](#cors-preflight)
- [cors.apply()](#cors-apply)

**Rate limiting**

<div class="method-list">

- [limit.perMinute()](#limit-perminute)
- [limit.perHour()](#limit-perhour)
- [.by()](#by)
- [.define()](#define)
- [defineRateLimiter()](#defineratelimiter)
- [rateLimit()](#ratelimit)
- [clearRateLimit()](#clearratelimit)
- [defaultRateLimitKey()](#defaultratelimitkey)
- [ip()](#ip)

</div>

**Signed tokens and URLs**

- [createSignedToken()](#createsignedtoken)
- [verifySignedToken()](#verifysignedtoken)
- [resolveRequestUrl()](#resolverequesturl)

**Errors**

- [SecurityCsrfError](#securitycsrferror)
- [SecurityRateLimitError](#securityratelimiterror)

### defineSecurityConfig() {#definesecurityconfig}

Wraps `config/security.ts` so its options are typed. Import it from `@holo-js/security` or `@holo-js/security/config`.

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: { enabled: true },
  rateLimit: { driver: 'file' },
})
```

See [configuration reference](/reference/config).

### defineCorsConfig() {#definecorsconfig}

Wraps `config/cors.ts` so its options are typed. Import it from `@holo-js/security` or `@holo-js/security/config`.

```ts [config/cors.ts]
import { defineCorsConfig } from '@holo-js/security'

export default defineCorsConfig({
  paths: ['/api/*'],
  origins: ['https://app.example.com'],
})
```

See [CORS and proxies](/basics/security/cors-and-proxies#options).

### csrfProtection() {#csrfprotection}

Returns the middleware that handles CSRF checks, CORS headers, and CORS preflight for every request. Import it from `@holo-js/security/next/server`, `@holo-js/security/nuxt/server`, or `@holo-js/security/sveltekit/server`. Register it as shown in [Register the middleware](#register-the-middleware).

### default export `security` {#default-export-security}

The default export of `@holo-js/security` is one object that bundles the helpers on this page, such as `csrf`, `cors`, `protect`, `limit`, `rateLimit`, and the signed-token functions. Use the named imports in most code.

```ts
import security from '@holo-js/security'

await security.protect(request)
```

### csrf.token() {#csrf-token}

Returns the CSRF token stored in the request's session.

```ts
const token = await csrf.token(request)
```

See [token helpers](/basics/security/csrf#token-helpers).

### csrf.field() {#csrf-field}

Returns the form field's `name` and `value`.

```ts
const { name, value } = await csrf.field(request)
```

### csrf.input() {#csrf-input}

Returns a hidden input description (`type`, `name`, `value`) that you can render in a form.

```ts
const input = await csrf.input(request)
```

### csrf.cookie() {#csrf-cookie}

Returns the `Set-Cookie` value for the `XSRF-TOKEN` cookie, which holds the session token encrypted. Pass an explicit token as the second argument to encrypt that token instead.

```ts
response.headers.set('Set-Cookie', await csrf.cookie(request))
```

### csrf.verify() {#csrf-verify}

Checks the request's CSRF token and throws `SecurityCsrfError` when it's missing or wrong. It skips safe methods and `except` paths.

```ts
await csrf.verify(request)
```

### protect() {#protect}

Runs the CSRF check and an optional rate limit inside a route. Pass `csrf: true` to force the check, `csrf: false` to skip it, or `throttle: 'login'` to hit a named limiter first.

```ts
await protect(request, { throttle: 'login' })
```

See [Check CSRF inside a route](/basics/security/csrf#check-csrf-inside-a-route).

### isSecureRequest() {#issecurerequest}

Returns `true` when the request's URL uses `https:`.

```ts
const secure = isSecureRequest(request)
```

### getSecurityClientConfig() {#getsecurityclientconfig}

Imported from `@holo-js/security/client`. Returns the CSRF field, header, and cookie names, for browser code that sends the token back.

```ts
import { getSecurityClientConfig } from '@holo-js/security/client'

const { csrf } = getSecurityClientConfig()
```

See [sending the token with fetch](/basics/security/csrf#sending-the-token-with-fetch).

### cors.headers() {#cors-headers}

Returns a `Headers` object with the CORS headers for the request. It's empty when the path isn't in `paths` or the origin isn't allowed.

```ts
const corsHeaders = cors.headers(request)
```

### cors.preflight() {#cors-preflight}

Returns the preflight response for an allowed `OPTIONS` request, or `null` for any other request.

```ts
export async function OPTIONS(request: Request) {
  return cors.preflight(request) ?? new Response(null, { status: 204 })
}
```

### cors.apply() {#cors-apply}

Returns a copy of a response with CORS headers added. Without a response, it returns an empty `204`.

```ts
return cors.apply(request, Response.json({ posts: [] }))
```

### limit.perMinute() {#limit-perminute}

Starts a limiter that allows `maxAttempts` per 60 seconds. Call `.define()` or `.by()` to finish it. `maxAttempts` must be an integer of at least 1.

```ts [config/security.ts]
limiters: {
  login: limit.perMinute(5).define(),
}
```

### limit.perHour() {#limit-perhour}

Starts a limiter that allows `maxAttempts` per 3600 seconds. Finish it with `.define()` or `.by()`.

```ts [config/security.ts]
limiters: {
  register: limit.perHour(10).define(),
}
```

### .by() {#by}

Sets a custom key resolver on a limiter. The resolver gets the `request` and any `values`, and returns the key to count against.

```ts [config/security.ts]
login: limit.perMinute(5).by(({ request }) => defaultRateLimitKey(request)),
```

See [custom keys](/basics/security/rate-limiting#custom-keys).

### .define() {#define}

Finishes a limiter with the default key, which is the signed-in user or the client IP.

```ts [config/security.ts]
login: limit.perMinute(5).define(),
```

### defineRateLimiter() {#defineratelimiter}

Builds a limiter from `maxAttempts`, `decaySeconds`, and an optional `key` resolver. Use it when you need a window other than a minute or an hour.

```ts [config/security.ts]
passwordReset: defineRateLimiter({ maxAttempts: 3, decaySeconds: 900 }),
```

See [rate limiting](/basics/security/rate-limiting#define-limiters).

### rateLimit() {#ratelimit}

Counts one attempt for a named limiter. Pass `request` to use the limiter's key, or `key` to set your own. It returns the hit result with `snapshot.attempts` and `snapshot.remainingAttempts`, and throws `SecurityRateLimitError` when the limit is exceeded.

```ts
const result = await rateLimit('api', { request })
```

See [rate-limit anything](/basics/security/rate-limiting#rate-limit-anything).

### clearRateLimit() {#clearratelimit}

Resets counters. Pass `{ limiter, key }` to reset one key, `{ limiter }` to reset every key for a limiter, or `{ all: true }` to reset everything. It returns a count, or a boolean when you clear a single key.

```ts
await clearRateLimit({ limiter: 'login', key: `user:${userId}` })
```

See [reset counters](/basics/security/rate-limiting#reset-counters).

### defaultRateLimitKey() {#defaultratelimitkey}

Returns the key a limiter uses when you don't set one: the signed-in user's key when auth is installed, otherwise `ip:<client-ip>`.

```ts
const key = await defaultRateLimitKey(request)
```

### ip() {#ip}

Returns the visitor's IP address. Holo uses the address of the connection, or reads it from your [trusted proxies](/basics/security/cors-and-proxies#trusted-proxies).

```ts
const address = ip(request)
```

In a Next.js app without `trustedProxies: '*'`, it throws, because Next.js doesn't expose the connection address.

See [trusted proxies](/basics/security/cors-and-proxies#trusted-proxies).

### createSignedToken() {#createsignedtoken}

Creates a tamper-proof token that carries a JSON payload and expires at `expiresAt`. Use a different `purpose` for each kind of link.

```ts
const token = createSignedToken({ exportId: 'export-1' }, {
  purpose: 'export-download',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
})
```

See [signed tokens](/basics/security/cors-and-proxies#signed-tokens).

### verifySignedToken() {#verifysignedtoken}

Returns the payload when the token is valid, unexpired, and has the same `purpose`. Returns `null` otherwise. Pass `now` to check against a specific time.

```ts
const payload = verifySignedToken<{ readonly exportId: string }>(token, {
  purpose: 'export-download',
})
```

### resolveRequestUrl() {#resolverequesturl}

Imported from `@holo-js/kernel`. Returns the URL the visitor used, following your trusted proxies. Use it to build absolute links.

```ts
const url = resolveRequestUrl(request)
```

See [read the public URL](/basics/security/cors-and-proxies#read-the-public-url).

### SecurityCsrfError {#securitycsrferror}

The error thrown when a CSRF check fails. It has `status: 419`.

```ts
if (error instanceof SecurityCsrfError) {
  return Response.json({ message: error.message }, { status: error.status })
}
```

### SecurityRateLimitError {#securityratelimiterror}

The error thrown when a limiter is exceeded. It has `status: 429`, `retryAfterSeconds`, and `snapshot`.

```ts
if (error instanceof SecurityRateLimitError) {
  return Response.json({ message: error.message }, { status: 429 })
}
```

## Next steps

- [CSRF protection](/basics/security/csrf)
- [Rate limiting](/basics/security/rate-limiting)
- [CORS and proxies](/basics/security/cors-and-proxies)
- [Handling form submissions](/basics/forms/server)
