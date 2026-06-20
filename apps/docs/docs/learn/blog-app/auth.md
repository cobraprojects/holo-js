# Auth

This chapter adds user registration, login, logout, session cookies, password reset, email verification, and optional social login routes.

## What you will build

- `/register`
- `/login`
- `/logout`
- `/forgot-password`
- `/reset-password`
- `/verify-email`
- protected admin access

## Files you will create

```txt
config/auth.ts
config/session.ts
app/login/page.tsx
app/login/actions.ts
app/register/page.tsx
app/register/actions.ts
app/logout/actions.ts
app/api/login/route.ts
app/api/register/route.ts
app/api/logout/route.ts
server/models/User.ts
```

The finished example uses:

- `apps/blog-next/config/auth.ts`
- `apps/blog-next/config/session.ts`
- `apps/blog-next/app/login/actions.ts`
- `apps/blog-next/app/register/actions.ts`
- `apps/blog-next/server/models/User.ts`

## Protect admin actions

Use the framework adapter to read auth state inside server actions.

```ts
import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'

const currentAuth = await auth()
if (!currentAuth.authenticated || !currentAuth.user) {
  redirect('/login')
}
```

## Use native redirects

For app routes and server actions, use the host framework's redirect API. Holo handles session side effects in the auth integration layer.

## Checkpoint

Guests can browse public posts, but admin writes require an authenticated user.

## Related reference

- [Auth Overview](/auth/)
- [Session And Cookies](/auth/session-and-cookies)
- [Local Auth](/auth/local-auth)
- [Social Login](/auth/social-login)
- [Email Verification](/auth/email-verification)
- [Password Reset](/auth/password-reset)
