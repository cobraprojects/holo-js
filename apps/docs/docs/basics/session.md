# Sessions

`@holo-js/session` stores data on the server between requests, such as a shopping cart, a multi-step wizard, or one-time messages. The browser keeps only an ID in a cookie. The data itself lives in a file, database, or Redis store that you choose in `config/session.ts`.

If you use [authentication](/auth/), Holo already creates and manages the login session for you. Use this page when you want to store your own data in a session, or to tune how sessions and cookies behave.

## Quick example

Store progress for a checkout flow under a key you can rebuild later, then read it back:

```ts
import session, { readSession } from '@holo-js/session'

await session({
  id: `checkout:${cartId}`,
  data: { step: 'shipping', coupon: 'WELCOME10' },
})

const checkout = await readSession(`checkout:${cartId}`)

checkout?.data.step
```

`session(...)` is a shortcut for `createSession(...)`. Both return the stored record:

```ts
{
  id: 'checkout:42',
  store: 'file',
  data: { step: 'shipping', coupon: 'WELCOME10' },
  createdAt: Date,
  lastActivityAt: Date,
  expiresAt: Date,
}
```

`readSession()` returns `null` when the session doesn't exist or has expired. Expired records are deleted when you try to read them.

## Install

The session package and `config/session.ts` are added when you install authentication:

```bash
npx holo install auth
```

That command also creates the `sessions` table migration used by the database store.

## Configuration

```ts [config/session.ts]
import { defineSessionConfig } from '@holo-js/session'
import { env } from '@holo-js/config'

export default defineSessionConfig({
  driver: env('SESSION_DRIVER', 'file'),
  stores: {
    database: {
      driver: 'database',
      connection: env('SESSION_CONNECTION', 'main'),
      table: 'sessions',
    },
    file: {
      driver: 'file',
      path: './storage/framework/sessions',
    },
  },
  cookie: {
    name: env('SESSION_COOKIE', 'holo_session'),
    path: env('SESSION_PATH', '/'),
    domain: env('SESSION_DOMAIN'),
    secure: env('SESSION_SECURE', false),
    httpOnly: true,
    sameSite: 'lax',
  },
  idleTimeout: env('SESSION_IDLE_TIMEOUT', 120),
  absoluteLifetime: env('SESSION_LIFETIME', 120),
  rememberMeLifetime: env('SESSION_REMEMBER_ME_LIFETIME', 43200),
})
```

`driver` picks the default store by name from `stores`. Every session function also accepts a `store` option when you want a different one:

```ts
await readSession(sessionId, { store: 'database' })
```

## Choose a store

| Driver | Good for | Options |
|---|---|---|
| `file` | Local development and single-server apps | `path` (default `./storage/framework/sessions`, relative to the project root) |
| `database` | Apps running on several servers | `connection` (default `default`), `table` (default `sessions`) |
| `redis` | High traffic and several servers | `connection`, `prefix` |

All three stores support every feature on this page, including flash data and ID rotation.

### File store

Each session is a file under `path`, written with private file permissions. Add the folder to `.gitignore`. Use the database or Redis store when more than one server handles requests, because each server only sees its own disk.

### Database store

The database store reads and writes the `sessions` table. `npx holo install auth` creates this migration for you:

```ts [server/db/migrations/2026_04_25_044033_create_sessions.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('sessions', (table) => {
      table.string('id').primaryKey()
      table.string('store').default('database')
      table.json('data')
      table.timestamp('created_at')
      table.timestamp('last_activity_at')
      table.timestamp('expires_at')
      table.timestamp('invalidated_at').nullable()
      table.index(['expires_at'])
    })
  },
  async down({ schema }) {
    await schema.dropTable('sessions')
  },
})
```

Run `npx holo migrate` after adding it.

### Redis store

```ts [config/session.ts]
stores: {
  redis: {
    driver: 'redis',
    connection: 'default',
    prefix: 'myapp:',
  },
},
```

`connection` names a connection in `config/redis.ts`. Leave it out to use that file's default connection. The Redis store needs the `ioredis` package installed in your app.

## Remember a visitor across requests

To keep data for a visitor, put the session ID in a cookie and read it back on the next request. This example keeps a cart in its own cookie, separate from the login session:

::: code-group

```ts [Next.js]
// app/api/cart/route.ts
import { cookie, createSession, parseCookieHeader, readSession, writeSession } from '@holo-js/session'

const CART_COOKIE = 'holo_cart'

export async function POST(request: Request) {
  const { productId } = await request.json() as { productId: number }
  const cartId = parseCookieHeader(request.headers.get('cookie'))[CART_COOKIE]
  const cart = (cartId ? await readSession(cartId) : null) ?? await createSession()

  const items = Array.isArray(cart.data.items) ? cart.data.items : []
  const updated = await writeSession({
    ...cart,
    data: { ...cart.data, items: [...items, productId] },
  })

  return Response.json({ items: updated.data.items }, {
    headers: { 'set-cookie': cookie(CART_COOKIE, updated.id) },
  })
}
```

```ts [Nuxt]
// server/api/cart.post.ts
import { cookie, createSession, parseCookieHeader, readSession, writeSession } from '@holo-js/session'

const CART_COOKIE = 'holo_cart'

export default defineEventHandler(async (event) => {
  const { productId } = await readBody<{ productId: number }>(event)
  const cartId = parseCookieHeader(getRequestHeader(event, 'cookie'))[CART_COOKIE]
  const cart = (cartId ? await readSession(cartId) : null) ?? await createSession()

  const items = Array.isArray(cart.data.items) ? cart.data.items : []
  const updated = await writeSession({
    ...cart,
    data: { ...cart.data, items: [...items, productId] },
  })

  appendResponseHeader(event, 'set-cookie', cookie(CART_COOKIE, updated.id))
  return { items: updated.data.items }
})
```

```ts [SvelteKit]
// src/routes/api/cart/+server.ts
import { json } from '@sveltejs/kit'
import { cookie, createSession, parseCookieHeader, readSession, writeSession } from '@holo-js/session'

const CART_COOKIE = 'holo_cart'

export async function POST({ request }) {
  const { productId } = await request.json() as { productId: number }
  const cartId = parseCookieHeader(request.headers.get('cookie'))[CART_COOKIE]
  const cart = (cartId ? await readSession(cartId) : null) ?? await createSession()

  const items = Array.isArray(cart.data.items) ? cart.data.items : []
  const updated = await writeSession({
    ...cart,
    data: { ...cart.data, items: [...items, productId] },
  })

  return json({ items: updated.data.items }, {
    headers: { 'set-cookie': cookie(CART_COOKIE, updated.id) },
  })
}
```

:::

`createSession()` without an `id` generates a random one. `cookie()` builds a `Set-Cookie` header value using the `cookie` settings from your config, so `secure`, `httpOnly`, `sameSite`, `path`, and `domain` stay consistent.

::: warning
Validate request bodies with [validation](/basics/validation/) in real routes. The examples above read the body directly only to stay short.
:::

## Update session data

Session records are read-only objects. To change data, spread the record into `writeSession()`:

```ts
import { readSession, writeSession } from '@holo-js/session'

const checkout = await readSession(`checkout:${cartId}`)

if (checkout) {
  await writeSession({
    ...checkout,
    data: { ...checkout.data, step: 'payment' },
  })
}
```

`writeSession()` saves the record as-is and doesn't change its expiry. Creating a session with an `id` that already exists replaces the old record.

## Keep a session alive

Sessions expire after `idleTimeout` minutes without activity, and never live longer than `absoluteLifetime` minutes from creation. Call `touchSession()` to record activity and push the idle expiry forward:

```ts
import { touchSession } from '@holo-js/session'

const active = await touchSession(sessionId)
```

It returns `null` if the session is gone. The new expiry is never later than `createdAt` plus `absoluteLifetime`.

## Expired session cleanup

A session that a visitor abandons stays in the store until it is cleaned up. About 2 in every 100 requests that write a session also delete expired sessions, the same odds Laravel uses by default. The check runs inside the request, so the request that wins the draw takes a little longer.

- **File store:** Holo deletes expired session files in the session folder. It skips a session that is in use, never follows symbolic links, and checks at most 1,000 entries per run. Subsequent runs continue through the folder.
- **Database store:** Holo deletes every row past its expiry.
- **Redis store:** nothing runs. Redis deletes each session when its expiry passes.

The odds aren't configurable. Cleanup runs with the other session work, so you don't need a scheduled task.

## Flash data

Flash data is a value you read once. `flashSession()` stores it, and `takeSession()` returns it and removes it in one step, so two requests can't both read it:

```ts
import { flashSession, takeSession } from '@holo-js/session'

await flashSession(sessionId, 'status', 'Your profile was saved.')

const status = await takeSession<string>(sessionId, 'status')
```

`takeSession()` returns `undefined` if there is nothing to take.

Flash keys must start with a letter and use only letters, numbers, `.`, `:`, `-`, and `_` (up to 128 characters). Values must be plain JSON (strings, numbers, booleans, `null`, arrays, and plain objects), at most 64 KiB and 32 levels deep. Flash data is stored separately from `data`, so it isn't returned by `readSession()`.

## Rotate the session ID

Give a session a new ID after a privilege change, such as signing in, so an old ID that leaked can't be reused. Data and flash values move to the new ID:

```ts
import { rotateSession, sessionCookie } from '@holo-js/session'

const rotated = await rotateSession(sessionId)
const setCookie = sessionCookie(rotated.id)
```

| Option | Effect |
|---|---|
| `newId` | Use this ID instead of a random one. It must be unique and unused: Holo never supplies one, and rotation fails if the ID already holds a session. Concurrent rotations that reuse one `newId` are supported only on the file and Redis stores, where exactly one succeeds. Other stores don't support concurrent reuse, so don't share a `newId` between concurrent rotations on them |
| `data` | Replace the session data |
| `renewLifetime` | Restart the lifetime from now |
| `store` | Move the session to another store (not allowed while it has flash data) |

Auth does this for you when a user signs in.

## End a session

```ts
import { cookies, invalidateSession } from '@holo-js/session'

await invalidateSession(sessionId)
const clearCookie = cookies.forget('holo_cart')
```

`cookies.forget()` builds a `Set-Cookie` header that expires the cookie immediately.

## Cookies

| Function | Returns |
|---|---|
| `cookie(name, value, options?)` | A `Set-Cookie` value using your config defaults |
| `sessionCookie(value, options?)` | Same, named after `cookie.name` in your config, with the value encrypted |
| `rememberMeCookie(value, options?)` | Same, named `<cookie.name>_remember`, lasting `rememberMeLifetime`, with the value encrypted |
| `cookies.make(name, value, options?)` | Same as `cookie()` |
| `cookies.forget(name, options?)` | A `Set-Cookie` value that deletes the cookie |
| `parseCookieHeader(header)` | An object of cookie names to values from a `Cookie` header |

`sessionCookie()` and `rememberMeCookie()` encrypt the value with your app key (`APP_KEY`) so the browser can't read or change it. [Auth](/auth/session-and-cookies) decrypts them on the next request. They throw if `APP_KEY` is empty. `cookie()` and `cookies.make()` write the value as given.

Options override the config for one cookie: `path`, `domain`, `secure`, `httpOnly`, `sameSite`, `partitioned`, `maxAge` (in **seconds**), and `expires` (a `Date`).

Holo refuses to build cookies that browsers would reject or that weaken security:

- `sameSite: 'none'` and `partitioned: true` require `secure: true`.
- Names starting with `__Secure-` require `secure: true`.
- Names starting with `__Host-` require `secure: true`, `path: '/'`, and no `domain`.
- Paths must start with `/`, and domains must be valid hostnames.

::: tip
Set `SESSION_SECURE=true` in production so cookies are only sent over HTTPS.
:::

## Configuration reference

| Option | Default | Description |
|---|---|---|
| `driver` | `file` | Name of the default store in `stores` |
| `stores` | `file` and `database` stores | Named stores; see [choose a store](#choose-a-store) |
| `idleTimeout` | `120` | Minutes of inactivity before a session expires |
| `absoluteLifetime` | `120` | Maximum session age in minutes |
| `rememberMeLifetime` | `43200` (30 days) | Remember-me cookie lifetime in minutes |
| `cookie.name` | `holo_session` | Session cookie name |
| `cookie.path` | `/` | Cookie path |
| `cookie.domain` | not set | Cookie domain |
| `cookie.secure` | `false` | Send only over HTTPS |
| `cookie.httpOnly` | `true` | Hide the cookie from JavaScript |
| `cookie.sameSite` | `lax` | `lax`, `strict`, or `none` |
| `cookie.partitioned` | `false` | Add the `Partitioned` attribute |
| `cookie.maxAge` | `absoluteLifetime` | Cookie lifetime in **minutes** |

Times can be numbers or numeric strings, so values from `env()` work. Invalid values stop the app from starting with a clear error.

## Session API reference

Every public function in `@holo-js/session`, grouped by task. Internal helpers and the store factories used by the drivers aren't listed.

**Create, read, and save**: [session()](#session), [createSession()](#createsession), [readSession()](#readsession), [writeSession()](#writesession), [touchSession()](#touchsession)

**Change the session**: [rotateSession()](#rotatesession), [invalidateSession()](#invalidatesession)

**Flash data**: [flashSession()](#flashsession), [takeSession()](#takesession)

**Cookies**: [cookie()](#cookie), [sessionCookie()](#sessioncookie), [rememberMeCookie()](#remembermecookie), [cookies.make()](#cookies-make), [cookies.forget()](#cookies-forget), [serializeCookie()](#serializecookie), [parseCookieHeader()](#parsecookieheader)

**Config**: [defineSessionConfig()](#definesessionconfig)

The default export, `session`, is a function that creates a session, with the same functions attached as properties (`session.read`, `session.flash`, `session.cookies.forget`, and so on).

### session()

`session(input?: { id?: string, data?: object, store?: string }): Promise<SessionRecord>`

Creates a session. It's shorthand for `createSession()`, and it's the default export of `@holo-js/session`.

### createSession()

`createSession(input?: { id?: string, data?: object, store?: string }): Promise<SessionRecord>`

Creates a session and saves it. Without an `id`, Holo generates a random one. An `id` that already exists is replaced. The `store` option picks a store from your config; it defaults to `driver`.

### readSession()

`readSession(sessionId: string, options?: { store?: string }): Promise<SessionRecord | null>`

Returns the session, or `null` when it doesn't exist or has expired. Expired records are deleted when read.

### writeSession()

`writeSession(record: SessionRecord): Promise<SessionRecord>`

Saves a record as it is, using the record's `store`. It doesn't change the expiry. Records are read-only, so spread the old one into a new object to change `data`.

### touchSession()

`touchSession(sessionId: string, options?: { store?: string }): Promise<SessionRecord | null>`

Records activity and pushes the idle expiry forward, but never past the absolute lifetime. Returns `null` when the session is gone.

### rotateSession()

`rotateSession(sessionId: string, options?: { newId?: string, data?: object, renewLifetime?: boolean, store?: string }): Promise<SessionRecord>`

Gives the session a new ID and keeps its data and flash values. `renewLifetime` restarts the lifetime. Throws when the session doesn't exist, when the `newId` already holds a session, and when a store can't keep the data. A `newId` must be unique and unused: concurrent rotations that reuse one `newId` are supported only on the file and Redis stores, where exactly one succeeds. Other stores don't support it.

### invalidateSession()

`invalidateSession(sessionId: string, options?: { store?: string }): Promise<void>`

Deletes the session from its store.

### flashSession()

`flashSession(sessionId: string, key: string, value: unknown, options?: { store?: string }): Promise<void>`

Stores a value that `takeSession()` can read once. Keys must start with a letter. See [Flash data](#flash-data) for the rules on keys and values.

### takeSession()

`takeSession<TValue = unknown>(sessionId: string, key: string, options?: { store?: string }): Promise<TValue | undefined>`

Returns the flashed value and removes it, so a second call returns `undefined`.

### cookie()

`cookie(name: string, value: string, options?: CookieSerializeOptions): string`

Returns a `Set-Cookie` header value. Options you don't pass come from the `cookie` section of your config.

```ts
import { cookie } from '@holo-js/session'

const setCookie = cookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
```

### sessionCookie()

`sessionCookie(value: string, options?: CookieSerializeOptions): string`

Like `cookie()`, but the name is your session cookie name (`holo_session` by default) and the value is encrypted with your app key.

### rememberMeCookie()

`rememberMeCookie(value: string, options?: CookieSerializeOptions): string`

Like `cookie()`, but named `<session cookie name>_remember` and the value is encrypted with your app key. It lasts `rememberMeLifetime` unless you pass `maxAge`.

### cookies.make()

`cookies.make(name: string, value: string, options?: CookieSerializeOptions): string`

The same as `cookie()`.

### cookies.forget()

`cookies.forget(name: string, options?: CookieSerializeOptions): string`

Returns a `Set-Cookie` value that deletes the cookie. It sets `maxAge` to `0` and `expires` to the Unix epoch.

```ts
import { cookies } from '@holo-js/session'

const clearCart = cookies.forget('holo_cart')
```

### serializeCookie()

`serializeCookie(name: string, value: string, options?: CookieSerializeOptions): string`

The function behind `cookie()` and `cookies.make()`. It applies the same defaults from your config and the same checks. Use `cookie()` in app code.

### parseCookieHeader()

`parseCookieHeader(header: string | null | undefined): Record<string, string>`

Turns a `Cookie` request header into an object of names and values. Returns an empty object for `null` or an empty header.

### defineSessionConfig()

`defineSessionConfig<TConfig extends HoloSessionConfig>(config: TConfig): Readonly<TConfig>`

Wraps the object in `config/session.ts` so your editor checks the shape. The options are in [Configuration reference](#configuration-reference).

## Next steps

- [Auth sessions and cookies](/auth/session-and-cookies)
- [CSRF protection](/basics/security/csrf)
- [Configuration files](/reference/config)
- [Environment variables](/reference/environment)
