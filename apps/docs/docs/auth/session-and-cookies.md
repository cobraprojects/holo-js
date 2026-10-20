# Sessions and Cookies

Browser login uses a session: Holo stores the signed-in user's ID in a session store and gives the browser a cookie with the session ID. The user record itself is read from your provider on each request. This page covers the session settings that matter for auth: where sessions live, cookie options, lifetimes, remember me, and signing out other devices.

## Default setup

`npx holo install auth` creates `config/session.ts`. Every value can be changed from `.env`:

```ts [config/session.ts]
import { defineSessionConfig } from '@holo-js/session'
import { env } from '@holo-js/config'

const sessionSameSite = env('SESSION_SAME_SITE') === 'strict'
  ? 'strict'
  : env('SESSION_SAME_SITE') === 'none'
    ? 'none'
    : 'lax'

export default defineSessionConfig({
  driver: env('SESSION_DRIVER', 'file'),
  stores: {
    database: {
      driver: 'database',
      connection: env('SESSION_CONNECTION', 'default'),
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
    sameSite: sessionSameSite,
  },
  idleTimeout: env('SESSION_IDLE_TIMEOUT', 120),
  absoluteLifetime: env('SESSION_LIFETIME', 120),
  rememberMeLifetime: env('SESSION_REMEMBER_ME_LIFETIME', 43200),
})
```

You don't call the session API to log users in. `login()`, `loginUsing()`, and `logout()` create, rotate, and remove sessions and cookies for you.

## Choose a session store

`driver` picks one of the named `stores`.

| Store driver | Options | Use it when |
| --- | --- | --- |
| `file` | `path` | One server, local development |
| `database` | `connection`, `table` | Several servers sharing one database. Uses the `sessions` table from the auth migrations |
| `redis` | `connection`, `prefix` | Several servers with Redis. Requires the `ioredis` package and a Redis connection in your config |

```dotenv [.env]
SESSION_DRIVER=database
```

::: warning
With more than one server, use `database` or `redis`. File sessions live on one machine, so users would be signed out whenever a request hits another server.
:::

## Cookie options

| Option | Default | Description |
| --- | --- | --- |
| `name` | `'holo_session'` | Cookie name |
| `path` | `'/'` | Cookie path |
| `domain` | none | Set to `.example.com` to share the session across subdomains |
| `secure` | `false` | Send only over HTTPS. Turn on in production |
| `httpOnly` | `true` | Hide the cookie from browser JavaScript |
| `sameSite` | `'lax'` | `'lax'`, `'strict'`, or `'none'` |
| `partitioned` | `false` | Adds the `Partitioned` attribute |
| `maxAge` | `absoluteLifetime` | Cookie lifetime in minutes |

The session and remember-me cookies are encrypted with your app key (`APP_KEY`). The browser can't read or change the session ID. A changed cookie, or one encrypted with an old key, is treated as signed out. Changing `APP_KEY` signs everyone out.

Holo rejects cookie settings that browsers would ignore:

- `sameSite: 'none'` and `partitioned: true` need `secure: true`.
- Names starting with `__Secure-` need `secure: true`.
- Names starting with `__Host-` need `secure: true`, `path: '/'`, and no `domain`.

If your frontend runs on a different origin than your API, see [CORS and Proxies](/basics/security/cors-and-proxies).

## Session lifetime

All lifetimes are in minutes.

| Option | Default | What it controls |
| --- | --- | --- |
| `idleTimeout` | `120` | The session ends after this long without a request |
| `absoluteLifetime` | `120` | The session ends this long after it started, even if active |
| `rememberMeLifetime` | `43200` (30 days) | How long the remember-me cookie keeps the user signed in |

Holo extends the idle window on each request, up to the absolute lifetime.

## Remember me

When you pass `remember: true` to `login()` or `loginUsing()`, Holo also sets a remember-me cookie. When the session expires, the next request uses that cookie to start a fresh session, so the user stays signed in for up to `rememberMeLifetime`. The encrypted cookie includes an authenticated expiry. The server rejects it at that expiry even if a client keeps or replays the cookie.

```ts
await login({ email, password, remember: true })
```

Each user has one remember token, stored in the `remember_token` column of the `users` table. The auth migrations add it. Logging out, other-device logout, and resetting the password each replace it, so remember-me cookies issued before then stop restoring. Keep it out of JSON output with the model's `hidden` list:

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'password', 'avatar'],
  hidden: ['password', 'remember_token'],
})
```

The encrypted cookie holds the user's ID, the token, and a hash of the password hash. Holo restores the user only when the token and password still match, so changing the password ends remember me. Restoring starts a new session, so a flash message waiting in the expired browser session isn't shown.

`logout()` clears the cookies and gives the user a new remember token. Remember-me cookies on every other device stop working, but browsers that still have an active session stay signed in until that session ends. With [multi-factor auth](/auth/multi-factor), the remember-me cookie is set only after the user passes the challenge.

## Log out other devices

Each browser has its own session. Logging in on a phone doesn't sign out the laptop. To sign out everywhere else, for example after a password change, call `logoutOtherDevices()`:

```ts
import auth, { logoutOtherDevices } from '@holo-js/auth'

await logoutOtherDevices()
await auth.guard('admin').logoutOtherDevices()
```

The current browser stays signed in. Every other browser signed in as this user loses the session on its next request. Holo also gives the user a new remember token, so remember-me cookies on other devices stop working, and resends the current browser's remember-me cookie with the new token.

- Only session guards have this method. To revoke API tokens, use `tokens.revokeOthers()` from [API Tokens](/auth/api-tokens#revoke-tokens).
- For [WorkOS](/auth/workos) and [Clerk](/auth/clerk) users, it ends their Holo sessions but not their session at the hosted provider.
- Ask for the password again before calling it if the action is sensitive. Holo doesn't do that for you.

This feature uses the `auth_session_revocations` table, which the auth migrations create.

## Flash a message to the next request

Session guards can store a value for the next request only, which is handy for "Saved!" messages after a redirect:

```ts
import { flash, take } from '@holo-js/auth'

await flash('profile.updated', { message: 'Profile saved' })

const notice = await take<{ message: string }>('profile.updated')
```

`take()` returns the value once and removes it, or `undefined` if there is none. Keys start with a letter and use up to 128 letters, digits, dots, colons, dashes, or underscores. Values must be JSON-safe and at most 64 KiB.

## Several guards, one browser

A browser can be signed in to more than one guard at once, for example `web` and `admin`. Each guard keeps its own user. `logout()` on one guard leaves the others signed in.

```ts
import auth from '@holo-js/auth'

await auth.guard('admin').logout()
const siteUser = await auth.user()
```

## Use sessions for your own data

`@holo-js/session` also works on its own for carts, wizards, and other per-visitor state. See [Sessions](/basics/session).

## Next steps

- [Login and Registration](/auth/local-auth)
- [Guards and Providers](/auth/guards-and-providers)
- [CSRF Protection](/basics/security/csrf)
- [Sessions](/basics/session)

## Custom auth contexts

If you implement `AuthRuntimeContext`, provide `getRequestScope(): object` to return the same object throughout one request and a fresh object for each new request. This lets Holo restore several remembered guards concurrently into one browser session. `createMemoryAuthContext()` and `createAsyncAuthContext()` already provide it.

Remember-cookie writes require a request scope. Without one, remembered login, clearing an existing remember cookie on login or logout, and renewing it through other-device logout throw `runtime_unconfigured` before changing authentication. You can still restore remembered guards sequentially; Holo reads remember cookies without caching across calls. The optional `getRememberToken` and `setRememberToken` methods are not required for restoration.
