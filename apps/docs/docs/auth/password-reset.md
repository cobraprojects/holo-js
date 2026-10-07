# Password Reset

Password reset tokens let the application issue one-time credentials for resetting local passwords.

## Introduction

Password reset uses the configured broker and local provider:

```ts
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'
export default defineAuthConfig({
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
      route: env('AUTH_PASSWORD_RESET_ROUTE', '/reset-password'),
    },
  },
})
```

Set the route and base app URL in the environment:

```dotenv
APP_URL=http://localhost:3000
AUTH_PASSWORD_RESET_ROUTE=/reset-password
```

The framework-generated reset email uses `APP_URL` plus the configured broker route automatically.

The application still owns the reset page and the route that calls `resetPassword(...)`. The framework owns the
generated link target and delivery URL composition.

## Requesting A Reset Token

```ts
import { requestPasswordReset } from '@holo-js/auth'

await requestPasswordReset({
  email: 'ava@example.com',
})
```

If the request fails for an expected auth reason, it throws a `ValidationException`. Its serialized payload contains
the status and field errors:

```ts
{
  ok: false,
  status: 422,
  valid: false,
  errors: {
    email: ['Email is required to request a password reset.'],
  },
}
```

The flow:

- looks up the user through the configured broker provider
- invalidates older tokens for that email
- creates a new hashed reset token
- sends the reset email through the configured delivery hook

## Resetting The Password

```ts
import { resetPassword } from '@holo-js/auth'

const resetUser = await resetPassword({
  token: body.token,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

The thrown `ValidationException` targets the submitted auth fields directly, such as `token`, `password`, and
`passwordConfirmation`. Successful calls return the updated user.

The reset flow validates the secret and claims the exact unused token while it is still unexpired. Only one
concurrent request can use a token. Before updating the user, it revokes sibling tokens for the same provider and
email in that broker's configured table. Other providers, emails, and broker tables remain unaffected.

When Core proves that the native user repository and token store share the same database context, the claim,
sibling revocation, and password mutation run in one transaction. A failed mutation rolls them all back, allowing
the valid token to be retried. A repository factory resolves once for that operation and retains its own lifetime
across separate operations.

With an external provider or a different database context, the claim and sibling revocation finish before the
password update. If that update fails, the tokens remain consumed: request a fresh reset token. A failed claim or
sibling revocation never invokes the password mutation. Different reset tokens do not hold an account-wide lock
across external provider updates.

## Custom Token Stores

Custom `PasswordResetTokenStore` implementations retain `create`, `findById`, `findLatestByEmail`, `delete`, and
`deleteByEmail`, and must implement:

```ts
redeem<TResult>(
  record: PasswordResetTokenRecord,
  operation: () => Promise<TResult>,
): Promise<TResult | null>
```

Validate the supplied record's identity, provider, email, broker table, hash, timestamps, and unused state when
claiming it, including expiry at mutation time. Return `null` when no matching claim is available; invoke the
asynchronous operation only for the winning claim and preserve its inferred result. Never substitute a lookup
followed by unconditional deletion. Auth revokes siblings within the operation before updating the user. Shared
transaction participation requires actual persistence wiring; the callback alone does not make an external
provider transactional. These single-use rules do not apply to personal access tokens or browser sessions.

## Broker Selection

Use a non-default broker when needed:

```ts
await requestPasswordReset({
  email: 'admin@example.com',
}, {
  broker: 'admins',
})
```

## Delivery

Password reset delivery works the same way as email verification:

- auth creates the token
- core builds the reset URL automatically from `APP_URL` and the configured broker route
- notifications or direct mail deliver the message when those integrations are installed

If `@holo-js/auth` and `@holo-js/notifications` are both installed with mail support, core bridges auth delivery
through notifications automatically. If notifications are absent but `@holo-js/mail` is installed, core falls back
to direct mail delivery.

When auth and notifications are scaffolded together, Holo creates editable notification files:

```txt
server/notifications/auth/email-verification.ts
server/notifications/auth/password-reset.ts
```

Existing applications can publish those files later:

```bash
npx holo auth:notifications:publish
```

The published password reset notification is a normal `defineNotification(...)` file. Its email builder receives a
small app-facing data with `email`, generated `url`, and `expiresAt`.

::: warning Delivery package required
Publishing notification files only gives the application editable message definitions. Email delivery still needs
`@holo-js/mail` or another configured notification mailer. Without delivery, auth creates the reset token and logs that
the email was skipped.
:::

Applications do not need to manually create `reset-password?token=...` URLs in normal usage.
