# Authentication

Holo Auth signs users in and keeps track of who they are. It handles password login, sessions, remember-me cookies, email verification, password resets, two-factor codes, API tokens, social login, and hosted providers like WorkOS and Clerk. Every flow ends with a user record in your own database.

## Quick example

After you install auth, a login route is a few lines. Validate the form, call `login()`, and redirect with your framework's own redirect API. Holo writes the session cookie for you.

::: code-group

```ts [Next.js]
// app/login/actions.ts
'use server'

import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { redirect } from 'next/navigation'
import { loginForm } from '@/lib/schemas/auth'

export async function loginAction(formData: FormData) {
  const input = await validate(formData, loginForm, { throttle: 'login' })

  await login(input)

  redirect('/dashboard')
}
```

```ts [Nuxt]
// server/api/login.post.ts
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, { throttle: 'login' })

  await login(input)

  return sendRedirect(event, '/dashboard', 303)
})
```

```ts [SvelteKit]
// src/routes/login/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, loginForm, { throttle: 'login' })

    await login(input)

    redirect(303, '/dashboard')
  },
} satisfies Actions
```

:::

The `loginForm` schema is a normal [validation schema](/basics/validation/):

```ts [lib/schemas/auth.ts]
import { field, schema } from '@holo-js/validation'

export const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required(),
  remember: field.boolean().default(false),
})
```

If the email or password is wrong, `login()` throws a validation error on the `email` field ("These credentials do not match our records."), and your form shows it like any other validation error.

## Install auth

```bash
npx holo install auth
npx holo migrate
```

The install command adds:

| File or folder | What it is |
| --- | --- |
| `config/auth.ts` | Guards, user providers, password reset, and email verification settings |
| `config/session.ts` | Session store and cookie settings |
| `config/security.ts` | CSRF and rate limiting, with `login` and `register` limiters |
| `config/cors.ts` | CORS settings for a separate frontend |
| `server/models/User.ts` | The `User` model, with `password` hidden from JSON |
| Migrations | `users`, `sessions`, `auth_identities`, `personal_access_tokens`, `password_reset_tokens`, `email_verification_tokens`, `auth_multi_factor_credentials`, `auth_session_revocations` |
| `.env` keys | `AUTH_*` and `SESSION_*` values |
| Current-user endpoint | `GET /api/auth/user`, used by [`useAuth()`](/auth/current-user) |

Auth does not create login, register, or logout pages. You write those routes yourself, as shown in [Login and Registration](/auth/local-auth).

### Add social or hosted login

Pass flags to add more sign-in options. You can run the command again later; it adds to your existing setup.

```bash
npx holo install auth --social --provider google,github
npx holo install auth --workos
npx holo install auth --clerk
```

`--social` without `--provider` installs Google. See [Social Login](/auth/social-login), [WorkOS](/auth/workos), and [Clerk](/auth/clerk).

## Configure auth

This is the `config/auth.ts` that the installer creates, trimmed to the parts you'll change most:

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  defaults: {
    guard: env('AUTH_GUARD', 'web'),
    passwords: env('AUTH_PASSWORD_BROKER', 'users'),
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
      identifiers: ['email'],
    },
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
      route: '/reset-password',
    },
  },
  emailVerification: {
    required: false,
    route: '/verify-email',
  },
})
```

- A **guard** decides how a request is authenticated: with a session cookie (`session`) or a bearer token (`token`).
- A **provider** points a guard at a model and lists the fields users sign in with (`identifiers`).

Most apps only need the default `web` guard. See [Guards and Providers](/auth/guards-and-providers) to add an admin area or an API.

### All config options

| Option | Default | Description |
| --- | --- | --- |
| `defaults.guard` | `'web'` | Guard used by `login()`, `user()`, and the other top-level helpers |
| `defaults.passwords` | `'users'` | Password reset broker used by `requestPasswordReset()` |
| `guards` | `{ web: { driver: 'session', provider: 'users' } }` | See [Guards and Providers](/auth/guards-and-providers) |
| `providers` | `{ users: { model: 'User', identifiers: ['email'] } }` | See [Guards and Providers](/auth/guards-and-providers) |
| `passwords` | one `users` broker | See [Password Reset](/auth/password-reset) |
| `emailVerification` | `{ required: false, route: '/verify-email' }` | `true`, `false`, or an object. See [Email Verification](/auth/email-verification) |
| `multiFactor` | disabled | `true` or an object. See [Multi-Factor Auth](/auth/multi-factor) |
| `personalAccessTokens.defaultAbilities` | `['*']` | Abilities given to new API tokens. See [API Tokens](/auth/api-tokens) |
| `social` | `{}` | See [Social Login](/auth/social-login) |
| `socialEncryptionKey` | your `APP_KEY` | Key used when `encryptTokens` is on for a social provider |
| `workos` | `{}` | See [WorkOS](/auth/workos) |
| `clerk` | `{}` | See [Clerk](/auth/clerk) |

## Read the current user

On the server, import the helpers from `@holo-js/auth`:

```ts
import { check, id, user } from '@holo-js/auth'

const signedIn = await check()
const currentUser = await user()
const currentUserId = await id()
```

In components, use `useAuth()` from your framework's auth entry point. See [Current User on the Client](/auth/current-user).

::: warning Server only
`@holo-js/auth` can create sessions, hash passwords, and issue tokens. Import it only in server code. Client code uses `@holo-js/auth/next/client`, `@holo-js/auth/nuxt`, or `@holo-js/auth/sveltekit/client`, which can only read the current user.
:::

## Pick a sign-in method

| You want | Use |
| --- | --- |
| Email and password in a browser | [Login and Registration](/auth/local-auth) with a session guard |
| Mobile or third-party API clients | [API Tokens](/auth/api-tokens) with a token guard |
| "Continue with Google/GitHub/..." | [Social Login](/auth/social-login) |
| A hosted sign-in page with SSO | [WorkOS](/auth/workos) or [Clerk](/auth/clerk) |
| A second factor after the password | [Multi-Factor Auth](/auth/multi-factor) |

## Auth API reference

Every public function in the auth packages, grouped by task. Server functions come from `@holo-js/auth`. Browser, framework, social, and hosted-login helpers come from their own entry points, noted under each group. Internal helpers and the `configure*` and `reset*` runtime functions are left out.

**Current user (server)**: [check()](#check), [user()](#user), [id()](#id), [provider()](#provider), [refreshUser()](#refreshuser), [findUserById()](#finduserbyid), [currentAccessToken()](#currentaccesstoken)

**Sign in and out**: [login()](#login), [loginUsing()](#loginusing), [loginUsingId()](#loginusingid), [register()](#register), [logout()](#logout), [logoutOtherDevices()](#logoutotherdevices)

**Flash data**: [flash()](#flash), [take()](#take)

**Impersonation**: [impersonate()](#impersonate), [impersonateById()](#impersonatebyid), [impersonation()](#impersonation), [stopImpersonating()](#stopimpersonating)

**Password reset**: [requestPasswordReset()](#requestpasswordreset), [resetPassword()](#resetpassword)

**Email verification**: [verifyEmail()](#verifyemail), [sendEmailVerification()](#sendemailverification), [resendEmailVerification()](#resendemailverification), [verification.create()](#verification-create), [verification.resend()](#verification-resend), [verification.consume()](#verification-consume)

**Passwords**: [hashPassword()](#hashpassword), [verifyPassword()](#verifypassword), [needsPasswordRehash()](#needspasswordrehash)

**Multi-factor**: [multiFactor.status()](#multifactor-status), [multiFactor.beginEnrollment()](#multifactor-beginenrollment), [multiFactor.confirmEnrollment()](#multifactor-confirmenrollment), [multiFactor.challenge()](#multifactor-challenge), [multiFactor.recover()](#multifactor-recover), [multiFactor.disable()](#multifactor-disable), [multiFactor.regenerateRecoveryCodes()](#multifactor-regeneraterecoverycodes)

**API tokens**: [tokens.create()](#tokens-create), [tokens.list()](#tokens-list), [tokens.revoke()](#tokens-revoke), [tokens.revokeOthers()](#tokens-revokeothers), [tokens.revokeAll()](#tokens-revokeall), [tokens.authenticate()](#tokens-authenticate), [tokens.can()](#tokens-can)

**Guards**: [guard()](#guard)

**Errors and config**: [AuthError](#autherror), [isAuthError()](#isautherror), [AUTH_ERROR_CODES](#auth-error-codes), [defineAuthConfig()](#defineauthconfig), [user.can()](#user-can)

**Browser client** (`@holo-js/auth/client`): [check() in the browser client](#check-in-the-browser-client), [user() in the browser client](#user-in-the-browser-client), [provider() in the browser client](#provider-in-the-browser-client), [refreshUser() in the browser client](#refreshuser-in-the-browser-client), [useAuth() in the browser client](#useauth-in-the-browser-client)

**Next.js** (`@holo-js/auth/next/client`, `@holo-js/auth/next/server`): [AuthProvider](#authprovider), [useAuth() in Next.js](#useauth-in-next-js), [auth() in Next.js](#auth-in-next-js), [guestOnly()](#guestonly), [authOnly()](#authonly), [protectRoutes()](#protectroutes), [getCurrentNextAuthRequest()](#getcurrentnextauthrequest), [runWithNextAuthRequest()](#runwithnextauthrequest)

**Nuxt** (`@holo-js/auth/nuxt`, `@holo-js/auth/nuxt/server`): [useAuth() in Nuxt](#useauth-in-nuxt)

**SvelteKit** (`@holo-js/auth/sveltekit/client`, `@holo-js/auth/sveltekit/server`): [useAuth() in SvelteKit](#useauth-in-sveltekit), [auth() in SvelteKit](#auth-in-sveltekit), [setAuthContext()](#setauthcontext), [getAuthContext()](#getauthcontext)

**Social login** (`@holo-js/auth-social`): [redirect()](#redirect), [callback()](#callback), [socialAuth](#socialauth), [Social provider packages](#social-provider-packages)

**WorkOS and Clerk** (`@holo-js/auth-workos`, `@holo-js/auth-clerk`): [verifySession()](#verifysession), [verifyRequest()](#verifyrequest), [syncIdentity()](#syncidentity), [authenticate()](#authenticate), [loginWithWorkos()](#loginwithworkos), [loginWithClerk()](#loginwithclerk), [registerWithWorkos()](#registerwithworkos), [registerWithClerk()](#registerwithclerk), [logoutWithWorkos()](#logoutwithworkos), [logoutWithClerk()](#logoutwithclerk), [completeWorkosAuth()](#completeworkosauth), [completeClerkAuth()](#completeclerkauth), [WorkosAuthConflictError and ClerkAuthConflictError](#hosted-conflict-errors)

**Current user (server)**

### check()

`check(): Promise<boolean>`

Returns `true` when a user is signed in on the default guard.

```ts
import { check } from '@holo-js/auth'

if (!(await check())) {
  return Response.redirect(new URL('/login', request.url), 303)
}
```

### user()

`user(): Promise<AuthenticatedAuthUser | null>`

Returns the signed-in user on the default guard, or `null`. The user also has `can()` for [authorization checks](#user-can).

### id()

`id(): Promise<string | number | null>`

Returns the signed-in user's ID, or `null` when nobody is signed in.

### provider()

`provider(): Promise<string | null>`

Returns the name of the user provider the signed-in user came from, such as `'users'`, `'workos'`, or `'clerk'`. Returns `null` for guests.

### refreshUser()

`refreshUser(): Promise<AuthenticatedAuthUser | null>`

Reads the signed-in user from the database again, skipping the per-request cache. Use it after you change the user's profile in the same request.

### findUserById()

`findUserById(id: string | number): Promise<AuthenticatedAuthUser | null>`

Loads any user from the default guard's provider by ID. It doesn't sign that user in.

### currentAccessToken()

`currentAccessToken(): Promise<AuthCurrentAccessToken | null>`

Returns the API token that authenticated the current request, or `null` on session guards and when no valid token was sent. The result has the token's `id`, `name`, `abilities`, `createdAt`, `expiresAt`, plus `can(ability)` and `delete()`.

```ts
import { currentAccessToken } from '@holo-js/auth'

const token = await currentAccessToken()
if (!token?.can('posts.write')) {
  return Response.json({ message: 'Forbidden' }, { status: 403 })
}
```

**Sign in and out**

### login()

`login(credentials): Promise<AuthEstablishedSession>`

Checks the identifier (such as `email`) and `password` against the default guard's provider, then starts a session. Pass `remember: true` to keep the user signed in longer.

```ts
import { login } from '@holo-js/auth'

const session = await login({ email, password, remember: true })

if (session.multiFactorChallenge) {
  redirect(session.multiFactorChallenge.route)
}
```

Wrong credentials throw a validation exception with field errors, so your form shows them like any other validation error. If [multi-factor auth](/auth/multi-factor) is enabled for the user, the session has a `multiFactorChallenge` and the user isn't fully signed in until they pass it. The result also includes `guard`, `provider`, `user`, `sessionId`, `rememberToken`, `cookies`, and `emailVerificationRequired`.

### loginUsing()

`loginUsing(user: unknown, options?: { remember?: boolean }): Promise<AuthEstablishedSession>`

Signs in a user you already loaded, without checking a password. Use it after [social login](/auth/social-login) or for admin tools. Pass the user object, or a serialized user. Passing a user from another provider throws an `AuthError` with a `trusted_login_*` code.

### loginUsingId()

`loginUsingId(userId: string | number, options?: { remember?: boolean }): Promise<AuthEstablishedSession>`

Same as `loginUsing()` but takes only the ID. It throws `trusted_login_user_not_found` when no user has that ID.

### register()

`register(input): Promise<AuthenticatedAuthUser>`

Creates a user on the default guard and returns it without signing them in. The input must include the identifier fields (for example `email`), `password`, and `passwordConfirmation`. Other fields, such as `name`, are saved too. The `remember` field is ignored here.

```ts
import { register } from '@holo-js/auth'

await register({
  name: 'Ava',
  email: 'ava@example.com',
  password,
  passwordConfirmation,
})
```

When [email verification](/auth/email-verification) is required, `register()` also sends the verification email. Duplicate emails and mismatched passwords throw a validation exception.

### logout()

`logout(): Promise<{ guard: string, cookies: readonly string[] }>`

Ends the signed-in session for the default guard. Holo sends the cookie changes on the current response, and `cookies` lists them.

### logoutOtherDevices()

`logoutOtherDevices(): Promise<void>`

Signs the user out of every other browser and keeps the current one signed in. It needs the durable session revocation store that the app runtime sets up. Throws `auth_user_missing` if the current browser isn't signed in.

**Flash data**

### flash()

`flash(key: string, value: unknown): Promise<void>`

Stores a value in the signed-in session for the next request only. Does nothing when there is no session.

### take()

`take<TValue = unknown>(key: string): Promise<TValue | undefined>`

Reads a flashed value and removes it, so the next call returns `undefined`.

```ts
import { flash, take } from '@holo-js/auth'

await flash('status', 'Password updated.')
const status = await take<string>('status')
```

**Impersonation**

Impersonation lets an admin sign in as another user and return later. Impersonation sessions can't be nested.

### impersonate()

`impersonate(user: unknown, options?: { remember?: boolean, actorGuard?: string }): Promise<AuthEstablishedSession>`

Signs in as `user` on the default guard while remembering the actor. The actor must be signed in on `actorGuard` (defaults to the same guard). Throws `impersonation_actor_required`, `impersonation_nested_unsupported`, or `impersonation_already_active` when the rules aren't met.

### impersonateById()

`impersonateById(userId: string | number, options?): Promise<AuthEstablishedSession>`

Same as `impersonate()` but takes a user ID.

### impersonation()

`impersonation(): Promise<AuthImpersonationState | null>`

Returns the current impersonation, or `null`. The state has `guard`, `actorGuard`, `user` (the impersonated user), `actor`, `originalUser`, and `startedAt`.

### stopImpersonating()

`stopImpersonating(): Promise<AuthenticatedAuthUser | null>`

Returns to the original user and returns that user. Returns `null` when no impersonation is active.

**Password reset**

### requestPasswordReset()

`requestPasswordReset(input: { email: string }, options?: { broker?: string, expiresAt?: Date }): Promise<void>`

Creates a reset token and emails it. It doesn't reveal whether the email exists: unknown emails return normally. A blank email throws a validation exception. A second request inside the broker's `throttle` window is ignored. See [Password Reset](/auth/password-reset).

### resetPassword()

`resetPassword(input: { token: string, password: string, passwordConfirmation: string }): Promise<AuthenticatedAuthUser>`

Checks the token, saves the new password, deletes the email's other reset tokens, and returns the user. An invalid or expired token, or mismatched passwords, throw a validation exception.

**Email verification**

### verifyEmail()

`verifyEmail(token: string): Promise<AuthenticatedAuthUser>`

Marks the user's email as verified and returns the user. An invalid or expired token throws a validation exception on the `token` field.

### sendEmailVerification()

`sendEmailVerification(email?: string, options?: { guard?: string, expiresAt?: Date }): Promise<EmailVerificationTokenResult>`

Creates a new verification link and emails it. With no `email`, it uses the signed-in user. With an `email`, it finds the user by that address, so guests can request a link too. Throws `email_verification_user_missing` (401) when there's no user, and `email_already_verified` (409) when the email is already verified.

### resendEmailVerification()

`resendEmailVerification(email?: string, options?: { guard?: string, expiresAt?: Date }): Promise<EmailVerificationTokenResult>`

The same function as `sendEmailVerification()`, with the name you'd use in a "resend" button.

### verification.create()

`verification.create(user: unknown, options?: { guard?: string, expiresAt?: Date }): Promise<EmailVerificationTokenResult>`

Creates a link for a user object and emails it. It replaces the user's previous link. The default lifetime is one hour. Use it when you already have the user, for example after an import.

### verification.resend()

`verification.resend(options?: { guard?: string, expiresAt?: Date, email?: string }): Promise<EmailVerificationTokenResult>`

Creates and emails a new link, taking the same options as `sendEmailVerification()` in one object.

### verification.consume()

`verification.consume(plainTextToken: string): Promise<AuthenticatedAuthUser>`

Marks the email as verified for the token's user. `verifyEmail()` calls it for you.

**Passwords**

Holo hashes passwords with scrypt by default. These helpers use the same hasher as login and registration, and they work without a configured auth runtime.

### hashPassword()

`hashPassword(password: string): Promise<string>`

Returns a password digest to store.

### verifyPassword()

`verifyPassword(password: string, digest: string): Promise<boolean>`

Returns `true` when the plain password matches the digest.

### needsPasswordRehash()

`needsPasswordRehash(digest: string): Promise<boolean>`

Returns `true` when the stored digest was made with older settings and should be replaced. Call it after a successful login, then save `hashPassword()` again.

**Multi-factor**

These methods work on the default session guard (or `auth.guard(name).multiFactor`). The setup and options are in [Multi-Factor Auth](/auth/multi-factor).

### multiFactor.status()

`multiFactor.status(): Promise<{ enabled: boolean, recoveryCodesRemaining: number }>`

Returns whether the signed-in user has MFA on and how many recovery codes are left.

### multiFactor.beginEnrollment()

`multiFactor.beginEnrollment(): Promise<{ expiresAt: Date, manualKey: string, otpauthUri: string }>`

Starts setup. Show `otpauthUri` as a QR code, or `manualKey` for manual entry. The user must have signed in recently, or it throws `multi_factor_reauthentication_required`.

### multiFactor.confirmEnrollment()

`multiFactor.confirmEnrollment(input: { code: string }): Promise<{ recoveryCodes: readonly string[] }>`

Confirms the first code from the authenticator app, turns MFA on, and returns the recovery codes. Show the codes once.

### multiFactor.challenge()

`multiFactor.challenge(input: { code: string }): Promise<AuthEstablishedSession>`

Completes a login that returned a `multiFactorChallenge`, using a current app code.

### multiFactor.recover()

`multiFactor.recover(input: { code: string }): Promise<AuthEstablishedSession>`

Completes a pending login with one of the user's recovery codes. Each code works once.

### multiFactor.disable()

`multiFactor.disable(input: { method: 'totp' | 'recovery', code: string }): Promise<void>`

Turns MFA off after the user proves they have a current app code or recovery code.

### multiFactor.regenerateRecoveryCodes()

`multiFactor.regenerateRecoveryCodes(input: { method: 'totp' | 'recovery', code: string }): Promise<{ recoveryCodes: readonly string[] }>`

Replaces all recovery codes after the same proof as `disable()`, and returns the new codes.

**API tokens**

The `tokens` helpers manage personal access tokens. Token guards and their setup are in [API Tokens](/auth/api-tokens).

### tokens.create()

`tokens.create(user: unknown, options: { name: string, abilities?: readonly string[], expiresAt?: Date | null, guard?: string }): Promise<PersonalAccessTokenResult>`

Creates a token for the user. The result's `plainTextToken` is the only time the secret is available, so return it to the client right away. Without `abilities`, the token gets the configured defaults (`['*']` unless you change `personalAccessTokens.defaultAbilities`).

```ts
import { tokens } from '@holo-js/auth'

const token = await tokens.create(user, { name: 'Mobile app', abilities: ['posts.*'] })
return Response.json({ token: token.plainTextToken })
```

### tokens.list()

`tokens.list(user: unknown, options?: { guard?: string }): Promise<readonly PersonalAccessTokenRecord[]>`

Lists a user's tokens. The plain-text secret isn't included.

### tokens.revoke()

`tokens.revoke(options?: { guard?: string }): Promise<void>`

Deletes the token that authenticated the current request. Does nothing when there isn't one.

### tokens.revokeOthers()

`tokens.revokeOthers(options?: { guard?: string }): Promise<number>`

Deletes the user's other tokens and keeps the current one. Returns how many were deleted. Throws when the request has no valid token.

### tokens.revokeAll()

`tokens.revokeAll(user: unknown, options?: { guard?: string }): Promise<number>`

Deletes every token the user has, and returns how many were deleted.

### tokens.authenticate()

`tokens.authenticate(plainTextToken: string): Promise<AuthenticatedAuthUser | null>`

Turns a token string into its user, or `null` when the token is unknown, revoked, or expired.

### tokens.can()

`tokens.can(token: string, ability: string): Promise<boolean>`

Checks whether a token string grants an ability. `'*'` grants everything, and `'posts.*'` grants `'posts.read'` and `'posts.write'`.

**Guards**

### guard()

`guard(name: string): AuthSessionGuardFacade | AuthTokenGuardFacade`

Returns the same functions as above, scoped to one guard. Use it for an admin area or an API guard:

```ts
import auth from '@holo-js/auth'

const admin = auth.guard('admin')
const adminUser = await admin.user()
await admin.logout()
```

Session guards have every function on this page. Token guards have `check`, `user`, `refreshUser`, `findUserById`, `provider`, `id`, `currentAccessToken`, `login`, `register`, and `logout`, where `login` and `register` return a token instead of a session. Unknown guard names throw `guard_not_configured`. See [Guards and Providers](/auth/guards-and-providers).

**Errors and config**

### AuthError

`new AuthError(code, message, options?: { cause?: unknown, details?: Record<string, unknown> })`

The error for auth failures that aren't form errors, such as `impersonation_already_active`. It has `name` (`'AuthError'`), `code`, `message`, and optional `details`. Check the `code` to decide what to show:

```ts
import { AuthError, isAuthError } from '@holo-js/auth'

try {
  await multiFactor.disable({ method: 'totp', code })
} catch (error) {
  if (isAuthError(error) && error.code === 'multi_factor_code_invalid') {
    return 'That code is wrong.'
  }
  throw error
}
```

### isAuthError()

`isAuthError(value: unknown): value is AuthError`

Returns `true` for an `AuthError`, including one from another copy of the package, if its `name`, `code`, and `message` match.

### AUTH_ERROR_CODES

`AUTH_ERROR_CODES: readonly string[]`

Every code an `AuthError` can have. Form failures from `login()`, `register()`, `verifyEmail()`, `resetPassword()`, and `requestPasswordReset()` surface as validation exceptions, not as `AuthError`, so their codes aren't listed on this page.

| Code | Meaning |
| --- | --- |
| `runtime_unconfigured` | The auth runtime isn't set up, or other-device logout has no revocation store |
| `token_runtime_unconfigured` | Token guards are used without the personal access token store |
| `email_verification_runtime_unconfigured` | Email verification is used without its token store |
| `password_reset_runtime_unconfigured` | Password reset is used without its token store |
| `guard_not_configured` | `guard(name)` names a guard that isn't in `config/auth.ts` |
| `provider_not_configured` | A guard points at a provider that isn't configured |
| `provider_runtime_not_configured` | A provider exists in config but has no adapter at runtime |
| `guard_session_login_unsupported` | Reserved. The current runtime doesn't throw it |
| `credentials_identifier_missing` | Credentials don't include any configured identifier field |
| `password_confirmation_mismatch` | `password` and `passwordConfirmation` differ |
| `invalid_credentials` | Wrong identifier or password |
| `email_verification_required` | The user must verify their email before signing in |
| `trusted_login_user_required` | `loginUsing()` got no user or ID |
| `trusted_login_provider_mismatch` | The user came from a different provider than the guard |
| `trusted_login_user_not_found` | `loginUsingId()` or a serialized user points at a user that doesn't exist |
| `trusted_login_user_incompatible` | The value can't be read as a user for this provider |
| `impersonation_actor_required` | Impersonating without a signed-in actor on the actor guard |
| `impersonation_nested_unsupported` | The actor is already impersonating someone |
| `impersonation_already_active` | The target guard is already impersonating someone |
| `registration_identifier_taken` | Another user already has this email or identifier |
| `auth_user_missing` | The user to update or sign out no longer exists, or the browser isn't signed in |
| `provider_resolution_required` | Holo can't tell which provider a user belongs to. Pass a `guard` |
| `provider_update_unsupported` | The provider doesn't implement `update()`, which verification and reset need |
| `email_required_for_verification` | The user has no email to verify |
| `email_verification_user_missing` | Resend without a signed-in user or a matching email |
| `email_already_verified` | The email is already verified |
| `email_verification_token_invalid` | The verification token is malformed |
| `email_verification_token_expired` | The verification token is unknown, expired, or already used |
| `password_reset_email_required` | `requestPasswordReset()` got a blank email |
| `password_broker_not_configured` | The password broker option names a broker that isn't configured |
| `password_reset_token_invalid` | The reset token is malformed |
| `password_reset_token_expired` | The reset token is unknown, expired, or already used |
| `password_reset_user_missing` | The user for the reset token no longer exists |
| `multi_factor_runtime_unconfigured` | MFA is used without a rate-limit or session store it needs |
| `multi_factor_encryption_key_missing` | MFA is used without an encryption key (`APP_KEY`) |
| `multi_factor_authentication_required` | An MFA settings method was called without a signed-in user, or on a token guard |
| `multi_factor_already_enabled` | MFA is already on for this user |
| `multi_factor_not_enabled` | MFA is off for this user |
| `multi_factor_enrollment_missing` | `confirmEnrollment()` ran with no pending enrollment |
| `multi_factor_enrollment_expired` | The pending enrollment expired |
| `multi_factor_reauthentication_required` | The user must sign in again before enrolling |
| `multi_factor_code_invalid` | The app code or recovery code is wrong, already used, or rate-limited |
| `multi_factor_challenge_missing` | No MFA login is waiting for a code |
| `multi_factor_challenge_expired` | The pending MFA login expired |

### defineAuthConfig()

`defineAuthConfig<TConfig extends HoloAuthConfig>(config: TConfig): Readonly<TConfig>`

Wraps the object in `config/auth.ts` so your editor checks the shape. The options are in [Configure auth](#configure-auth).

### user.can()

`user.can(action: string, target: object): Promise<boolean>`

Available on the user returned by `user()`, `login()`, and the other functions above. It checks a [policy](/authorization/policies) for that user, and it's the same as calling `authorization.forUser(user).can(action, target)`.

```ts
const currentUser = await user()

if (await currentUser?.can('update', post)) {
  // show the edit button
}
```

**Browser client**

These helpers run in the browser and only read the current user from `GET /api/auth/user`. They come from `@holo-js/auth/client`. Results are cached per endpoint and guard until `refreshUser()` runs. The Next.js, Nuxt, and SvelteKit adapters use the same endpoint.

### check() in the browser client

`check(options?: AuthClientRequestOptions): Promise<boolean>`

Returns `true` when someone is signed in.

### user() in the browser client

`user(options?: AuthClientRequestOptions): Promise<HoloAuthUser | null>`

Returns the signed-in user's fields, or `null`.

### provider() in the browser client

`provider(options?: AuthClientRequestOptions): Promise<string | null>`

Returns the provider name, such as `'users'` or `'workos'`, or `null`.

### refreshUser() in the browser client

`refreshUser(options?: AuthClientRequestOptions): Promise<HoloAuthUser | null>`

Requests the user again, skipping the cache.

### useAuth() in the browser client

`useAuth(options?: AuthClientRequestOptions): Promise<CurrentAuthResponse & { check(): boolean, refreshUser(): Promise<HoloAuthUser | null> }>`

Loads the current-user response once and returns it with `check()` and `refreshUser()`. The response includes `authenticated`, `guard`, `provider`, and `user`.

`AuthClientRequestOptions` takes `guard` (for example `'admin'`), `endpoint` (the URL to call), and `headers`.

**Next.js**

### AuthProvider

`<AuthProvider initialUser? initialProvider? endpoint? guard? headers?>` from `@holo-js/auth/next/client`

Holds the current user for every component under it, and refreshes it on mount and on each route change. Pass `initialUser` and `initialProvider` from a server component to skip the first request.

### useAuth() in Next.js

`useAuth(options?: { endpoint?, guard?, headers?, initialUser?, initialProvider? }): { authenticated: boolean, provider: string | null, user: HoloAuthUser | null, refreshUser(): Promise<HoloAuthUser | null> }`

Client hook from `@holo-js/auth/next/client`. Inside `<AuthProvider>` it returns the shared state. Outside it, the hook loads the user for that component. Calling it with options always loads its own copy.

### auth() in Next.js

`auth(options?: { guard?: string }): Promise<{ authenticated: boolean, guard: string, provider: string | null, user: HoloAuthUser | null }>`

Server function from `@holo-js/auth/next/server`. Use it in Server Components, route handlers, and actions to read the user. If the auth lookup fails, it logs a warning and returns `authenticated: false`.

### guestOnly()

`guestOnly(options: { redirectTo: string, routes?: RouteMatcher[], guard?: string, status?: 301 | 302 | 303 | 307 | 308 }): (request) => Response | undefined`

Returns a `proxy.ts` function that redirects signed-in users away from the matched routes. `routes` takes strings (`'/login'`, or `'/dashboard/*'` for a prefix), a `RegExp`, or a function. It defaults to every route, and `status` defaults to `303`.

### authOnly()

`authOnly(options: { redirectTo: string, routes?: RouteMatcher[], guard?: string, status?: ... }): (request) => Response | undefined`

Same as `guestOnly()`, but redirects guests away from the matched routes.

### protectRoutes()

`protectRoutes(...proxies): (request) => Promise<Response | undefined>`

Runs several route guards in order and returns the first redirect.

```ts [proxy.ts]
import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'

export const proxy = protectRoutes(
  guestOnly({ routes: ['/login'], redirectTo: '/dashboard' }),
  authOnly({ routes: ['/dashboard/*'], redirectTo: '/login' }),
)
```

### getCurrentNextAuthRequest()

`getCurrentNextAuthRequest(): NextAuthRequestLike | undefined`

Returns the request that `runWithNextAuthRequest()` stored for the current call, or `undefined`.

### runWithNextAuthRequest()

`runWithNextAuthRequest<T>(request: NextAuthRequestLike, callback: () => T): T`

Runs `callback` with `request` available to the auth helpers. Holo's route guards use it, so you rarely call it yourself.

**Nuxt**

### useAuth() in Nuxt

`useAuth(options?: { endpoint?: string, guard?: string, key?: string }): Promise<{ authenticated: ComputedRef<boolean>, provider: Ref<string | null>, user: Ref<HoloAuthUser | null>, refreshUser(): Promise<HoloAuthUser | null> }>`

Composable from `@holo-js/auth/nuxt`. `await` it in `<script setup>`. The state is shared through `useState`, so every component that uses the same `key` sees the same user. Use `key` when you need a second copy for another endpoint.

```vue [app/components/UserMenu.vue]
<script setup lang="ts">
const auth = await useAuth()
</script>

<template>
  <p v-if="auth.authenticated.value">Hi, {{ auth.user.value?.name }}</p>
</template>
```

Nuxt route guards come from `@holo-js/auth/nuxt/server`, as `guestOnly()` and `authOnly()`. They return named or global route middleware, and their options are the same as in Next.js. Use `definePageMeta({ middleware: 'guest' })` to attach one to a page.

**SvelteKit**

### useAuth() in SvelteKit

`useAuth(options?: { endpoint?, guard?, headers?, initialUser?, initialProvider? }): { readonly authenticated: boolean, readonly provider: string | null, readonly user: HoloAuthUser | null, refreshUser(): Promise<HoloAuthUser | null> }`

Call it in a component's `<script>`. It reads the state from Svelte's component context, so child components that call `useAuth()` with no options get the same object. The properties are reactive, and `refreshUser()` fetches the user again.

### auth() in SvelteKit

`auth(options?: { guard?: string }): Promise<{ authenticated: boolean, guard: string, provider: string | null, user: HoloAuthUser | null }>`

Server function from `@holo-js/auth/sveltekit/server`. Use it in `load` functions, actions, and endpoints. It logs a warning and returns `authenticated: false` if the lookup fails.

Route guards for SvelteKit are `guestOnly()` and `authOnly()` from `@holo-js/auth/sveltekit/server`. They return a `handle` that you combine with `sequence()` in `hooks.server.ts`. The options are the same as the Next.js guards.

### setAuthContext()

`setAuthContext(auth: UseAuthResult): UseAuthResult`

Stores an auth object in Svelte's component context and returns it. `useAuth()` already does this. Call it yourself only to share an object you created.

### getAuthContext()

`getAuthContext(): UseAuthResult | undefined`

Reads the object that `setAuthContext()` or `useAuth()` stored in the current component tree. Returns `undefined` outside a component.

**Social login**

These come from `@holo-js/auth-social`. The setup and routes are in [Social Login](/auth/social-login).

### redirect()

`redirect(provider: string, request: Request): Promise<Response>`

Starts the login with the named provider. It returns a `302` to the provider's sign-in page and sets a state cookie. Use it in your start route.

### callback()

`callback(provider: string, request: Request): Promise<SocialCallbackResult>`

Finishes the login. It checks the state, exchanges the code, and finds or creates the local user. It returns `{ ok: true, guard, authProvider, provider, user }` on success, or `{ ok: false, status: 400, message }` when the state or code is missing or expired. Provider errors are thrown. If the provider's verified email matches a local user whose email isn't verified, it throws a `SocialAuthConflictError` instead of linking. See [Link an existing account](/auth/social-login#link-an-existing-account). Sign the user in with `auth.guard(result.guard).loginUsing(result.user)`.

### socialAuth

`socialAuth: { redirect, callback }`

An object with the same two functions, for code that prefers one import.

### Social provider packages

Each provider is a package that exports a `SocialProviderRuntime`. Holo loads it by name from `config/auth.ts`, so you don't call these directly. Import one only to wrap it in your own runtime.

| Export | Package |
| --- | --- |
| `googleSocialProvider` | `@holo-js/auth-social-google` |
| `githubSocialProvider` | `@holo-js/auth-social-github` |
| `discordSocialProvider` | `@holo-js/auth-social-discord` |
| `facebookSocialProvider` | `@holo-js/auth-social-facebook` |
| `appleSocialProvider` | `@holo-js/auth-social-apple` |
| `linkedinSocialProvider` | `@holo-js/auth-social-linkedin` |

Each package also exports its runtime as the default export.

**WorkOS and Clerk**

`@holo-js/auth-workos` and `@holo-js/auth-clerk` export the same functions with the same behavior. The setup, routes, and matching rules are in [WorkOS](/auth/workos) and [Clerk](/auth/clerk). Each function takes an optional `provider` name when you have more than one hosted provider.

### verifySession()

`verifySession(token: string, provider?: string): Promise<WorkosVerifiedSession | ClerkVerifiedSession | null>`

Checks a session token with the provider. Returns the verified session, or `null` when it's invalid.

### verifyRequest()

`verifyRequest(request: Request, provider?: string): Promise<WorkosVerifiedSession | ClerkVerifiedSession | null>`

Reads the session token from the request, a `Bearer` header, or the provider's session cookie, then verifies it.

### syncIdentity()

`syncIdentity(session, provider?: string, options?: { user?: UserMapper }): Promise<WorkosAuthenticationResult | ClerkAuthenticationResult>`

Creates, updates, or links the local user for a verified session, and returns `status` as `'created'`, `'updated'`, `'linked'`, or `'relinked'`. When the provider's email matches an existing user who isn't linked yet, it throws the conflict error described at [the bottom of this section](#hosted-conflict-errors). Pass `user` to map extra profile fields onto the user.

### authenticate()

`authenticate(request: Request, provider?: string): Promise<WorkosAuthenticationResult | ClerkAuthenticationResult | null>`

Verifies the request, syncs the user, and starts a Holo session in one call. Use it in API routes that receive a hosted-provider token. Returns `null` when no valid session is present.

### loginWithWorkos()

`loginWithWorkos(request: Request, options?: { provider?: string }): Promise<Response>`

Redirects to the WorkOS sign-in page. Use it in your login route.

### loginWithClerk()

`loginWithClerk(request: Request, options?: { provider?: string }): Promise<Response>`

Redirects to the Clerk sign-in page.

### registerWithWorkos()

`registerWithWorkos(request: Request, options?: { provider?: string }): Promise<Response>`

Redirects to the WorkOS sign-up page.

### registerWithClerk()

`registerWithClerk(request: Request, options?: { provider?: string }): Promise<Response>`

Redirects to the Clerk sign-up page.

### logoutWithWorkos()

`logoutWithWorkos(request: Request, options?: { provider?: string, returnTo?: string }): Promise<Response>`

Ends the local session, then redirects to WorkOS to end its session too. `returnTo` is where WorkOS sends the user afterward. The response clears the Holo session cookies.

### logoutWithClerk()

`logoutWithClerk(request: Request, options?: { provider?: string, returnTo?: string }): Promise<Response>`

Ends the local session, then redirects to Clerk to end its session too. Options and behavior match `logoutWithWorkos()`.

### completeWorkosAuth()

`completeWorkosAuth(request: Request, options?: { provider?: string, user?: UserMapper }): Promise<{ data, error: null } | { data: null, error: { code, message, status, fields } }>`

Handles the WorkOS callback route. It checks the `code` and `state`, syncs the user, and starts the Holo session. On success `data` has `provider`, `guard`, `authProvider`, `status`, `user`, `identity`, `session`, and `authSession`. On failure `error.status` is `422`, or `409` for a conflict, and `error.code` says what went wrong, such as `workos_state_mismatch`.

### completeClerkAuth()

`completeClerkAuth(request: Request, options?: { provider?: string, user?: UserMapper }): Promise<{ data, error: null } | { data: null, error: { code, message, status, fields } }>`

The Clerk version of `completeWorkosAuth()`. Its success data has the same fields, and a conflict error has `status` `409` and code `clerk_identity_conflict`.

### Hosted conflict errors

`WorkosAuthConflictError` (code `workos_identity_conflict`) and `ClerkAuthConflictError` (code `clerk_identity_conflict`) are thrown by `syncIdentity()` when a hosted account's email matches a local user it can't be linked to. Each has `provider`, `workosUserId` or `clerkUserId`, and `email`. The `complete*Auth()` functions turn them into a `409` result.

### workosAuth and clerkAuth

`workosAuth` (from `@holo-js/auth-workos`) and `clerkAuth` (from `@holo-js/auth-clerk`) are objects that hold the functions above under one import: `authenticate`, `completeWorkosAuth` (or `completeClerkAuth`), `loginWith...`, `logoutWith...`, `registerWith...`, `syncIdentity`, `verifyRequest`, and `verifySession`.

## Next steps

- [Login and Registration](/auth/local-auth): register, log in, log out, and protect pages
- [Sessions and Cookies](/auth/session-and-cookies): cookie settings, remember me, and signing out other devices
- [Current User on the Client](/auth/current-user): show the user in your UI
- [Authorization](/authorization/): decide what a signed-in user may do
- [Tutorial: Authentication](/tutorial/auth): add auth to the blog app step by step
