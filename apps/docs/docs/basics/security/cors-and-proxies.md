# CORS and Proxies

This page covers three settings you need once your app leaves `localhost`: CORS for frontends on another origin, trusted proxies for apps behind a load balancer, and signed tokens for links that must not be tampered with.

## CORS

CORS (cross-origin resource sharing) lets a frontend on one origin, such as `https://app.example.com`, call your API on another, such as `https://api.example.com`. Rules live in `config/cors.ts`:

```ts [config/cors.ts]
import { env } from '@holo-js/config'
import { defineCorsConfig } from '@holo-js/security'

export default defineCorsConfig({
  paths: ['/api/*', '/broadcasting/auth'],
  origins: [
    env('FRONTEND_URL', 'http://localhost:3000'),
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  headers: ['Content-Type', 'Authorization', 'X-CSRF-TOKEN', 'X-XSRF-TOKEN', 'X-Requested-With'],
  credentials: true,
  maxAge: 7200,
  statefulDomains: [
    env('FRONTEND_DOMAIN', 'localhost:3000'),
  ],
})
```

The [security middleware](/basics/security/#register-the-middleware) applies these rules. It answers preflight `OPTIONS` requests from allowed origins and adds CORS headers to responses, including `419` CSRF failures, so the browser can read the error.

### How origins are matched

For a request to a path in `paths`, Holo looks at the `Origin` header:

- If the origin is listed in `origins`, or its host is in `statefulDomains`, Holo echoes it back in `Access-Control-Allow-Origin`.
- If `origins` contains `'*'`, any origin is allowed and Holo answers with `Access-Control-Allow-Origin: *`.
- Otherwise no CORS headers are added and the browser blocks the response.

Responses always include `Vary: Origin` so caches don't mix up origins.

::: warning
`origins: ['*']` can't be combined with `credentials: true`. That pair would let any website make cookie-authenticated requests to your API, so Holo refuses to start with it. List your real frontend origins instead.
:::

### Cookies across origins

When your frontend sends cookies with `fetch(url, { credentials: 'include' })`, the response must include `Access-Control-Allow-Credentials: true`. Holo sends it when `credentials` is `true`, or when the request comes from a host in `statefulDomains`.

Use `statefulDomains` for first-party frontends that use session cookies. Entries are hosts with an optional port (`app.example.com`, `localhost:3000`); full URLs also work.

Cross-origin frontends usually can't read the CSRF cookie. See [CSRF with a separate frontend](/basics/security/csrf#forms-built-with-useform) for fetching the token from an endpoint.

### Options

| Option | Default | Description |
|---|---|---|
| `paths` | `['/api/*']` | Path patterns that get CORS headers. `*` matches any characters. |
| `origins` | `[]` | Allowed origins, such as `https://app.example.com`. `'*'` allows any. |
| `methods` | `GET, POST, PUT, PATCH, DELETE, OPTIONS` | Sent in `Access-Control-Allow-Methods` on preflight. |
| `headers` | `Content-Type, Authorization, X-CSRF-TOKEN, X-XSRF-TOKEN, X-Requested-With` | Sent in `Access-Control-Allow-Headers` on preflight. |
| `credentials` | `false` (the generated config sets `true`) | Send `Access-Control-Allow-Credentials: true`. |
| `maxAge` | `7200` | Seconds the browser may cache a preflight result. |
| `statefulDomains` | `[]` | Hosts treated as first-party cookie clients. |

### Apply CORS manually

The middleware covers most apps. For a route that runs outside it, use the `cors` helpers:

```ts [app/api/feed/route.ts]
import { cors } from '@holo-js/security'

export async function OPTIONS(request: Request) {
  return cors.preflight(request) ?? new Response(null, { status: 204 })
}

export async function GET(request: Request) {
  return cors.apply(request, Response.json({ posts: [] }))
}
```

| Helper | Description |
|---|---|
| `cors.headers(request)` | Returns a `Headers` object with the CORS headers for this request. |
| `cors.apply(request, response?)` | Returns a copy of `response` with CORS headers added. Without a response, it returns an empty `204`. |
| `cors.preflight(request)` | Returns a preflight response for an allowed `OPTIONS` request, or `null`. |

## Trusted proxies

Holo identifies each visitor by the address of their connection. That works out of the box when visitors connect straight to your app.

Behind a load balancer, CDN, or reverse proxy such as nginx, every connection comes from the proxy. The proxy passes the visitor's address, protocol, and host in `X-Forwarded-*` headers. Tell Holo which proxies to believe in `config/security.ts`:

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: ['127.0.0.1', '::1'],
})
```

This is the setup for nginx on the same server. List IP addresses or CIDR ranges, such as `'10.0.0.0/8'`. The default is `[]`, which trusts no proxy.

Projects created with `holo new` read this list from the `TRUSTED_PROXIES` environment variable, so each deployment can name its own proxies. Use a comma-separated list, such as `TRUSTED_PROXIES=127.0.0.1,::1`, or `TRUSTED_PROXIES=*`. When it's unset, the app trusts no proxy.

When a Nuxt app receives a request over a Unix socket, as it does behind `nuxt dev`, Holo treats the connection as coming from `127.0.0.1`. If you serve Nuxt behind a proxy over a Unix socket, add `'127.0.0.1'` to `trustedProxies`. Otherwise Holo ignores the proxy's headers, and every visitor shares the address `127.0.0.1`, including for rate limiting.

### How Holo finds the visitor

Holo reads forwarded headers only when the connection comes from a trusted proxy, the same way Laravel's `TrustProxies` middleware does. Then it reads `X-Forwarded-For` from right to left, skipping trusted proxies and entries that aren't IP addresses, and stops at the first address it doesn't trust. That address is the visitor.

Proxies such as nginx add the address they saw to the end of the list. Anything a visitor sends in their own `X-Forwarded-For` stays to the left of it, so a visitor can't pretend to be someone else.

Holo honors these headers from a trusted proxy. Apart from `X-Forwarded-For`, it takes the first value when a header lists several:

| Header | Used for |
|---|---|
| `X-Forwarded-For` | The visitor's IP address. |
| `X-Forwarded-Proto` | The protocol. `https`, `on`, `ssl`, and `1` mean HTTPS; anything else means HTTP. The protocol decides whether cookies, including the CSRF cookie, get the `Secure` flag. |
| `X-Forwarded-Host` | The host, with an optional port. |
| `X-Forwarded-Port` | The port. It replaces any port in the host. |
| `X-Forwarded-Prefix` | A path the proxy serves your app under, such as `/blog`. It's added in front of the path in [the public URL](#read-the-public-url). Route matching, such as CSRF `except` and CORS `paths`, still uses the path without the prefix. |

The standard `Forwarded` header is ignored, as in Laravel. Configure your proxy to send `X-Forwarded-*` headers instead.

Holo answers `400 Bad Request` when a trusted header has a malformed value, such as a host with spaces, a port that isn't a number, or a prefix that doesn't start with a single `/`.

### Behind Cloudflare

When visitors pass through Cloudflare and then nginx, trust both: nginx's address, and [Cloudflare's IP ranges](https://www.cloudflare.com/ips/):

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: [
    '127.0.0.1',
    '::1',
    '173.245.48.0/20',
    '103.21.244.0/22',
  ],
})
```

The example lists two of Cloudflare's ranges. Copy the full current list from Cloudflare.

### Trust the proxy in front: `'*'`

Use `'*'` when your app is only reachable through one proxy, but you don't know its address in advance, as on many hosting platforms. Holo then trusts whatever connects to it and takes the visitor from the last `X-Forwarded-For` entry. It also trusts forwarded headers when the framework doesn't tell Holo the connection address:

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: '*',
})
```

### Next.js

Next.js doesn't tell Holo the address of the connection, so Holo can't check it against a list of proxies. In a Next.js app, Holo reads forwarded headers only with `trustedProxies: '*'`. With a list, or without `trustedProxies`, Holo ignores forwarded headers.

Holo never guesses a visitor's address. When the address is unknown, `ip(request)` and every [rate limiter](/basics/security/rate-limiting) keyed by IP throw this error, and the request fails:

```text
[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. In Next.js, set TRUSTED_PROXIES=* only when the app is reachable exclusively through a proxy that overwrites X-Forwarded-For, such as Vercel's edge, or a reverse proxy with the Next.js server bound to localhost or a private network. In Nuxt and SvelteKit, set TRUSTED_PROXIES to your proxy's addresses or CIDR ranges. See https://docs.holo-js.com/basics/security/cors-and-proxies#trusted-proxies
```

A failed request doesn't share a rate-limit bucket with other visitors, and it doesn't skip the limit.

Next.js doesn't expose the connection address, so an address or CIDR list can never match and `*` is the only value that works. Set `TRUSTED_PROXIES=*` before you deploy, and only in one of these setups:

- **Vercel**: set `TRUSTED_PROXIES=*` in the project's environment variables. Vercel's edge overwrites `X-Forwarded-For`, so `*` is safe there.
- **Self-hosted**: put a reverse proxy that overwrites `X-Forwarded-For` in front of the app, and bind the Next.js server to `localhost` or a private network so clients can reach it only through that proxy.

Nuxt and SvelteKit expose the connection address, so list your proxy's addresses or CIDR ranges there instead of `*`.

New Next.js projects write `TRUSTED_PROXIES=*` to their local `.env` and leave `.env.example` empty. The local value works with `next dev` and `holo dev`: when a request has no `X-Forwarded-For`, Next fills it in from the connection address, which is `127.0.0.1` or `::1` for a local visitor. A deployment that never sets the variable fails on its first IP-keyed rate-limit check.

::: warning
Don't use `*` on a `next start` server that clients reach directly. Next fills in `X-Forwarded-For` only when the request doesn't have one. A client that sends its own header keeps it, and with `*` Holo trusts that value, so the client can pick its IP. Use `*` only behind a proxy that overwrites the header, such as Vercel's edge, or with the Next.js server bound to localhost or a private network behind your own such proxy.
:::

Next.js itself applies `X-Forwarded-Proto` to the request URL before Holo sees it, whatever `trustedProxies` says.

::: warning
`'*'` is safe only when your app is reachable through your proxy and nothing else. Block direct access to the port your Next.js server listens on, for example with a firewall or by listening on `127.0.0.1` behind nginx. If visitors can reach your app directly, they can send their own `X-Forwarded-*` headers to choose their IP address, dodge rate limits, and change the host and protocol Holo sees.
:::

### Read the public URL

`resolveRequestUrl` returns the URL the visitor actually used, following your trusted proxies. Use it when you build absolute links from a request:

```ts
import { resolveRequestUrl } from '@holo-js/kernel'

const url = resolveRequestUrl(request)
const resetLink = new URL('/reset-password', url.origin)
```

It accepts a `Request`, a Nuxt `event`, or a SvelteKit request event, and doesn't read the body. Behind a trusted proxy that sends `X-Forwarded-Prefix: /blog`, a request for `/login` resolves to `/blog/login`. It throws on hosts with invalid characters, non-HTTP protocols, and URLs with credentials.

## Signed tokens

Signed tokens carry a small JSON payload that can't be changed without detection, and that expires. Use them for download links, unsubscribe links, or one-time actions where you don't want to store a row in the database.

```ts
import { createSignedToken, verifySignedToken } from '@holo-js/security'

const token = createSignedToken({ exportId: 'export-1' }, {
  purpose: 'export-download',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
})

const payload = verifySignedToken<{ readonly exportId: string }>(token, {
  purpose: 'export-download',
})

if (!payload) {
  return new Response('Link expired or invalid.', { status: 403 })
}
```

`verifySignedToken` returns the payload, or `null` when the token was modified, has expired, or was created for a different `purpose`. Use a distinct `purpose` for each kind of link so a token for one feature can't be replayed against another.

Rules:

- The payload must be a plain object of JSON values: strings, finite numbers, booleans, `null`, arrays, and plain objects. Dates, class instances, `NaN`, and circular references throw.
- `expiresAt` must be in the future. The encoded payload can be at most 64 KiB.
- Tokens are signed with your app key. Changing `APP_KEY` invalidates every token.
- The payload is encoded, not encrypted. Don't put secrets in it.

Pass `now` to `verifySignedToken` to check against a specific time, which is useful in tests.

## Next steps

- [CSRF protection](/basics/security/csrf)
- [Rate limiting](/basics/security/rate-limiting)
- [Broadcasting](/broadcasting/)
- [Production checklist](/deployment/checklist)
