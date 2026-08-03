# Multi-Factor Authentication

`@holo-js/auth` supports time-based one-time passwords (TOTP) and single-use recovery codes for session guards.

## Configuration

Enable MFA in `config/auth.ts`:

```ts
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  multiFactor: {
    issuer: 'My App',
    challengeRoute: '/mfa-challenge',
    challengeTtl: 300,
    enrollmentTtl: 600,
    recoveryCodes: 8,
    allowedDriftSteps: 1,
  },
})
```

MFA requires Auth's Security configuration. If you installed Auth with `holo install auth`, it is already available
and you do not need another installation command. Otherwise, run `npx holo install security` before enabling MFA.

```ts
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

Use `file` for a persistent single-host deployment, `memory` for a single process, or `redis` when multiple
application instances must share attempt limits.

## Enrollment

Enrollment requires a session authenticated within the configured `enrollmentTtl`. If that window has expired,
ask the user to sign in again before beginning enrollment. Display the returned URI as a QR code or let the user
enter `manualKey` in their authenticator application, then confirm with a current code:

```ts
import { multiFactor } from '@holo-js/auth'

const enrollment = await multiFactor.beginEnrollment()

const result = await multiFactor.confirmEnrollment({
  code: submittedCode,
})

const recoveryCodes = result.recoveryCodes
```

Show recovery codes once and ask the user to store them securely. They cannot be retrieved later.

## Login Challenge

When an enrolled user submits valid primary credentials, `login()` returns a pending session with a
`multiFactorChallenge` instead of authenticating the user:

```ts
import { login } from '@holo-js/auth'

const session = await login({
  email,
  password,
})

const challengeRoute = session.multiFactorChallenge?.route
```

When `challengeRoute` is present, redirect to it with your framework's native redirect API.

Complete the pending challenge with a TOTP code or a recovery code:

```ts
const session = await multiFactor.challenge({ code: submittedCode })
const recoveredSession = await multiFactor.recover({ code: submittedRecoveryCode })
```

After five failed submissions, the user must wait for the configured challenge TTL before trying again.

## Account Management

Authenticated users can inspect or change their MFA state:

```ts
const status = await multiFactor.status()
const replacementCodes = await multiFactor.regenerateRecoveryCodes({
  method: 'totp',
  code: submittedCode,
})
await multiFactor.disable({
  method: 'recovery',
  code: submittedRecoveryCode,
})
```

Both disabling MFA and regenerating recovery codes require a valid TOTP or recovery code.
