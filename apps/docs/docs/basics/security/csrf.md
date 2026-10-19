# CSRF Protection

Cross-site request forgery (CSRF) protection stops other websites from submitting forms or requests to your app using your visitors' cookies. Holo stores a token in each visitor's session, and every unsafe request must send that token back in a form field or header.

## Quick start

With the [security middleware](/basics/security/#register-the-middleware) registered and `csrf.enabled: true`, add the token to your form as a hidden field:

```ts [src/routes/contact/+page.server.ts]
import { csrf } from '@holo-js/security'
import type { PageServerLoad } from './$types'

export const load = (async ({ request }) => {
  return {
    csrfInput: await csrf.input(request),
  }
}) satisfies PageServerLoad
```

```svelte [src/routes/contact/+page.svelte]
<script lang="ts">
  let { data } = $props()
</script>

<form method="POST">
  <input type={data.csrfInput.type} name={data.csrfInput.name} value={data.csrfInput.value} />
  <input name="email" type="email" />
  <button>Send</button>
</form>
```

The middleware checks the token before your action runs. If it's missing or doesn't match, the browser gets a `419` response.

## How it works

1. On a `GET` or `HEAD` request, the middleware makes sure the visitor's [session](/basics/session) holds a CSRF token. A visitor without a session gets one, along with its session cookie.
2. The middleware also sets a readable `XSRF-TOKEN` cookie. Its value is the session token encrypted with your app key.
3. On `POST`, `PUT`, `PATCH`, and `DELETE`, the request must send the token back in one of these:
   - the `_token` field, in a form body, a JSON body, or the query string,
   - the `X-CSRF-TOKEN` header, or
   - the `X-XSRF-TOKEN` header, carrying the `XSRF-TOKEN` cookie value exactly as the browser stores it.
4. Holo compares the submitted token with the one in the session. `_token` and `X-CSRF-TOKEN` accept the plain token from `csrf.token()` or `csrf.input()`, or the `XSRF-TOKEN` cookie value.

The `XSRF-TOKEN` cookie is not enough on its own. A token copied from another browser, or a cookie planted by a subdomain, doesn't match the visitor's session and is rejected. So is a value that was changed or encrypted with a different app key.

CSRF protection needs `@holo-js/session`. `holo install security` adds it. Without a `config/session.ts`, Holo uses the default file session store.

`GET`, `HEAD`, and `OPTIONS` requests are never checked.

A matching `Origin` or `Referer` header is not enough on its own. Unsafe requests always need the token.

## Forms built with `useForm`

When you use [client-side forms](/basics/forms/client), `useForm(...)` reads the `XSRF-TOKEN` cookie and adds it as the `_token` field to `FormData` submissions automatically. If the form already has a `_token` field, for example from `csrf.input()`, `useForm` keeps it. You don't need any CSRF option.

If your frontend runs on a different origin and can't read the cookie, point `useForm` at an endpoint that returns `{ token }`. The form fetches it and sends it in the `csrf.header` header (`X-CSRF-TOKEN` by default) instead of adding `_token`:

```ts
import { useForm } from '@holo-js/adapter-sveltekit/client'
import { field, schema } from '@holo-js/validation'

const contactForm = schema({
  email: field.string().required().email(),
})

const form = useForm(contactForm, {
  action: 'https://api.example.com/api/contact',
  method: 'POST',
  credentials: 'include',
  csrf: {
    endpoint: 'https://api.example.com/api/csrf-token',
  },
})
```

The endpoint returns the current token and the API's configured field name, so a separate frontend doesn't need to read the API's configuration cookie:

```ts [src/routes/api/csrf-token/+server.ts]
import { json } from '@sveltejs/kit'
import { csrf } from '@holo-js/security'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  const { name: field, value: token } = await csrf.field(request)
  return json({ token, field })
}
```

## Sending the token with `fetch`

For your own `fetch` calls, read the cookie and send it in the `X-XSRF-TOKEN` header. `getSecurityClientConfig()` returns the cookie name from your config, so you don't hard-code it:

```ts
import { getSecurityClientConfig } from '@holo-js/security/client'

function readCsrfToken(): string | undefined {
  const { cookie } = getSecurityClientConfig().csrf
  const match = document.cookie
    .split('; ')
    .find(entry => entry.startsWith(`${cookie}=`))

  return match ? decodeURIComponent(match.slice(cookie.length + 1)) : undefined
}

await fetch('/api/posts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-XSRF-TOKEN': readCsrfToken() ?? '',
  },
  body: JSON.stringify({ title: 'Hello' }),
})
```

`X-XSRF-TOKEN` always carries the encrypted cookie value. The `csrf.header` header (`X-CSRF-TOKEN` by default) takes the plain token from `csrf.token()`, and also accepts the cookie value.

## Next.js Server Actions

In Next.js, a form that posts to a Server Action can carry the hidden `_token` field like any other form. `useForm` adds the `XSRF-TOKEN` cookie value there for you. The middleware finds the token in the action's form data and verifies it against the session.

## Skip CSRF for some paths

Webhooks and machine-to-machine endpoints can't send a CSRF token. List them in `except`. A `*` matches any characters:

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
    except: [
      '/api/webhooks/*',
      '/api/v1/*',
    ],
  },
})
```

When [broadcasting](/broadcasting/) is installed, `/broadcasting/auth` is always skipped.

::: danger
Only exclude routes that don't rely on cookie authentication. An excluded route that reads the session is open to CSRF attacks. Verify webhooks with the sender's signature instead.
:::

## Check CSRF inside a route

The middleware is the normal way to verify tokens. Use `protect()` when a route needs its own check, for example when the middleware isn't registered for that path:

::: code-group

```ts [Next.js]
// app/api/posts/route.ts
import { protect } from '@holo-js/security'

export async function POST(request: Request) {
  await protect(request)

  return Response.json({ ok: true })
}
```

```ts [Nuxt]
// server/api/posts.post.ts
import { defineEventHandler, toWebRequest } from 'h3'
import { protect } from '@holo-js/security'

export default defineEventHandler(async (event) => {
  await protect(toWebRequest(event))

  return { ok: true }
})
```

```ts [SvelteKit]
// src/routes/api/posts/+server.ts
import { json } from '@sveltejs/kit'
import { protect } from '@holo-js/security'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request }) => {
  await protect(request)

  return json({ ok: true })
}
```

:::

`protect(request)` follows your config: it skips safe methods, `except` paths, and does nothing when `csrf.enabled` is `false`. Pass `csrf: true` to force the check regardless of config, or `csrf: false` to skip it. A failed check throws `SecurityCsrfError`, which has `status: 419`.

`protect()` also accepts `throttle`. See [rate limiting](/basics/security/rate-limiting#protect-a-route).

## Token helpers

| Helper | Returns |
|---|---|
| `csrf.token(request)` | The session's token. The middleware stores one in the session on `GET` and `HEAD` requests. |
| `csrf.field(request)` | `{ name, value }` — the field name and token. |
| `csrf.input(request)` | `{ type: 'hidden', name, value }` — ready to spread onto an `<input>`. |
| `csrf.cookie(request, token?)` | A `Set-Cookie` header value for the `XSRF-TOKEN` cookie. The middleware already sets it, so you rarely need this. |
| `csrf.verify(request)` | Resolves when the request passes, throws `SecurityCsrfError` otherwise. Skips safe methods and `except` paths. |

`isSecureRequest(request)` returns `true` when the request's URL uses `https:`. Holo uses it to set the `Secure` flag on the token cookie, so you rarely need it yourself.

## Configuration

| Option | Default | Description |
|---|---|---|
| `enabled` | `false` (the generated config sets `true`) | Turns CSRF checks on. You can also write `csrf: true`. |
| `field` | `'_token'` | Form field name for the token. |
| `header` | `'X-CSRF-TOKEN'` | Header name for the token. |
| `cookie` | `'XSRF-TOKEN'` | Readable cookie that holds the encrypted session token. |
| `except` | `[]` | Path patterns that skip verification. |

The token cookie is set with `Path=/`, `SameSite=Lax`, is readable by JavaScript (so clients can send it back), and is marked `Secure` on HTTPS requests. Behind a proxy that terminates TLS, see [trusted proxies](/basics/security/cors-and-proxies#trusted-proxies) so Holo detects HTTPS.

## Next steps

- [Client-side forms](/basics/forms/client)
- [Rate limiting](/basics/security/rate-limiting)
- [CORS and proxies](/basics/security/cors-and-proxies)
