---
name: holo-auth-security
description: Implement Holo-JS authentication, authorization, sessions, social providers, CSRF, rate limiting, hashing, encryption, and secure request boundaries.
metadata:
  type: focused
  source: https://docs.holo-js.com/auth/
---

# Authentication and security

Read the exact guide for the feature: [local auth](https://docs.holo-js.com/auth/local-auth), [guards and providers](https://docs.holo-js.com/auth/guards-and-providers), [sessions and cookies](https://docs.holo-js.com/auth/session-and-cookies), [password reset](https://docs.holo-js.com/auth/password-reset), [email verification](https://docs.holo-js.com/auth/email-verification), [MFA](https://docs.holo-js.com/auth/multi-factor-authentication), [personal access tokens](https://docs.holo-js.com/auth/personal-access-tokens), [social login](https://docs.holo-js.com/auth/social-login), [authorization](https://docs.holo-js.com/authorization/), and [security](https://docs.holo-js.com/security).

## Request order

1. Validate external input.
2. Resolve the Holo auth state from framework request context.
3. Authenticate when identity is required.
4. Authorize the concrete ability or policy action and resource.
5. Perform the side effect.
6. Rotate or invalidate credentials when the security state changes.

```ts
import { authorize } from '@holo-js/authorization'

await authorize('update', post)
await post.update(data)
```

## Boundaries

- Passwords use the configured Holo hasher; secrets use encryption; neither is logged.
- Browser mutations require CSRF protection where the adapter uses cookies.
- Login, password reset, verification, token, and OAuth endpoints need appropriate rate limits.
- Session cookie side effects belong in the auth/framework integration layer. Route code uses the framework's native redirect or navigation API.
- Policies decide resource access. UI visibility is not authorization.
- OAuth state, redirect allowlists, and provider callback failures must be validated explicitly.

## Completion check

- Anonymous, forbidden, and successful paths are distinct.
- Session fixation, credential rotation, replay, and enumeration risks were considered for the flow.
- Tests use the public auth and authorization surface and assert HTTP-visible behavior.
