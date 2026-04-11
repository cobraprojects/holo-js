# Session And Cookies

Session auth in Holo is powered by `@holo-js/session`.

## Introduction

Session state stores the authenticated user for session guards and handles remember-me cookies and cookie
serialization. The session package is public, so it can be used by auth or by your own application code directly.

## Configuration

```ts
import { defineSessionConfig } from '@holo-js/config'

export default defineSessionConfig({
  driver: 'database',
  stores: {
    database: {
      driver: 'database',
      connection: 'main',
      table: 'sessions',
    },
  },
  cookie: {
    name: 'holo_session',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    domain: 'app.example.com',
  },
  idleTimeout: 120,
  absoluteLifetime: 120,
  rememberMeLifetime: 43200,
})
```

## Supported Session Stores

- `database`
- `file`

If you need a custom backing store such as Redis, configure `@holo-js/session` directly with your own store adapter
instead of relying on the portable runtime bootstrap.

The default driver must reference one of the configured stores.

## Cookie Configuration

Cookie behavior is fully configurable:

- `name`
- `path`
- `domain`
- `secure`
- `httpOnly`
- `sameSite`
- `partitioned`
- `maxAge`

These settings control how session cookies and remember-me cookies are serialized.

## How Sessions Persist Between Routes

For browser-based requests, the normal session flow is:

1. the server creates a session record
2. the server sends a `Set-Cookie` header containing the session key
3. the browser stores that cookie
4. the browser sends the cookie back on later requests
5. the server reads the cookie value and loads the session record

The cookie preserves the session key between routes. The session payload itself remains in your configured session
store.

## Browser Cookies Vs Server Sessions

A browser cookie and a server-side session are related, but they are not the same thing.

- The cookie lives in the browser.
- The session record lives in your session store.

The cookie usually contains the session key. The server uses that key to read the session record.

That means both layers must still be valid:

- if the browser no longer sends the cookie, the server cannot locate the session
- if the session record expired or was deleted, the cookie points to a missing session

## Public Session API

The package exposes direct helpers:

```ts
import {
  cookie,
  consumeRememberMeToken,
  cookies,
  createSession,
  invalidateSession,
  issueRememberMeToken,
  parseCookieHeader,
  readSession,
  rememberMeCookie,
  rotateSession,
  sessionCookie,
  touchSession,
} from '@holo-js/session'
```

One practical use case is a checkout flow that stores temporary state by cart id:

```ts
import session, { readSession } from '@holo-js/session'

await session({
  name: `checkout:${cartId}`,
  value: {
    step: 'shipping',
    coupon: 'WELCOME10',
  },
})

const checkoutSession = await readSession(`checkout:${cartId}`)
```

The created session record looks like:

```ts
{
  id: `checkout:${cartId}`,
  store: 'database',
  data: {
    step: 'shipping',
    coupon: 'WELCOME10',
  },
  createdAt: new Date(...),
  lastActivityAt: new Date(...),
  expiresAt: new Date(...),
}
```

This pattern is useful when the application can derive the same key later, such as:

- `checkout:${cartId}`
- `oauth:${state}`
- `draft:${draftId}`

These helpers exist because not every application wants session handling to be hidden entirely behind auth. You may
need to create or rotate sessions for your own features, emit cookies manually from framework responses, or inspect
cookies before handing control to another runtime layer.

## Helper Reference

### `createSession(...)`

Creates a new session record in the configured store.

Use this when:

- you need session state outside auth
- you want to store request-local or user-local data
- you are implementing your own login or onboarding flow

```ts
const session = await createSession({
  name: 'checkout',
  value: {
    cartId: 'cart_123',
    flow: 'checkout',
  },
})
```

`name` is the session key you choose yourself. It should be stable and meaningful for the flow you are implementing.
`value` is the stored payload.
If you omit `name`, Holo generates a random session id for you.

Returned value:

```ts
{
  id: 'checkout',
  store: 'database',
  data: {
    cartId: 'cart_123',
    flow: 'checkout',
  },
  createdAt: new Date(...),
  lastActivityAt: new Date(...),
  expiresAt: new Date(...),
}
```

### `readSession(...)`

Loads an existing session by key.

Use this when:

- a framework route has already extracted the session id
- you need to inspect custom session data
- you are debugging or extending session-backed flows

If you create a named application session yourself, read it back by that same derived key:

```ts
await createSession({
  name: `checkout:${cartId}`,
  value: {
    step: 'shipping',
    coupon: 'WELCOME10',
  },
})

const checkoutSession = await readSession(`checkout:${cartId}`)
```

If you are using browser session auth, the session key usually comes from the configured session cookie, not from an
arbitrary request field. In most applications, the flow is:

1. read the incoming `Cookie` header
2. parse it
3. read the configured session cookie name
4. load that session id from the store

```ts
import { parseCookieHeader, readSession } from '@holo-js/session'

const cookies = parseCookieHeader(request.headers.get('cookie') ?? '')
const sessionName = cookies.holo_session
const session = sessionName ? await readSession(sessionName) : null
```

If the configured session cookie name is not `holo_session`, read the cookie name you configured in
`config/session.ts`.

### `touchSession(...)`

Refreshes session activity and lifetime without changing the session id.

Use this when:

- a request should keep the session alive
- your application has long-running browser flows
- you want to extend activity windows on custom routes

```ts
await touchSession(sessionId)
```

### `rotateSession(...)`

Creates a replacement session id while preserving session data.

Use this when:

- login succeeds
- privilege level changes
- you want to reduce session fixation risk

```ts
const rotated = await rotateSession(sessionId)
```

### `invalidateSession(...)`

Deletes a session from the configured store.

Use this when:

- a user logs out
- a session is compromised
- you want to terminate stale server-side state

```ts
await invalidateSession(sessionId)
```

### `issueRememberMeToken(...)`

Creates the remember-me token tied to a session.

Use this when:

- the user selected a remember-me option
- your application needs a durable login cookie

```ts
const rememberToken = await issueRememberMeToken(sessionId)
```

### `consumeRememberMeToken(...)`

Resolves a remember-me token back to its session when the token is valid.

Use this when:

- a request arrives without an active session id
- a remember-me cookie should restore the login state

```ts
const session = await consumeRememberMeToken(rememberToken)
```

### `cookie(name, value, options?)`

Serializes a general-purpose cookie string.

Use this when:

- you need a non-session cookie
- your framework response API expects a raw `Set-Cookie` header value

```ts
const header = cookie('theme', 'dark', {
  path: '/',
  httpOnly: false,
})
```

Set a cookie for one day:

```ts
const header = cookie('promo_banner', 'seen', {
  maxAge: 60 * 60 * 24,
})
```

`maxAge` is in seconds, so one day is `86400`.

### `sessionCookie(value, options?)`

Serializes the main session cookie using the configured session cookie defaults.

Use this when:

- you want to emit the active session id into the response
- your route manages `Set-Cookie` headers directly

The cookie name is defined in `config/session.ts`. The value is the session id returned from `createSession(...)` or
`rotateSession(...)`.

```ts
const header = sessionCookie(session.id)
```

Set the session cookie for one day:

```ts
const header = sessionCookie(session.id, {
  maxAge: 60 * 60 * 24,
})
```

### `rememberMeCookie(value, options?)`

Serializes the remember-me cookie using remember-me defaults.

Use this when:

- you issue remember-me state manually
- your route owns the cookie response handling

```ts
const header = rememberMeCookie(rememberToken)
```

Use an absolute expiration date instead:

```ts
const header = rememberMeCookie(rememberToken, {
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
})
```

### `cookies(...)`

Creates multiple serialized cookies together.

Use this when:

- a response needs to set more than one cookie
- you want to return session and remember-me cookies at the same time

```ts
const headers = cookies([
  sessionCookie(session.id),
  rememberMeCookie(rememberToken),
])
```

### `parseCookieHeader(...)`

Parses the incoming request cookie header into key/value pairs.

Use this when:

- your framework gives you the raw `Cookie` header
- you need to extract the session or remember-me cookie before calling the runtime

```ts
const parsed = parseCookieHeader(request.headers.get('cookie') ?? '')
const sessionId = parsed.holo_session
```

If you changed the configured session cookie name, read that cookie key instead of `holo_session`.

## What Happens If The Same Name Is Used Twice

### Sessions

If you create a session with the same key twice, the later write replaces the earlier stored value:

```ts
await createSession({
  name: `checkout:${cartId}`,
  value: { step: 'shipping' },
})

await createSession({
  name: `checkout:${cartId}`,
  value: { step: 'payment' },
})
```

Reading `checkout:${cartId}` after that returns the latest stored payload.

### Cookies

If you set the same cookie name again with the same scope, the later value replaces the earlier one in normal browser
behavior.

Cookie scope depends on:

- name
- domain
- path

So the simple rule is:

- same name and same scope: latest value wins
- same name and different scope: both may exist

## Expiration

Expiration has two layers.

### Cookie Expiration

Cookie expiration controls whether the browser keeps sending the cookie.

You control that with:

- `maxAge`
- `expires`

### Session Expiration

Session expiration controls whether the server still accepts the session key.

The session runtime uses:

- `idleTimeout`
- `absoluteLifetime`
- `rememberMeLifetime`

So a browser may still send a cookie whose server-side session has expired, and the server may still have a session
record whose cookie is no longer stored by the browser.

Both layers must still be valid for the request to restore session state.

## Reading Cookies On The Server

Server routes read cookies from the incoming `Cookie` header:

```ts
import { parseCookieHeader, readSession } from '@holo-js/session'

export async function GET(request: Request) {
  const parsed = parseCookieHeader(request.headers.get('cookie') ?? '')
  const sessionId = parsed.holo_session
  const session = sessionId ? await readSession(sessionId) : null

  return Response.json({ session })
}
```

If the client is not a browser, it must preserve and resend cookies itself, or use token auth instead.

## Remember-Me Cookies

Remember-me tokens are issued through the session runtime and reused by session guards when `remember: true` is passed
during login.

Remember-me behavior depends on:

- `rememberMeLifetime`
- cookie serialization settings
- the selected session store

## Session Auth Integration

When a session guard logs a user in, the auth runtime:

- creates a session record
- writes the current auth payload into session data
- updates the guard context with the active session id
- optionally issues a remember-me token

When the user logs out, the active session is invalidated for that guard.

## Why Use The Session Package Directly

Use `@holo-js/session` directly when:

- you need session storage outside auth
- your framework route builds the `Set-Cookie` headers itself
- you want full control over session creation, rotation, and invalidation
- you are building flows such as carts, onboarding state, checkout progress, or temporary wizard state

Use `@holo-js/auth` on top of it when the concern is user authentication rather than raw session management.
