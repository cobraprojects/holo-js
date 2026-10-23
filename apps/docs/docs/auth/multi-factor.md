# Multi-Factor Auth

Multi-factor auth (MFA) asks for a six-digit code from an authenticator app after the password. Holo supports time-based one-time passwords (TOTP) and single-use recovery codes, for users on session guards.

## Turn it on

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  multiFactor: {
    issuer: 'Acme',
  },
})
```

`multiFactor: true` turns it on with the defaults. MFA also needs:

- `APP_KEY` in `.env`. Holo encrypts each user's secret with it.
- A rate-limit store from `config/security.ts`. `npx holo install auth` sets one up; if you removed it, run `npx holo install security`.
- The `auth_multi_factor_credentials` table, which the auth migrations create.

Use the `redis` rate-limit driver when you run more than one server, so failed attempts are counted across all of them. See [Rate Limiting](/basics/security/rate-limiting).

Turning MFA on doesn't change anything for users who haven't enrolled. Each user opts in from your settings page.

## Let a user enroll

Enrollment has two steps: show the user a secret, then confirm it with a code from their app.

```ts [server/lib/mfa.ts]
import { multiFactor } from '@holo-js/auth'

export async function startEnrollment() {
  const enrollment = await multiFactor.beginEnrollment()

  return {
    qrCodeValue: enrollment.otpauthUri,
    manualKey: enrollment.manualKey,
    expiresAt: enrollment.expiresAt,
  }
}

export async function finishEnrollment(code: string) {
  const { recoveryCodes } = await multiFactor.confirmEnrollment({ code })

  return recoveryCodes
}
```

1. Call `beginEnrollment()` from a route on your settings page. Render `otpauthUri` as a QR code with any QR library, and show `manualKey` for users who type it in.
2. The user enters the code their app shows. Pass it to `confirmEnrollment()`.
3. Show the returned recovery codes once and ask the user to save them. Holo stores only hashes, so you can't show them again.

The user must have signed in within the last `enrollmentTtl` seconds (10 minutes by default). Otherwise `beginEnrollment()` throws `multi_factor_reauthentication_required`; ask them to sign in again. The enrollment itself also expires after `enrollmentTtl`.

## Handle the login challenge

Once a user is enrolled, `login()` doesn't sign them in right away. It returns a `multiFactorChallenge`, and the user stays signed out (`user()` returns `null`) until they enter a code. Redirect to the challenge page:

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

  const session = await login(input)

  if (session.multiFactorChallenge) {
    redirect(session.multiFactorChallenge.route)
  }

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

  const session = await login(input)

  return {
    ok: true,
    status: 200,
    data: { redirectTo: session.multiFactorChallenge?.route ?? '/dashboard' },
  }
})
```

```ts [SvelteKit]
// src/routes/login/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '#lib/schemas/auth.js'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, loginForm, { throttle: 'login' })

    const session = await login(input)

    redirect(303, session.multiFactorChallenge?.route ?? '/dashboard')
  },
} satisfies Actions
```

:::

The challenge has `route` (your `challengeRoute`), `expiresAt`, and `recoveryAllowed` (whether the user has recovery codes left). `loginUsing()` returns a challenge the same way, so [social login](/auth/social-login) callbacks should check for it too.

On the challenge page, submit the code to `multiFactor.challenge()`, or to `multiFactor.recover()` for a recovery code. MFA failures throw an `AuthError` rather than a validation error, so catch it and return a field error:

::: code-group

```ts [Next.js]
// app/mfa-challenge/actions.ts
'use server'

import { isAuthError, multiFactor } from '@holo-js/auth'
import { redirect } from 'next/navigation'

export async function challengeAction(formData: FormData) {
  const code = String(formData.get('code') ?? '')

  try {
    await multiFactor.challenge({ code })
  } catch (error) {
    if (isAuthError(error) && error.code === 'multi_factor_code_invalid') {
      return { ok: false, status: 422, errors: { code: ['That code is not valid.'] } }
    }
    if (isAuthError(error)) {
      redirect('/login')
    }
    throw error
  }

  redirect('/dashboard')
}
```

```ts [Nuxt]
// server/api/mfa-challenge.post.ts
import { isAuthError, multiFactor } from '@holo-js/auth'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ code?: string }>(event)

  try {
    await multiFactor.challenge({ code: body.code ?? '' })
  } catch (error) {
    if (isAuthError(error) && error.code === 'multi_factor_code_invalid') {
      setResponseStatus(event, 422)
      return { ok: false, status: 422, errors: { code: ['That code is not valid.'] } }
    }
    if (isAuthError(error)) {
      return { ok: true, status: 200, data: { redirectTo: '/login' } }
    }
    throw error
  }

  return { ok: true, status: 200, data: { redirectTo: '/dashboard' } }
})
```

```ts [SvelteKit]
// src/routes/mfa-challenge/+page.server.ts
import { fail, redirect } from '@sveltejs/kit'
import { isAuthError, multiFactor } from '@holo-js/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const code = String((await request.formData()).get('code') ?? '')

    try {
      await multiFactor.challenge({ code })
    } catch (error) {
      if (isAuthError(error) && error.code === 'multi_factor_code_invalid') {
        return fail(422, { errors: { code: ['That code is not valid.'] } })
      }
      if (isAuthError(error)) {
        redirect(303, '/login')
      }
      throw error
    }

    redirect(303, '/dashboard')
  },
} satisfies Actions
```

:::

Other challenge errors, such as `multi_factor_challenge_expired` or `multi_factor_challenge_missing`, mean the pending login is gone, so the examples send the user back to `/login`.

`challenge()` and `recover()` return the established session, just like `login()`. Each recovery code works once.

::: warning
After five wrong codes, Holo cancels the pending login, and further codes for that user are rejected until `challengeTtl` has passed. Keep the challenge page outside your `authOnly()` routes: during the challenge the user isn't signed in yet.
:::

## Manage MFA from settings

A signed-in user can check their status, get new recovery codes, or turn MFA off. The last two require a current code, either from the app (`'totp'`) or a recovery code (`'recovery'`):

```ts
import { multiFactor } from '@holo-js/auth'

const { enabled, recoveryCodesRemaining } = await multiFactor.status()

const { recoveryCodes } = await multiFactor.regenerateRecoveryCodes({ method: 'totp', code: '123456' })

await multiFactor.disable({ method: 'recovery', code: submittedRecoveryCode })
```

Regenerating replaces all old recovery codes. To use MFA on another guard, call the same methods on `auth.guard('admin').multiFactor`.

## Options

| Option | Default | Allowed | Description |
| --- | --- | --- | --- |
| `issuer` | `'Holo'` | up to 100 printable characters | App name shown in the authenticator app |
| `challengeRoute` | `'/mfa-challenge'` | a local path without `?` or `#` | Where `login()` sends enrolled users |
| `challengeTtl` | `300` | 30–1800 seconds | How long a pending login and the attempt limit last |
| `enrollmentTtl` | `600` | 60–3600 seconds | How recent the login must be to enroll, and how long an enrollment stays open |
| `recoveryCodes` | `8` | 1–20 | Recovery codes per user |
| `allowedDriftSteps` | `1` | 0–2 | Extra 30-second windows accepted on each side, for clock drift |

## Errors

MFA methods throw an `AuthError` with one of these codes:

| Code | Meaning |
| --- | --- |
| `multi_factor_code_invalid` | Wrong, reused, or rate-limited code |
| `multi_factor_challenge_missing` | No login is waiting for a code |
| `multi_factor_challenge_expired` | The pending login expired |
| `multi_factor_reauthentication_required` | The user must sign in again before enrolling |
| `multi_factor_enrollment_missing` / `multi_factor_enrollment_expired` | `confirmEnrollment()` without a current enrollment |
| `multi_factor_already_enabled` | The user is already enrolled |
| `multi_factor_not_enabled` | The user hasn't enrolled |
| `multi_factor_authentication_required` | No signed-in user for a settings method |
| `multi_factor_runtime_unconfigured` | The rate-limit store is missing |
| `multi_factor_encryption_key_missing` | `APP_KEY` is not set |

## Next steps

- [Login and Registration](/auth/local-auth)
- [Rate Limiting](/basics/security/rate-limiting)
- [Sessions and Cookies](/auth/session-and-cookies)
